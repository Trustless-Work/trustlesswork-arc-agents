import { escrowsCreated, isOfficialEscrow, latestBlock, type CreatedEscrow } from "./chain";
import { escrowRolesOf, isClosed, pendingTasks, snapshotOf, waitingFor, type EscrowView, type Task, type TaskType } from "./escrow";
import { agentPrincipal, currentVersion } from "./agents";
import { sameAddress } from "./network";
import { ROLE_LABELS } from "./roles";
import { store, type AgentRecord, type Watch } from "./store";
import { getEscrow } from "./tw-api";

/** How far back the first scan looks for new escrows (about 16 minutes of Arc blocks). */
const FIRST_SCAN_BLOCKS = 2_000n;
/** One eth_getLogs call covers at most this many blocks. */
const SCAN_CHUNK = 9_999n;
const MAX_CHUNKS_PER_RUN = 10;
/** An agent that was woken and left the escrow unchanged is woken again after this long... */
const RETRY_AFTER_MS = 15 * 60_000;
/** ...but at most this many times for the same escrow state, so a decision not to act stops costing model calls. */
const MAX_WAKES_PER_STATE = 2;
const HOUR_MS = 60 * 60_000;

/** How often an escrow is read, in minutes, given how long it has gone without changing. */
export function checkEveryMinutes(quietForMs: number): number {
  if (quietForMs < HOUR_MS) return 1;
  if (quietForMs < 24 * HOUR_MS) return 10;
  return 60;
}

/**
 * When to read an escrow next. An escrow that changes is read every minute; one that has been quiet for an hour, every
 * 10 minutes; for a day, every hour. Any change brings it back to every minute.
 */
export function scheduleNextCheck(
  watch: Pick<Watch, "seenSnapshot" | "changedAt" | "since">,
  snapshot: string,
  now: number,
): Pick<Watch, "seenSnapshot" | "changedAt" | "nextCheckAt" | "checkEveryMinutes"> {
  const changedAt = snapshot !== watch.seenSnapshot ? new Date(now).toISOString() : (watch.changedAt ?? watch.since);
  const every = checkEveryMinutes(now - Date.parse(changedAt));
  // A little early, so a once-a-minute tick that lands a few seconds late still picks it up.
  const nextCheckAt = new Date(now + every * 60_000 - 20_000).toISOString();
  return { seenSnapshot: snapshot, changedAt, nextCheckAt, checkEveryMinutes: every };
}

export interface WorkTarget {
  agentId: string;
  escrow: string;
  /** Idempotency key for this delivery. */
  key: string;
}

export type Deliver = (target: WorkTarget, message: string, auth: ReturnType<typeof agentPrincipal>) => Promise<{ id: string }>;

/** The channel address of an agent's conversation about one escrow: one durable session per agent and escrow. */
export function sessionAddress(target: Pick<WorkTarget, "agentId" | "escrow">): string {
  return `${target.agentId}:${target.escrow.toLowerCase()}`;
}

function inScope(agent: AgentRecord, deployer: string | undefined): boolean {
  return agent.onlyEscrowsFrom.length === 0 || agent.onlyEscrowsFrom.some((a) => sameAddress(a, deployer));
}

/** Starts watching `escrow` for every agent whose wallet it names in a role the agent has. */
async function watchIfNamed(agents: AgentRecord[], escrow: EscrowView, created: CreatedEscrow): Promise<void> {
  for (const agent of agents) {
    if (!inScope(agent, created.deployer)) continue;
    if (escrowRolesOf(escrow, agent.wallet.address, agent.roles).length === 0) continue;
    await store.addWatch({
      agentId: agent.id,
      escrow: escrow.contractId as `0x${string}`,
      kind: created.kind,
      deployer: created.deployer,
      createdBlock: created.blockNumber.toString(),
      configVersion: currentVersion(agent),
    });
  }
}

/** Scans the factories for escrows created since the last run. */
export async function discoverEscrows(agents: AgentRecord[]): Promise<number> {
  if (agents.length === 0) return 0;
  const latest = await latestBlock();
  let from = (await store.getCursor()) ?? (latest > FIRST_SCAN_BLOCKS ? latest - FIRST_SCAN_BLOCKS : 0n);
  let found = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN && from <= latest; chunk++) {
    const to = from + SCAN_CHUNK - 1n < latest ? from + SCAN_CHUNK - 1n : latest;
    for (const created of await escrowsCreated(from, to)) {
      try {
        const escrow = await getEscrow(created.escrow, created.kind);
        await watchIfNamed(agents, escrow, created);
        found++;
      } catch (error) {
        console.warn(`dispatch: could not read new escrow ${created.escrow}: ${(error as Error).message}`);
      }
    }
    from = to + 1n;
    await store.setCursor(from);
  }
  return found;
}

/** Starts watching one escrow for one agent, if the escrow is official and names the agent. */
export async function attachEscrow(agent: AgentRecord, address: `0x${string}`): Promise<{ attached: boolean; reason?: string }> {
  const escrow = await getEscrow(address);
  if (!(await isOfficialEscrow(address, escrow.type))) {
    return { attached: false, reason: "It is not an official Trustless Work escrow." };
  }
  if (escrowRolesOf(escrow, agent.wallet.address, agent.roles).length === 0) {
    return { attached: false, reason: "The escrow does not name this agent's wallet in any of its roles." };
  }
  if (agent.onlyEscrowsFrom.length > 0) {
    return { attached: false, reason: "This agent only takes escrows it finds from its allowed deployers." };
  }
  const added = await store.addWatch({ agentId: agent.id, escrow: address, kind: escrow.type, configVersion: currentVersion(agent) });
  return added ? { attached: true } : { attached: false, reason: "The agent already watches it." };
}

