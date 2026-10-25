import { shortAddress } from "./network";
import { store, type ActivityStep } from "./store";

/**
 * What an agent is doing on an escrow, from its session's events: the channel records each step so anyone can see
 * that an agent is working, and on what, while it works.
 */

const MAX_STEPS = 30;

function milestones(input: Record<string, unknown>): string {
  const indexes = Array.isArray(input.milestoneIndexes) ? input.milestoneIndexes : [];
  if (indexes.length === 0) return "";
  return indexes.length === 1 ? ` milestone ${indexes[0]}` : ` milestones ${indexes.join(", ")}`;
}

function host(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return "a link";
  }
}

/** A tool call in words, as a person would say it. */
export function describeCall(toolName: string, input: Record<string, unknown> = {}): string {
  const distributions = Array.isArray(input.distributions) ? (input.distributions as { address?: string; amount?: number }[]) : [];
  const split = distributions.map((d) => `${d.amount} USDC to ${shortAddress(String(d.address ?? ""))}`).join(", ");
  switch (toolName) {
    case "get_escrow":
      return "Reading the escrow";
    case "fetch_evidence":
      return `Opening the evidence on ${host(input.url)}`;
    case "approve_milestones":
      return `Approving${milestones(input)}`;
    case "approve_and_release":
      return `Approving and releasing${milestones(input)}`;
    case "release_funds":
      return `Releasing the payment${milestones(input)}`;
    case "deliver_milestone":
      return `Delivering${milestones(input)}`;
    case "open_dispute":
      return `Opening a dispute${milestones(input)}`;
    case "resolve_dispute":
      return split ? `Resolving the dispute: ${split}` : "Resolving the dispute";
    case "return_leftover_funds":
      return split ? `Returning leftover funds: ${split}` : "Returning leftover funds";
    case "record_note":
      return "Recording its decision";
    case "eve__skill":
      return "Reading the escrow guide";
    default:
      return `Using ${toolName}`;
  }
}

/** The agent and escrow a session belongs to, from its channel address (`<agentId>:<escrow>`). */
export function parseAddress(token: string | undefined): { agentId: string; escrow: string } | undefined {
  const [agentId, escrow] = (token ?? "").split(":");
  return agentId && escrow ? { agentId, escrow } : undefined;
}

export function turnStarted(agentId: string, escrow: string, sessionId: string): Promise<void> {
  const at = new Date().toISOString();
  return store.patchWatch(agentId, escrow, { working: { since: at, sessionId }, activity: [] });
}

/** Records the tool calls of a step. Each eve action carries `callId`, `toolName` and `input`. */
export function stepsRequested(agentId: string, escrow: string, actions: readonly unknown[]): Promise<void> {
  const at = new Date().toISOString();
  return store.changeWatch(agentId, escrow, (watch) => {
    const steps = [...(watch.activity ?? [])];
    for (const action of actions) {
      const call = action as { callId?: unknown; toolName?: unknown; input?: unknown };
      if (typeof call.callId !== "string" || typeof call.toolName !== "string") continue;
      if (steps.some((step) => step.id === call.callId)) continue;
      const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
      steps.push({ id: call.callId, at, text: describeCall(call.toolName, input), status: "running" });
    }
    return { activity: steps.slice(-MAX_STEPS) };
  });
}

export function stepFinished(agentId: string, escrow: string, callId: string, ok: boolean): Promise<void> {
  return store.changeWatch(agentId, escrow, (watch) => ({
    activity: (watch.activity ?? []).map((step): ActivityStep =>
      step.id === callId ? { ...step, status: ok ? "done" : "failed" } : step,
    ),
  }));
}

export function turnEnded(agentId: string, escrow: string, summary?: string): Promise<void> {
  const at = new Date().toISOString();
  return store.changeWatch(agentId, escrow, (watch) => ({
    working: undefined,
    lastTurnAt: at,
    // Steps still running when the turn ended did not finish.
    activity: (watch.activity ?? []).map((step): ActivityStep => (step.status === "running" ? { ...step, status: "failed" } : step)),
    ...(summary ? { lastSummary: summary.slice(0, 2_000) } : {}),
  }));
}
