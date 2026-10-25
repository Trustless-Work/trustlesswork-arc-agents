import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "./config";
import type { EscrowKind } from "./network";
import type { AgentRole, EscrowAction } from "./roles";

/**
 * The agent registry, the escrows each agent watches and its decision log, kept in one JSON file. It is enough for
 * local tests on a single process; a deployment needs a database behind the same functions.
 */

export interface AgentRecord {
  id: string;
  name: string;
  roles: AgentRole[];
  instructions: string;
  onlyEscrowsFrom: string[];
  wallet: { source: "created" | "assigned"; walletId: string; address: `0x${string}`; accountType: string };
  createdAt: string;
  /** SHA-256 of the current configuration (roles, wallet, name, instructions, scope). */
  configHash: string;
  /** Current configuration version, 1 at creation. Absent on agents created before versions existed. */
  version?: number;
  /** Every configuration the agent has had, oldest first. */
  versions?: AgentVersion[];
  updatedAt?: string;
  /** Set when the agent was deleted. It no longer acts; its record stays for the history. */
  deletedAt?: string;
}

/** The editable configuration at one version. Roles and wallet never change. */
export interface AgentVersion {
  version: number;
  at: string;
  name: string;
  instructions: string;
  onlyEscrowsFrom: string[];
  configHash: string;
  /** Fields that changed from the previous version. */
  changed: ("name" | "instructions" | "onlyEscrowsFrom")[];
}

export interface Watch {
  agentId: string;
  escrow: `0x${string}`;
  kind: EscrowKind;
  deployer?: string;
  /** The agent's configuration version when it picked this escrow up. Its sessions here use that version. */
  configVersion?: number;
  /** Block where the factory created it, when the dispatcher found it. */
  createdBlock?: string;
  since: string;
  status: "open" | "closed";
  lastSnapshot?: string;
  /** How many times the agent was woken for `lastSnapshot`. */
  wakesForSnapshot?: number;
  lastDispatchedAt?: string;
  dispatches: number;
  sessionId?: string;
  /** Set while the agent's turn on this escrow runs. */
  working?: { since: string; sessionId: string };
  /** The steps of the agent's current or last turn on this escrow. */
  activity?: ActivityStep[];
  /** The agent's own summary at the end of its last turn. */
  lastSummary?: string;
  /** Who the escrow waits on while the agent has nothing to do in it, as of the last check. */
  waiting?: string;
  /** The escrow's state at the last check, and when it last changed. */
  seenSnapshot?: string;
  changedAt?: string;
  /** When the dispatcher reads it next, and how often it does while the escrow stays quiet. */
  nextCheckAt?: string;
  checkEveryMinutes?: number;
  lastTurnAt?: string;
}

export interface ActivityStep {
  id: string;
  at: string;
  text: string;
  status: "running" | "done" | "failed";
}

export interface Decision {
  agentId: string;
  escrow: string;
  at: string;
  action: EscrowAction | "note";
  milestoneIndexes?: number[];
  reason: string;
  /** What a service provider delivered. */
  evidence?: string;
  /** Who a dispute resolver paid, and how much. */
  distributions?: { address: string; amount: number }[];
  outcome: "sent" | "failed" | "noted";
  txHash?: string;
  error?: string;
}

interface Data {
  version: 1;
  agents: Record<string, AgentRecord>;
  watches: Record<string, Watch>;
  decisions: Decision[];
  /** Next block the dispatcher scans for new escrows. */
  cursor?: string;
  walletSetId?: string;
}

const MAX_DECISIONS = 5_000;

function file(): string {
  return join(dataDir(), "agents.json");
}

async function load(): Promise<Data> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as Data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, agents: {}, watches: {}, decisions: [] };
    }
    throw error;
  }
}

async function save(data: Data): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file());
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one read-modify-write at a time. */
function update<T>(change: (data: Data) => T): Promise<T> {
  const run = queue.then(async () => {
    const data = await load();
    const result = change(data);
    await save(data);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function watchKey(agentId: string, escrow: string): string {
  return `${agentId}:${escrow.toLowerCase()}`;
}

export const store = {
  async getAgent(id: string): Promise<AgentRecord | undefined> {
    return (await load()).agents[id];
  },

  /** Agents that are not deleted, unless asked for every one. */
  async listAgents(options: { includeDeleted?: boolean } = {}): Promise<AgentRecord[]> {
    return Object.values((await load()).agents).filter((agent) => options.includeDeleted || !agent.deletedAt);
  },

  /** Changes an agent in one read-modify-write and returns it. */
  updateAgent(id: string, change: (agent: AgentRecord) => AgentRecord): Promise<AgentRecord> {
    return update((data) => {
      const current = data.agents[id];
      if (!current) throw new Error(`Agent ${id} does not exist.`);
      data.agents[id] = change(current);
      return data.agents[id];
    });
  },

  addAgent(agent: AgentRecord): Promise<void> {
    return update((data) => {
      if (data.agents[agent.id]) throw new Error(`Agent ${agent.id} already exists.`);
      data.agents[agent.id] = agent;
    });
  },

  async getWatch(agentId: string, escrow: string): Promise<Watch | undefined> {
    return (await load()).watches[watchKey(agentId, escrow)];
  },

  async listWatches(filter: { agentId?: string; status?: Watch["status"] } = {}): Promise<Watch[]> {
    return Object.values((await load()).watches).filter(
      (w) => (!filter.agentId || w.agentId === filter.agentId) && (!filter.status || w.status === filter.status),
    );
  },

  /** Starts watching an escrow for an agent. Returns false if it already did. */
  addWatch(watch: Omit<Watch, "status" | "dispatches" | "since">): Promise<boolean> {
    return update((data) => {
      const key = watchKey(watch.agentId, watch.escrow);
      if (data.watches[key]) return false;
      data.watches[key] = { ...watch, status: "open", dispatches: 0, since: new Date().toISOString() };
      return true;
    });
  },

  patchWatch(agentId: string, escrow: string, patch: Partial<Watch>): Promise<void> {
    return update((data) => {
      const key = watchKey(agentId, escrow);
      const current = data.watches[key];
      if (current) data.watches[key] = { ...current, ...patch };
    });
  },

  /** Changes a watch from its current value, in one read-modify-write. */
  changeWatch(agentId: string, escrow: string, change: (watch: Watch) => Partial<Watch>): Promise<void> {
    return update((data) => {
      const key = watchKey(agentId, escrow);
      const current = data.watches[key];
      if (current) data.watches[key] = { ...current, ...change(current) };
    });
  },

  addDecision(decision: Decision): Promise<void> {
    return update((data) => {
      data.decisions.push(decision);
      if (data.decisions.length > MAX_DECISIONS) data.decisions.splice(0, data.decisions.length - MAX_DECISIONS);
    });
  },

  async listDecisions(agentId: string): Promise<Decision[]> {
    return (await load()).decisions.filter((d) => d.agentId === agentId);
  },

  async getCursor(): Promise<bigint | undefined> {
    const cursor = (await load()).cursor;
    return cursor === undefined ? undefined : BigInt(cursor);
  },

  setCursor(block: bigint): Promise<void> {
    return update((data) => {
      data.cursor = block.toString();
    });
  },

  async getWalletSetId(): Promise<string | undefined> {
    return (await load()).walletSetId;
  },

  setWalletSetId(id: string): Promise<void> {
    return update((data) => {
      data.walletSetId = id;
    });
  },
};
