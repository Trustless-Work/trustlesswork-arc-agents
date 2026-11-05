import { afterAll, describe, expect, it } from "vitest";

import { postgresBackend } from "../agent/lib/store-postgres";

interface Doc {
  items: number[];
}

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgres store", () => {
  const backend = postgresBackend<Doc>(url!, () => ({ items: [] }));
  afterAll(() => backend.close());

  it("starts empty, keeps what is written, and creates its table when needed", async () => {
    await expect(backend.read()).resolves.toEqual({ items: [] });
    await expect(backend.update((doc) => doc.items.push(1))).resolves.toBe(1);
    await expect(backend.read()).resolves.toEqual({ items: [1] });
  });

  it("discards a change that throws", async () => {
    await expect(
      backend.update((doc) => {
        doc.items.push(99);
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect((await backend.read()).items).not.toContain(99);
  });

  it("loses no write when many arrive at once", async () => {
    const before = (await backend.read()).items.length;
    await Promise.all(Array.from({ length: 40 }, (_, i) => backend.update((doc) => doc.items.push(1000 + i))));
    expect((await backend.read()).items.length).toBe(before + 40);
  });
});
