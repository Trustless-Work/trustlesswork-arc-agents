import { createHash, randomUUID } from "node:crypto";

import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { createAgentWallet, getAssignedWallet } from "./circle";
import { AGENT_ROLES, allowedActions, roleConflicts, slotsOf, type AgentRole } from "./roles";
import { store, type AgentRecord, type AgentVersion } from "./store";

const nameField = z.string().trim().min(1).max(80);
/** Standing instructions: the creator's criteria on top of each escrow's own terms. */
const instructionsField = z.string().trim().max(4_000);
/** When set, the agent only works on escrows deployed by these wallets. Empty: any escrow that names it. */
const scopeField = z.array(z.string().refine((value) => isAddress(value), "Not an address.")).max(20);

export const createAgentInput = z.object({
  name: nameField,
  roles: z
    .array(z.enum(AGENT_ROLES))
    .min(1)
    .refine((roles) => new Set(roles).size === roles.length, "Each role can be listed once.")
    .superRefine((roles, ctx) => {
      for (const message of roleConflicts(roles)) ctx.addIssue({ code: "custom", message });
    }),
  instructions: instructionsField.default(""),
  onlyEscrowsFrom: scopeField.default([]),
  /** An existing Circle wallet for the agent. Without it, the agent gets a new wallet of its own. */
  wallet: z.object({ walletId: z.string().uuid() }).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentInput>;

/** What can change after creation. Roles and wallet cannot: escrows already point at this wallet in these roles. */
export const updateAgentInput = z
  .object({ name: nameField.optional(), instructions: instructionsField.optional(), onlyEscrowsFrom: scopeField.optional() })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), "Send at least one field to change.");

export type UpdateAgentInput = z.infer<typeof updateAgentInput>;

type EditableConfig = Pick<AgentVersion, "name" | "instructions" | "onlyEscrowsFrom">;

function configHash(agent: Pick<AgentRecord, "id" | "roles" | "wallet">, config: EditableConfig): string {
  const fixed = {
    id: agent.id,
    name: config.name,
    roles: [...agent.roles].sort(),
    instructions: config.instructions,
    onlyEscrowsFrom: [...config.onlyEscrowsFrom].sort(),
    wallet: agent.wallet.address.toLowerCase(),
  };
  return createHash("sha256").update(JSON.stringify(fixed)).digest("hex");
}

/** Every version of the agent, including version 1 for agents created before versions were kept. */
export function versionsOf(agent: AgentRecord): AgentVersion[] {
  if (agent.versions?.length) return agent.versions;
  return [
    {
      version: 1,
      at: agent.createdAt,
      name: agent.name,
      instructions: agent.instructions,
      onlyEscrowsFrom: agent.onlyEscrowsFrom,
      configHash: agent.configHash,
      changed: [],
    },
  ];
}

export function currentVersion(agent: AgentRecord): number {
  return agent.version ?? 1;
}

/** The configuration the agent works with on an escrow: the version it had when it picked the escrow up. */
export function configFor(agent: AgentRecord, version?: number): AgentVersion {
  const versions = versionsOf(agent);
  return versions.find((v) => v.version === version) ?? versions[versions.length - 1]!;
}

/** Creates an agent. Its roles and wallet are fixed from here on; its name, instructions and scope can be edited. */
export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  const id = randomUUID();
  const roles = AGENT_ROLES.filter((role) => input.roles.includes(role)) as AgentRole[];
  const wallet = input.wallet
    ? { source: "assigned" as const, ...(await getAssignedWallet(input.wallet.walletId)) }
    : { source: "created" as const, ...(await createAgentWallet(id, input.name)) };

  const config = { name: input.name, instructions: input.instructions, onlyEscrowsFrom: input.onlyEscrowsFrom.map((a) => getAddress(a)) };
  const createdAt = new Date().toISOString();
  const hash = configHash({ id, roles, wallet }, config);
  const agent: AgentRecord = {
    id,
    roles,
    wallet,
    ...config,
    createdAt,
    configHash: hash,
    version: 1,
    versions: [{ version: 1, at: createdAt, ...config, configHash: hash, changed: [] }],
  };
  await store.addAgent(agent);
  return agent;
}

/**
 * Edits the agent's name, instructions or scope as a new version. Escrows it already works on keep the version they
 * started with, so nobody can change a judge's criteria in the middle of a job.
 */
