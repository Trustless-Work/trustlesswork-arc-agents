import { sameAddress, type EscrowKind } from "./network";
import { slotsOf, type AgentRole, type EscrowRole } from "./roles";

/** An escrow as the Trustless Work API returns it (only the fields the agents use). */
export interface EscrowView {
  type: EscrowKind;
  contractId: string;
  engagementId?: string;
  title?: string;
  description?: string;
  amount?: number;
  totalAmount?: number;
  balance: number;
  platformFee?: number;
  roles: {
    approvers: string[];
    serviceProviders: string[];
    releaseSigners: string[];
    disputeResolvers: string[];
    receiver?: string;
    platform: string;
    admin: string;
  };
  milestones: MilestoneView[];
  dispute?: DisputeView;
  released?: boolean;
  escrowHash: string;
}

export interface MilestoneView {
  description: string;
  status: string;
  evidence?: string;
  amount?: number;
  receiver?: string;
  approvals: { target: number; approvalCount: number; approvedBy: string[] };
  released?: boolean;
  dispute?: DisputeView;
}

export interface DisputeView {
  isDisputed: boolean;
  reason: string;
  resolved: boolean;
}

const has = (list: readonly string[] | undefined, address: string) =>
  (list ?? []).some((a) => sameAddress(a, address));

/** Every address that receives a payment: the receiver, or each milestone's receiver. */
export function receiversOf(escrow: EscrowView): string[] {
  if (escrow.type === "single-release") return escrow.roles.receiver ? [escrow.roles.receiver] : [];
  return [...new Set(escrow.milestones.flatMap((m) => (m.receiver ? [m.receiver] : [])))];
}

/** The escrow slots the wallet holds, limited to the ones an agent with these roles fills. */
export function escrowRolesOf(escrow: EscrowView, wallet: string, agentRoles: readonly AgentRole[]): EscrowRole[] {
  const r = escrow.roles;
  const held: Record<EscrowRole, boolean> = {
    approver: has(r.approvers, wallet),
    releaseSigner: has(r.releaseSigners, wallet),
    serviceProvider: has(r.serviceProviders, wallet),
    receiver: has(receiversOf(escrow), wallet),
    disputeResolver: has(r.disputeResolvers, wallet),
    admin: sameAddress(r.admin, wallet),
    platform: sameAddress(r.platform, wallet),
  };
  return slotsOf(agentRoles).filter((slot) => held[slot]);
}

export function isClosed(escrow: EscrowView): boolean {
  if (escrow.type === "single-release") return Boolean(escrow.released || escrow.dispute?.resolved);
  return escrow.milestones.every((m) => m.released || m.dispute?.resolved);
}

/** Changes on every action: each one changes the escrow's hash or its balance. */
export function snapshotOf(escrow: EscrowView): string {
  return `${escrow.escrowHash}:${escrow.balance}`;
}

export type TaskType = "review" | "release" | "deliver" | "answer-dispute" | "resolve" | "leftover";

export interface Task {
  type: TaskType;
  /** Empty when the task is about the whole escrow (single-release). */
  milestoneIndexes: number[];
}

function isOpen(escrow: EscrowView, m: MilestoneView): boolean {
  return escrow.type === "single-release" ? !isClosed(escrow) : !(m.released || m.dispute?.resolved);
}

function isDisputed(escrow: EscrowView, m: MilestoneView): boolean {
  return escrow.type === "single-release" ? Boolean(escrow.dispute?.isDisputed) : Boolean(m.dispute?.isDisputed);
}

function isDelivered(m: MilestoneView): boolean {
  return m.status.trim().toLowerCase() === "completed" || Boolean(m.evidence?.trim());
}

function isFullyApproved(m: MilestoneView): boolean {
  return m.approvals.target > 0 && m.approvals.approvalCount >= m.approvals.target;
}

function owed(milestones: { m: MilestoneView }[]): number {
  return milestones.reduce((sum, { m }) => sum + (m.amount ?? 0), 0);
}

function isFunded(escrow: EscrowView): boolean {
  if (escrow.type === "single-release") return escrow.balance >= (escrow.amount ?? 0);
  const open = escrow.milestones.filter((m) => isOpen(escrow, m)).map((m) => ({ m }));
  return escrow.balance >= owed(open);
}

/**
 * Who the escrow is waiting on, in a sentence, for an agent with nothing to do in it now. The first stage that
 * matches wins: dispute, funding, delivery, approvals, release.
 */
