import { decodeFunctionData, getAddress, isAddress, parseUnits } from "viem";

import { escrowHistory, isOfficialEscrow } from "./chain";
import { sendContractCall } from "./circle";
import { escrowRolesOf, receiversOf, type EscrowView } from "./escrow";
import { ESCROW_ABI, explorerTx, sameAddress, type EscrowKind } from "./network";
import { ROLE_LABELS, rolesAllow, slotsAllow, type EscrowAction } from "./roles";
import { store, type AgentRecord } from "./store";
import { buildEscrowCall, getEscrow, TwApiError, type BuiltTransaction } from "./tw-api";

const USDC_DECIMALS = 6;

export interface Distribution {
  address: string;
  /** USDC, as a decimal number (1.5 = 1.5 USDC). */
  amount: number;
}

export interface ActionRequest {
  escrow: string;
  action: EscrowAction;
  milestoneIndexes: number[];
  reason: string;
  /** deliver: what goes into each milestone's evidence. */
  evidence?: string;
  /** resolve-dispute and withdraw-remaining-funds: who gets what. */
  distributions?: Distribution[];
}

export type ActionResult =
  | { ok: true; action: EscrowAction; txHash: string; explorer: string; escrowAfter: EscrowSummary }
  | { ok: false; code: string; detail: string };

/** Refused before anything was sent. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

const baseUnits = (amount: number) => parseUnits(String(amount), USDC_DECIMALS);

/** Where the API builds each action, and the body it takes. The wallet always comes from the agent, never the model. */
function routeAndBody(kind: EscrowKind, request: ActionRequest, wallet: string) {
  const contractId = request.escrow;
  const milestoneIndexes = request.milestoneIndexes;
  const single = kind === "single-release";
  switch (request.action) {
    case "approve-milestones":
      return { route: "approve-milestones", body: { contractId, approver: wallet, milestoneIndexes } };
    case "approve-and-release-milestones":
      return { route: "approve-and-release-milestones", body: { contractId, signer: wallet, milestoneIndexes } };
    case "release-funds":
      return single
        ? { route: "release-funds", body: { contractId, releaseSigner: wallet } }
        : { route: "release-funds", body: { contractId, releaseSigner: wallet, milestoneIndexes } };
    case "deliver":
      return {
        route: "change-milestone-status",
        body: {
          contractId,
          serviceProvider: wallet,
          updates: milestoneIndexes.map((index) => ({ index, newStatus: "completed", newEvidence: request.evidence })),
        },
      };
    case "dispute":
      return single
        ? { route: "dispute-escrow", body: { contractId, signer: wallet, reason: request.reason } }
        : { route: "dispute-milestones", body: { contractId, signer: wallet, milestoneIndexes, reason: request.reason } };
    case "resolve-dispute":
      return single
        ? { route: "resolve-dispute", body: { contractId, disputeResolver: wallet, distributions: request.distributions } }
        : {
            route: "resolve-dispute",
            body: { contractId, disputeResolver: wallet, milestoneIndexes, distributions: request.distributions },
          };
    case "withdraw-remaining-funds":
      return {
        route: "withdraw-remaining-funds",
        body: { contractId, disputeResolver: wallet, distributions: request.distributions },
      };
  }
}

/** The function and arguments the built call must contain. Amounts in base units, addresses in lowercase. */
function expectedCall(kind: EscrowKind, request: ActionRequest): { name: string; args: unknown[] } {
  const indexes = request.milestoneIndexes;
  const single = kind === "single-release";
  const recipients = (request.distributions ?? []).map((d) => d.address.toLowerCase());
  const amounts = (request.distributions ?? []).map((d) => baseUnits(d.amount).toString());
  switch (request.action) {
    case "approve-milestones":
      return { name: "approveMilestones", args: [indexes] };
    case "approve-and-release-milestones":
      return { name: "approveAndReleaseMilestones", args: [indexes] };
    case "release-funds":
      return single ? { name: "releaseFunds", args: [] } : { name: "releaseFunds", args: [indexes] };
    case "deliver":
      return {
        name: "changeMilestoneStatus",
        args: [
          indexes.map((index) => ({
            milestoneIndex: index,
            newStatus: "completed",
            setEvidence: true,
            newEvidence: request.evidence ?? "",
          })),
        ],
      };
    case "dispute":
      return single
        ? { name: "disputeEscrow", args: [request.reason] }
        : { name: "disputeMilestones", args: [indexes, request.reason] };
    case "resolve-dispute":
      return single
        ? { name: "resolveDispute", args: [recipients, amounts] }
        : { name: "resolveDispute", args: [indexes, recipients, amounts] };
    case "withdraw-remaining-funds":
      return { name: "withdrawRemainingFunds", args: [recipients, amounts] };
  }
}