export async function updateAgent(id: string, input: UpdateAgentInput): Promise<{ agent: AgentRecord; changed: boolean }> {
  let changed = false;
  const agent = await store.updateAgent(id, (current) => {
    if (current.deletedAt) throw new AgentGoneError();
    const next: EditableConfig = {
      name: input.name ?? current.name,
      instructions: input.instructions ?? current.instructions,
      onlyEscrowsFrom: input.onlyEscrowsFrom ? input.onlyEscrowsFrom.map((a) => getAddress(a)) : current.onlyEscrowsFrom,
    };
    const fields = (["name", "instructions", "onlyEscrowsFrom"] as const).filter(
      (field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]),
    );
    if (fields.length === 0) return current;
    changed = true;
    const at = new Date().toISOString();
    const version = currentVersion(current) + 1;
    const hash = configHash(current, next);
    return {
      ...current,
      ...next,
      configHash: hash,
      version,
      versions: [...versionsOf(current), { version, at, ...next, configHash: hash, changed: fields }],
      updatedAt: at,
    };
  });
  return { agent, changed };
}

export class AgentGoneError extends Error {
  constructor() {
    super("This agent was deleted.");
  }
}

export class AgentBusyError extends Error {
  constructor(readonly escrows: string[]) {
    super(
      `The agent still takes part in ${escrows.length} open ${escrows.length === 1 ? "escrow" : "escrows"}. ` +
        "Deleting it now could leave their funds stuck. Delete it once they are finished.",
    );
  }
}

/** Deletes an agent that has no open escrows. Its record and decision log stay, marked deleted. */
export async function deleteAgent(id: string): Promise<AgentRecord> {
  const open = await store.listWatches({ agentId: id, status: "open" });
  if (open.length > 0) throw new AgentBusyError(open.map((watch) => watch.escrow));
  return store.updateAgent(id, (current) => {
    if (current.deletedAt) throw new AgentGoneError();
    return { ...current, deletedAt: new Date().toISOString() };
  });
}

/** What anyone can see about an agent. The Circle wallet id stays internal. */
export function publicAgent(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    roles: agent.roles,
    allowedActions: allowedActions(slotsOf(agent.roles)),
    instructions: agent.instructions,
    onlyEscrowsFrom: agent.onlyEscrowsFrom,
    wallet: { address: agent.wallet.address, source: agent.wallet.source, accountType: agent.wallet.accountType },
    createdAt: agent.createdAt,
    configHash: agent.configHash,
    version: currentVersion(agent),
    versions: versionsOf(agent),
    ...(agent.updatedAt ? { updatedAt: agent.updatedAt } : {}),
    ...(agent.deletedAt ? { deletedAt: agent.deletedAt } : {}),
  };
}

/** The identity an agent's sessions run as. Tools read the agent from it, never from the model. */
export function agentPrincipal(agent: AgentRecord, escrow?: string) {
  const attributes: Record<string, string> = { agentId: agent.id };
  if (escrow) attributes.escrow = escrow.toLowerCase();
  return {
    authenticator: "trustlesswork-agents",
    principalType: "service",
    principalId: `agent:${agent.id}`,
    attributes,
  };
}

interface AuthLike {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator?: string;
}

export function agentIdOf(auth: AuthLike | null | undefined): string | undefined {
  if (auth?.authenticator !== "trustlesswork-agents") return undefined;
  const id = auth.attributes?.agentId;
  return typeof id === "string" ? id : undefined;
}

export function escrowOf(auth: AuthLike | null | undefined): string | undefined {
  if (auth?.authenticator !== "trustlesswork-agents") return undefined;
  const escrow = auth.attributes?.escrow;
  return typeof escrow === "string" ? escrow : undefined;
}

/** The agent this session belongs to. Fails closed when the session was not started by the dispatcher. */
export async function requireAgent(session: {
  auth: { current: AuthLike | null; initiator: AuthLike | null };
}): Promise<AgentRecord> {
  const id = agentIdOf(session.auth.initiator) ?? agentIdOf(session.auth.current);
  const agent = id ? await store.getAgent(id) : undefined;
  if (!agent) throw new Error("This session does not belong to a Trustless Work agent, so it cannot act on escrows.");
  if (agent.deletedAt) throw new Error("This agent was deleted, so it no longer acts on escrows.");
  return agent;
}
