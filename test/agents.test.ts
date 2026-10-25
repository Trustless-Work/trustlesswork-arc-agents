import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  AgentBusyError,
  AgentGoneError,
  configFor,
  deleteAgent,
  updateAgent,
  updateAgentInput,
  versionsOf,
} from "../agent/lib/agents";
import { agentBriefing } from "../agent/lib/briefing";
import { store, type AgentRecord } from "../agent/lib/store";

const ESCROW = "0x40B680265F8F1c1a73a4B5b71685ffBd302cc464";

/** An agent as it was stored before versions existed. */
function legacyAgent(id: string): AgentRecord {
  return {
    id,
    name: "Post reviewer",
    roles: ["approver", "releaseSigner"],
    instructions: "Reject emojis.",
    onlyEscrowsFrom: [],
    wallet: { source: "created", walletId: "w", address: "0xd848270acef48e7bbd622fa7a39045ec51cf0897", accountType: "SCA" },
    createdAt: "2026-10-22T00:00:00.000Z",
    configHash: "legacy",
  };
}

beforeEach(() => {
  process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-test-"));
});

describe("editing an agent", () => {
  it("adds a version with what changed, and keeps version 1 for older agents", async () => {
    await store.addAgent(legacyAgent("a1"));
    const { agent, changed } = await updateAgent("a1", { instructions: "Reject emojis and hashtags." });
    expect(changed).toBe(true);
    expect(agent.version).toBe(2);
    expect(agent.instructions).toBe("Reject emojis and hashtags.");
    const versions = versionsOf(agent);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]?.instructions).toBe("Reject emojis.");
    expect(versions[1]?.changed).toEqual(["instructions"]);
    expect(agent.configHash).not.toBe("legacy");
  });

  it("does nothing when nothing changes", async () => {
    await store.addAgent(legacyAgent("a2"));
    const { agent, changed } = await updateAgent("a2", { name: "Post reviewer" });
    expect(changed).toBe(false);
    expect(agent.version).toBeUndefined();
  });

  it("never lets roles or the wallet change", () => {
    expect(updateAgentInput.safeParse({ roles: ["disputeResolver"] }).success).toBe(false);
    expect(updateAgentInput.safeParse({ wallet: { walletId: "x" } }).success).toBe(false);
    expect(updateAgentInput.safeParse({}).success).toBe(false);
  });

  it("keeps the instructions an escrow started with", async () => {
    await store.addAgent(legacyAgent("a3"));
    await store.addWatch({ agentId: "a3", escrow: ESCROW, kind: "single-release", configVersion: 1 });
    const { agent } = await updateAgent("a3", { instructions: "Approve everything." });
    const pinned = configFor(agent, (await store.getWatch("a3", ESCROW))?.configVersion);
    expect(pinned.instructions).toBe("Reject emojis.");
    expect(agentBriefing(agent, pinned)).toContain("Reject emojis.");
    expect(agentBriefing(agent, pinned)).not.toContain("Approve everything.");
    expect(configFor(agent).instructions).toBe("Approve everything.");
  });
});

describe("deleting an agent", () => {
  it("refuses while the agent has open escrows", async () => {
    await store.addAgent(legacyAgent("d1"));
    await store.addWatch({ agentId: "d1", escrow: ESCROW, kind: "single-release" });
    await expect(deleteAgent("d1")).rejects.toBeInstanceOf(AgentBusyError);
  });

  it("deletes it once its escrows are finished, keeping the record", async () => {
    await store.addAgent(legacyAgent("d2"));
    await store.addWatch({ agentId: "d2", escrow: ESCROW, kind: "single-release" });
    await store.patchWatch("d2", ESCROW, { status: "closed" });
    const deleted = await deleteAgent("d2");
    expect(deleted.deletedAt).toBeDefined();
    expect((await store.listAgents()).map((a) => a.id)).not.toContain("d2");
    expect((await store.listAgents({ includeDeleted: true })).map((a) => a.id)).toContain("d2");
    await expect(updateAgent("d2", { name: "Back" })).rejects.toBeInstanceOf(AgentGoneError);
  });
});
