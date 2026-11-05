import pg from "pg";

/** The store's document in Postgres, for a deployment where local files do not last. Locally the store uses a file. */

export interface StoreBackend<Data> {
  read(): Promise<Data>;
  /** Runs one read-modify-write at a time, across every process that shares the database. */
  update<T>(change: (data: Data) => T): Promise<T>;
  close(): Promise<void>;
}

/** One row holds the whole document, and locking that row serializes the writers. */
export function postgresBackend<Data>(connectionString: string, empty: () => Data): StoreBackend<Data> {
  const pool = new pg.Pool({ connectionString, max: 3 });
  let ready: Promise<void> | undefined;

  function setUp(): Promise<void> {
    ready ??= pool
      .query(`CREATE TABLE IF NOT EXISTS agent_store (id smallint PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)`)
      .then(() => undefined)
      .catch((error: { code?: string }) => {
        // Two instances starting at once can both try to create it; one of them gets one of these.
        if (error.code !== "23505" && error.code !== "42P07") {
          ready = undefined;
          throw error;
        }
      });
    return ready;
  }

  return {
    async read() {
      await setUp();
      const { rows } = await pool.query<{ data: Data }>("SELECT data FROM agent_store WHERE id = 1");
      return rows[0]?.data ?? empty();
    },

    async update(change) {
      await setUp();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO agent_store (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [
          JSON.stringify(empty()),
        ]);
        const { rows } = await client.query<{ data: Data }>("SELECT data FROM agent_store WHERE id = 1 FOR UPDATE");
        const data = rows[0]!.data;
        const result = change(data);
        await client.query("UPDATE agent_store SET data = $1 WHERE id = 1", [JSON.stringify(data)]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}