/** Decoded arguments in a comparable form: bigints as strings, addresses in lowercase. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return isAddress(value, { strict: false }) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

/**
 * Checks a build against the chain and the request, so that a wrong or compromised API cannot make the agent sign
 * anything else: the call goes to the escrow itself, the escrow is an official Trustless Work escrow, and the data is
 * exactly the function and arguments that were asked for.
 */
export async function checkBuild(
  built: BuiltTransaction,
  escrow: `0x${string}`,
  kind: EscrowKind,
  request: ActionRequest,
  isOfficial: (address: `0x${string}`, kind: EscrowKind) => Promise<boolean> = isOfficialEscrow,
): Promise<void> {
  if (!sameAddress(built.to, escrow)) {
    throw new Refusal("BUILD_TARGET_MISMATCH", `The build calls ${built.to}, not the escrow ${escrow}.`);
  }
  if (!(await isOfficial(escrow, kind))) {
    throw new Refusal("ESCROW_NOT_OFFICIAL", `${escrow} is not an official Trustless Work ${kind} escrow.`);
  }
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: ESCROW_ABI, data: built.data });
  } catch {
    throw new Refusal("BUILD_UNKNOWN_FUNCTION", `The build calls a function the agent does not sign (${built.data.slice(0, 10)}).`);
  }
  const expected = expectedCall(kind, request);
  const args = normalize(decoded.args ?? []);
  if (decoded.functionName !== expected.name || JSON.stringify(args) !== JSON.stringify(normalize(expected.args))) {
    throw new Refusal(
      "BUILD_CALL_MISMATCH",
      `The build calls ${decoded.functionName}(${JSON.stringify(args)}), not ${expected.name}(${JSON.stringify(expected.args)}).`,
    );
  }
}

function requireRoles(agent: AgentRecord, escrow: EscrowView, action: EscrowAction): void {
  if (!rolesAllow(agent.roles, action)) {
    throw new Refusal("AGENT_ROLE_NOT_ALLOWED", `This agent was not created with the roles for ${action}.`);
  }
  const held = escrowRolesOf(escrow, agent.wallet.address, agent.roles);
  if (!slotsAllow(held, action)) {
    const names = held.map((slot) => ROLE_LABELS[slot]).join(" and ") || "no role";
    throw new Refusal("ESCROW_ROLE_MISSING", `Your wallet holds ${names} in this escrow, which is not enough for ${action}.`);
  }
}

/**
 * Who may receive money from a resolution: the side that did the work (service providers and receivers) and the side
 * that paid for it (funders and whoever created the escrow). Never a dispute resolver, so it cannot pay itself.
 */
export function allowedRecipients(escrow: EscrowView, funders: readonly string[], deployer?: string): string[] {
  const r = escrow.roles;
  const candidates = [...r.serviceProviders, ...receiversOf(escrow), ...funders, ...(deployer ? [deployer] : [])];
  const resolvers = r.disputeResolvers;
  return [...new Set(candidates.map((a) => a.toLowerCase()))].filter((a) => !resolvers.some((x) => sameAddress(x, a)));
}

/** The amount a distribution must add up to, in base units. */
function requiredTotal(escrow: EscrowView, request: ActionRequest): bigint {
  if (request.action === "resolve-dispute" && escrow.type === "multi-release") {
    return request.milestoneIndexes.reduce((sum, i) => sum + baseUnits(escrow.milestones[i]?.amount ?? 0), 0n);
  }
  return baseUnits(escrow.balance);
}

