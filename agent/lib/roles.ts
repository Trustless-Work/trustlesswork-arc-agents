/**
 * The roles an agent can be created with, the escrow slots each one fills, and what each lets it sign.
 *
 * The rules follow the Trustless Work contracts (the same on Stellar and Arc), where one address may hold several
 * roles in an escrow except that:
 * - a dispute resolver holds no other role (approver, service provider, release signer, receiver, platform, admin);
 * - the admin shares its address with the platform only.
 * An agent is one wallet, so its roles must fit in one escrow together.
 */
export const AGENT_ROLES = ["approver", "releaseSigner", "serviceProvider", "disputeResolver", "admin"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** The escrow slots an address can hold. */
export type EscrowRole =
  | "approver"
  | "releaseSigner"
  | "serviceProvider"
  | "receiver"
  | "disputeResolver"
  | "admin"
  | "platform";

/** Slots an agent of each role can fill. A service provider is usually paid, so it can be the receiver too. */
export const ROLE_SLOTS: Record<AgentRole, EscrowRole[]> = {
  approver: ["approver"],
  releaseSigner: ["releaseSigner"],
  serviceProvider: ["serviceProvider", "receiver"],
  disputeResolver: ["disputeResolver"],
  admin: ["admin", "platform"],
};

/** Roles that must be alone, and why. */
const EXCLUSIVE: Partial<Record<AgentRole, string>> = {
  disputeResolver: "A dispute resolver cannot hold any other role in an escrow.",
  admin: "The admin can share its address only with the platform, which an admin agent fills already.",
};

/** Why `roles` cannot go together in one escrow, or an empty list when they can. */
export function roleConflicts(roles: readonly AgentRole[]): string[] {
  if (roles.length < 2) return [];
  return roles.flatMap((role) => (EXCLUSIVE[role] ? [EXCLUSIVE[role]] : []));
}

export const ESCROW_ACTIONS = [
  "approve-milestones",
  "approve-and-release-milestones",
  "release-funds",
  "deliver",
  "dispute",
  "resolve-dispute",
  "withdraw-remaining-funds",
] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

/** Escrow slots the wallet must hold for each action. `any` needs one of them, `all` every one. */
const REQUIRED_SLOTS: Record<EscrowAction, { all?: EscrowRole[]; any?: EscrowRole[] }> = {
  "approve-milestones": { all: ["approver"] },
  "approve-and-release-milestones": { all: ["approver", "releaseSigner"] },
  "release-funds": { all: ["releaseSigner"] },
  deliver: { all: ["serviceProvider"] },
  // The contract's list; a receiver that holds no other role may dispute only its own milestones.
  dispute: { any: ["approver", "releaseSigner", "serviceProvider", "receiver", "platform"] },
  "resolve-dispute": { all: ["disputeResolver"] },
  "withdraw-remaining-funds": { all: ["disputeResolver"] },
};

export function slotsAllow(slots: readonly EscrowRole[], action: EscrowAction): boolean {
  const rule = REQUIRED_SLOTS[action];
  if (rule.all && !rule.all.every((slot) => slots.includes(slot))) return false;
  if (rule.any && !rule.any.some((slot) => slots.includes(slot))) return false;
  return true;
}

/** Every slot an agent with these roles can fill. */
export function slotsOf(roles: readonly AgentRole[]): EscrowRole[] {
  return [...new Set(roles.flatMap((role) => ROLE_SLOTS[role]))];
}

/** Whether an agent created with these roles may try the action, wherever its wallet sits. */
export function rolesAllow(roles: readonly AgentRole[], action: EscrowAction): boolean {
  return slotsAllow(slotsOf(roles), action);
}

export function allowedActions(slots: readonly EscrowRole[]): EscrowAction[] {
  return ESCROW_ACTIONS.filter((action) => slotsAllow(slots, action));
}

export const ROLE_LABELS: Record<EscrowRole, string> = {
  approver: "approver",
  releaseSigner: "release signer",
  serviceProvider: "service provider",
  receiver: "receiver",
  disputeResolver: "dispute resolver",
  admin: "admin",
  platform: "platform",
};