export function waitingFor(escrow: EscrowView, wallet: string): string {
  if (isClosed(escrow)) return "Finished.";
  const open = escrow.milestones.filter((m) => isOpen(escrow, m));
  if (open.some((m) => isDisputed(escrow, m))) {
    const resolving = escrow.roles.disputeResolvers.some((a) => sameAddress(a, wallet));
    return resolving && escrow.balance === 0
      ? "In dispute, but unfunded: it can be resolved once someone funds it."
      : "In dispute: waiting for the dispute resolver to decide.";
  }
  if (!isFunded(escrow)) return "Waiting for the escrow to be funded.";
  if (open.some((m) => !isDelivered(m))) return "Waiting for the service provider to deliver.";
  const unapproved = open.filter((m) => !isFullyApproved(m));
  if (unapproved.length > 0) {
    return unapproved.every((m) => m.approvals.approvedBy.some((a) => sameAddress(a, wallet)))
      ? "Waiting for the other approvers."
      : "Waiting for the approvers.";
  }
  return "Waiting for a release signer to release the payment.";
}

/**
 * What the agent's wallet has to do in this escrow right now. The dispatcher wakes the agent only when this is not
 * empty; the agent still reads the escrow and decides on its own.
 */
export function pendingTasks(escrow: EscrowView, wallet: string, agentRoles: readonly AgentRole[]): Task[] {
  const slots = escrowRolesOf(escrow, wallet, agentRoles);
  if (slots.length === 0) return [];
  const tasks: Task[] = [];
  const indexed = escrow.milestones.map((m, index) => ({ m, index }));
  const open = indexed.filter(({ m }) => isOpen(escrow, m));
  const single = escrow.type === "single-release";

  // The dispute resolver: open disputes it can settle, then funds left in a finished escrow.
  if (slots.includes("disputeResolver")) {
    if (single) {
      if (escrow.dispute?.isDisputed && !escrow.dispute.resolved && escrow.balance > 0) {
        tasks.push({ type: "resolve", milestoneIndexes: [] });
      }
    } else {
      const disputed = open.filter(({ m }) => m.dispute?.isDisputed);
      if (disputed.length > 0 && escrow.balance >= owed(disputed)) {
        tasks.push({ type: "resolve", milestoneIndexes: disputed.map(({ index }) => index) });
      }
    }
    if (isClosed(escrow) && escrow.balance > 0) tasks.push({ type: "leftover", milestoneIndexes: [] });
  }

  if (isClosed(escrow)) return tasks;

  // The service provider: the milestones it delivers. In multi-release, the ones it is paid for, if any.
  if (slots.includes("serviceProvider")) {
    const mine = single ? open : open.filter(({ m }) => sameAddress(m.receiver, wallet));
    const scope = mine.length > 0 ? mine : open;
    const answer = scope.filter(({ m }) => isDisputed(escrow, m));
    if (answer.length > 0) {
      tasks.push({ type: "answer-dispute", milestoneIndexes: single ? [] : answer.map(({ index }) => index) });
    }
    const toDeliver = scope.filter(({ m }) => !isDisputed(escrow, m) && !isDelivered(m));
    if (toDeliver.length > 0 && isFunded(escrow)) {
      tasks.push({ type: "deliver", milestoneIndexes: toDeliver.map(({ index }) => index) });
    }
  }

  if (!isFunded(escrow)) return tasks;
  const live = open.filter(({ m }) => !isDisputed(escrow, m));

  if (slots.includes("approver")) {
    const toReview = live
      .filter(({ m }) => isDelivered(m) && !isFullyApproved(m) && !m.approvals.approvedBy.some((a) => sameAddress(a, wallet)))
      .map(({ index }) => index);
    if (toReview.length) tasks.push({ type: "review", milestoneIndexes: toReview });
  }
  if (slots.includes("releaseSigner")) {
    if (single) {
      const all = escrow.milestones.length > 0 && escrow.milestones.every(isFullyApproved);
      if (all && live.length > 0) tasks.push({ type: "release", milestoneIndexes: [] });
    } else {
      const toRelease = live.filter(({ m }) => isFullyApproved(m)).map(({ index }) => index);
      if (toRelease.length) tasks.push({ type: "release", milestoneIndexes: toRelease });
    }
  }
  return tasks;
}