const TASK_TEXT: Record<TaskType, (m: string) => string> = {
  review: (m) => `Delivered and waiting for your approval: ${m}.`,
  release: (m) => (m ? `Approved and waiting to be released: ${m}.` : "Every milestone is approved and waiting to be released."),
  deliver: (m) => `Funded and waiting for your delivery: ${m}.`,
  "answer-dispute": (m) =>
    m ? `Your work on ${m} is in dispute. You may deliver a corrected version.` : "Your work is in dispute. You may deliver a corrected version.",
  resolve: (m) => (m ? `In dispute, waiting for your decision: ${m}.` : "In dispute, waiting for your decision."),
  leftover: () => "Finished, but USDC is left in it. Return it to whoever it belongs to.",
};

function milestonesText(indexes: number[]): string {
  if (indexes.length === 0) return "";
  return indexes.length === 1 ? `milestone ${indexes[0]}` : `milestones ${indexes.join(", ")}`;
}

export function workMessage(agent: AgentRecord, escrow: EscrowView, tasks: Task[], wake = 1): string {
  const roles = escrowRolesOf(escrow, agent.wallet.address, agent.roles).map((r) => ROLE_LABELS[r]).join(" and ");
  return [
    `Escrow ${escrow.contractId} (${escrow.type}) needs you. You are its ${roles}.`,
    ...tasks.map((task) => `- ${TASK_TEXT[task.type](milestonesText(task.milestoneIndexes))}`),
    wake > 1
      ? `It has not changed since you were last woken for it (this is wake ${wake}). Decide now: you will not be woken again until it changes.`
      : "Read it with get_escrow, decide from what it shows now, and act or record why you do not.",
  ].join("\n");
}

export interface DispatchReport {
  discovered: number;
  /** Quiet escrows not read on this run. */
  skipped: number;
  woken: { agentId: string; escrow: string; sessionId: string }[];
  closed: string[];
  errors: string[];
}

function due(watch: Watch, snapshot: string, now: number): boolean {
  if (watch.lastSnapshot !== snapshot) return true;
  if ((watch.wakesForSnapshot ?? 1) >= MAX_WAKES_PER_STATE) return false;
  return !watch.lastDispatchedAt || now - Date.parse(watch.lastDispatchedAt) >= RETRY_AFTER_MS;
}

/**
 * One dispatcher run: finds new escrows, then wakes each agent that has something to do in an escrow it watches.
 * An agent is woken once per escrow state, so an unchanged escrow does not cost model calls on every tick, and quiet
 * escrows are read less often (`scheduleNextCheck`). `force` reads every escrow now.
 */
export async function dispatchWork(
  deliver: Deliver,
  options: { agentId?: string; force?: boolean } = {},
): Promise<DispatchReport> {
  const report: DispatchReport = { discovered: 0, skipped: 0, woken: [], closed: [], errors: [] };
  const agents = await store.listAgents();
  try {
    report.discovered = await discoverEscrows(agents);
  } catch (error) {
    report.errors.push(`discovery: ${(error as Error).message}`);
  }

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const now = Date.now();
  for (const watch of await store.listWatches({ status: "open", agentId: options.agentId })) {
    const agent = byId.get(watch.agentId);
    if (!agent) continue;
    if (!options.force && watch.nextCheckAt && Date.parse(watch.nextCheckAt) > now) {
      report.skipped++;
      continue;
    }
    try {
      const escrow = await getEscrow(watch.escrow, watch.kind);
      const tasks = pendingTasks(escrow, agent.wallet.address, agent.roles);
      // A finished escrow stays watched only while a dispute resolver still has funds to return.
      if (isClosed(escrow) && tasks.length === 0) {
        await store.patchWatch(agent.id, watch.escrow, { status: "closed" });
        report.closed.push(watch.escrow);
        continue;
      }
      const snapshot = snapshotOf(escrow);
      const waiting = tasks.length === 0 ? waitingFor(escrow, agent.wallet.address) : undefined;
      await store.patchWatch(agent.id, watch.escrow, { waiting, ...scheduleNextCheck(watch, snapshot, now) });
      if (tasks.length === 0 || !due(watch, snapshot, now)) continue;

      const wake = watch.lastSnapshot === snapshot ? (watch.wakesForSnapshot ?? 1) + 1 : 1;
      const target = { agentId: agent.id, escrow: watch.escrow, key: `${sessionAddress(watch)}:${snapshot}:${watch.dispatches}` };
      const session = await deliver(target, workMessage(agent, escrow, tasks, wake), agentPrincipal(agent, watch.escrow));
      await store.patchWatch(agent.id, watch.escrow, {
        lastSnapshot: snapshot,
        wakesForSnapshot: wake,
        lastDispatchedAt: new Date(now).toISOString(),
        dispatches: watch.dispatches + 1,
        sessionId: session.id,
      });
      report.woken.push({ agentId: agent.id, escrow: watch.escrow, sessionId: session.id });
    } catch (error) {
      report.errors.push(`${watch.agentId} ${watch.escrow}: ${(error as Error).message}`);
    }
  }
  return report;
}