/** Checks who gets paid and how much, before the API is even asked. */
export function checkDistributions(escrow: EscrowView, request: ActionRequest, recipients: readonly string[]): void {
  const distributions = request.distributions ?? [];
  if (distributions.length === 0) throw new Refusal("DISTRIBUTIONS_EMPTY", "Name at least one recipient.");
  for (const d of distributions) {
    if (!isAddress(d.address)) throw new Refusal("DISTRIBUTION_BAD_ADDRESS", `${d.address} is not an address.`);
    if (!recipients.some((a) => sameAddress(a, d.address))) {
      throw new Refusal(
        "DISTRIBUTION_RECIPIENT_NOT_ALLOWED",
        `${d.address} neither did the work nor funded this escrow, so it cannot be paid from it.`,
      );
    }
  }
  const total = distributions.reduce((sum, d) => sum + baseUnits(d.amount), 0n);
  const required = requiredTotal(escrow, request);
  if (total !== required) {
    throw new Refusal(
      "DISTRIBUTIONS_TOTAL_MISMATCH",
      `The distributions add up to ${Number(total) / 1e6} USDC; they must add up to exactly ${Number(required) / 1e6} USDC.`,
    );
  }
}

export interface EscrowSummary {
  contractId: string;
  type: EscrowKind;
  balance: number;
  released?: boolean;
  dispute?: EscrowView["dispute"];
  milestones: {
    index: number;
    status: string;
    approvals: EscrowView["milestones"][number]["approvals"];
    released?: boolean;
    dispute?: EscrowView["dispute"];
  }[];
}

export function summarize(escrow: EscrowView): EscrowSummary {
  return {
    contractId: escrow.contractId,
    type: escrow.type,
    balance: escrow.balance,
    released: escrow.released,
    dispute: escrow.dispute,
    milestones: escrow.milestones.map((m, index) => ({
      index,
      status: m.status,
      approvals: m.approvals,
      released: m.released,
      dispute: m.dispute,
    })),
  };
}

/** Builds, checks, signs and confirms one escrow action for the agent, and records the decision. */
export async function performAction(agent: AgentRecord, request: ActionRequest): Promise<ActionResult> {
  const record = (outcome: "sent" | "failed", extra: { txHash?: string; error?: string } = {}) =>
    store.addDecision({
      agentId: agent.id,
      escrow: request.escrow,
      at: new Date().toISOString(),
      action: request.action,
      milestoneIndexes: request.milestoneIndexes,
      reason: request.reason,
      ...(request.evidence ? { evidence: request.evidence } : {}),
      ...(request.distributions ? { distributions: request.distributions } : {}),
      outcome,
      ...extra,
    });

  try {
    if (!isAddress(request.escrow)) throw new Refusal("BAD_ESCROW", `${request.escrow} is not an address.`);
    const address = getAddress(request.escrow);
    const watch = await store.getWatch(agent.id, address);
    if (!watch) {
      throw new Refusal("ESCROW_NOT_ASSIGNED", "The dispatcher never sent you this escrow, so you cannot act on it.");
    }
    const escrow = await getEscrow(address);
    requireRoles(agent, escrow, request.action);
    if (request.action === "resolve-dispute" || request.action === "withdraw-remaining-funds") {
      const history = await escrowHistory(address, watch.createdBlock ? BigInt(watch.createdBlock) : undefined);
      checkDistributions(escrow, request, allowedRecipients(escrow, history.funders, watch.deployer));
    }

    const { route, body } = routeAndBody(escrow.type, { ...request, escrow: address }, agent.wallet.address);
    const built = await buildEscrowCall(escrow.type, route, body);
    await checkBuild(built, address, escrow.type, request);

    const sent = await sendContractCall(agent.wallet.walletId, built.to, built.data);
    await record("sent", { txHash: sent.txHash });
    const after = await getEscrow(address, escrow.type);
    return { ok: true, action: request.action, txHash: sent.txHash, explorer: explorerTx(sent.txHash), escrowAfter: summarize(after) };
  } catch (error) {
    // The contract rejects a repeated approval, release, dispute or resolution, so a retried call cannot act twice.
    const code = error instanceof Refusal || error instanceof TwApiError ? error.code : "ACTION_FAILED";
    const detail = error instanceof TwApiError ? error.detail : (error as Error).message;
    await record("failed", { error: `${code}: ${detail}` });
    return { ok: false, code, detail };
  }
}
