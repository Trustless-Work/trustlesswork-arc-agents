import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { allowedRecipients, checkBuild, checkDistributions, type ActionRequest } from "../agent/lib/actions";
import type { EscrowView } from "../agent/lib/escrow";
import { ESCROW_ABI } from "../agent/lib/network";

const ESCROW = "0x06B382F05019348EE95c5F8b5C119EB19611ec28";
const official = async () => true;

function request(patch: Partial<ActionRequest>): ActionRequest {
  return { escrow: ESCROW, action: "approve-milestones", milestoneIndexes: [0], reason: "ok", ...patch };
}

describe("checkBuild", () => {
  it("accepts the exact call that was asked for", async () => {
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "approveAndReleaseMilestones", args: [[0]] });
    await expect(
      checkBuild({ to: ESCROW, data }, ESCROW, "single-release", request({ action: "approve-and-release-milestones" }), official),
    ).resolves.toBeUndefined();
  });

  it("accepts a single-release release without arguments and a multi-release one with milestones", async () => {
    const single = encodeFunctionData({ abi: ESCROW_ABI, functionName: "releaseFunds", args: [] });
    await expect(checkBuild({ to: ESCROW, data: single }, ESCROW, "single-release", request({ action: "release-funds", milestoneIndexes: [] }), official)).resolves.toBeUndefined();
    const multi = encodeFunctionData({ abi: ESCROW_ABI, functionName: "releaseFunds", args: [[1, 2]] });
    await expect(checkBuild({ to: ESCROW, data: multi }, ESCROW, "multi-release", request({ action: "release-funds", milestoneIndexes: [1, 2] }), official)).resolves.toBeUndefined();
  });

  it("refuses a call to another contract", async () => {
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "approveMilestones", args: [[0]] });
    await expect(
      checkBuild({ to: "0x0000000000000000000000000000000000000001", data }, ESCROW, "single-release", request({}), official),
    ).rejects.toMatchObject({ code: "BUILD_TARGET_MISMATCH" });
  });

  it("refuses an escrow that is not an official clone", async () => {
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "approveMilestones", args: [[0]] });
    await expect(checkBuild({ to: ESCROW, data }, ESCROW, "single-release", request({}), async () => false)).rejects.toMatchObject({
      code: "ESCROW_NOT_OFFICIAL",
    });
  });

  it("refuses another function or other arguments", async () => {
    const release = encodeFunctionData({ abi: ESCROW_ABI, functionName: "releaseFunds", args: [] });
    await expect(checkBuild({ to: ESCROW, data: release }, ESCROW, "single-release", request({}), official)).rejects.toMatchObject({
      code: "BUILD_CALL_MISMATCH",
    });
    const otherMilestone = encodeFunctionData({ abi: ESCROW_ABI, functionName: "approveMilestones", args: [[1]] });
    await expect(checkBuild({ to: ESCROW, data: otherMilestone }, ESCROW, "single-release", request({}), official)).rejects.toMatchObject({
      code: "BUILD_CALL_MISMATCH",
    });
    const otherReason = encodeFunctionData({ abi: ESCROW_ABI, functionName: "disputeEscrow", args: ["something else"] });
    await expect(
      checkBuild({ to: ESCROW, data: otherReason }, ESCROW, "single-release", request({ action: "dispute", milestoneIndexes: [], reason: "late" }), official),
    ).rejects.toMatchObject({ code: "BUILD_CALL_MISMATCH" });
  });

  it("refuses data it cannot decode, such as a USDC transfer", async () => {
    const transfer = "0xa9059cbb000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000f4240";
    await expect(checkBuild({ to: ESCROW, data: transfer }, ESCROW, "single-release", request({}), official)).rejects.toMatchObject({
      code: "BUILD_UNKNOWN_FUNCTION",
    });
  });
});

describe("checkBuild, new actions", () => {
  it("accepts a delivery with the exact evidence, and refuses another evidence", async () => {
    const evidence = "The post text.";
    const data = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "changeMilestoneStatus",
      args: [[{ milestoneIndex: 0, newStatus: "completed", setEvidence: true, newEvidence: evidence }]],
    });
    await expect(checkBuild({ to: ESCROW, data }, ESCROW, "single-release", request({ action: "deliver", evidence }), official)).resolves.toBeUndefined();
    await expect(
      checkBuild({ to: ESCROW, data }, ESCROW, "single-release", request({ action: "deliver", evidence: "Something else." }), official),
    ).rejects.toMatchObject({ code: "BUILD_CALL_MISMATCH" });
  });

  it("accepts a resolution that pays exactly who and what was asked", async () => {
    const a = "0x96dcba958fdce6552d69840d300471d7f69d764f";
    const b = "0x5b4e160338c8e259e3738789e1a24f71ab3e9d78";
    const distributions = [{ address: a, amount: 0.2 }, { address: b, amount: 0.3 }];
    const single = encodeFunctionData({ abi: ESCROW_ABI, functionName: "resolveDispute", args: [[a, b], [200000n, 300000n]] });
    await expect(
      checkBuild({ to: ESCROW, data: single }, ESCROW, "single-release", request({ action: "resolve-dispute", milestoneIndexes: [], distributions }), official),
    ).resolves.toBeUndefined();
    const multi = encodeFunctionData({ abi: ESCROW_ABI, functionName: "resolveDispute", args: [[1], [a, b], [200000n, 300000n]] });
    await expect(
      checkBuild({ to: ESCROW, data: multi }, ESCROW, "multi-release", request({ action: "resolve-dispute", milestoneIndexes: [1], distributions }), official),
    ).resolves.toBeUndefined();
    const swapped = encodeFunctionData({ abi: ESCROW_ABI, functionName: "resolveDispute", args: [[a, b], [300000n, 200000n]] });
    await expect(
      checkBuild({ to: ESCROW, data: swapped }, ESCROW, "single-release", request({ action: "resolve-dispute", milestoneIndexes: [], distributions }), official),
    ).rejects.toMatchObject({ code: "BUILD_CALL_MISMATCH" });
  });
});

describe("distribution guard", () => {
  const CLIENT = "0x96dcba958fdce6552d69840d300471d7f69d764f";
  const WRITER = "0x5b4e160338c8e259e3738789e1a24f71ab3e9d78";
  const RESOLVER = "0x3bed064de5d3379c23400730e65ca0ac18b81da0";
  const ATTACKER = "0x000000000000000000000000000000000000dead";
  const escrow: EscrowView = {
    type: "single-release",
    contractId: ESCROW,
    amount: 0.5,
    balance: 0.5,
    roles: {
      approvers: ["0xd848270acef48e7bbd622fa7a39045ec51cf0897"],
      serviceProviders: [WRITER],
      releaseSigners: ["0xd848270acef48e7bbd622fa7a39045ec51cf0897"],
      disputeResolvers: [RESOLVER],
      receiver: WRITER,
      platform: "0x2fb8f4c421b2ddd8dd1de4d8edc36a532c35cbf8",
      admin: "0x2fb8f4c421b2ddd8dd1de4d8edc36a532c35cbf8",
    },
    milestones: [],
    dispute: { isDisputed: true, reason: "x", resolved: false },
    released: false,
    escrowHash: "0x",
  };
  const recipients = allowedRecipients(escrow, [CLIENT]);
  const resolve = (distributions: { address: string; amount: number }[]) =>
    request({ action: "resolve-dispute", milestoneIndexes: [], distributions });

  it("pays the worker and the funders only, never the dispute resolver or the approver", () => {
    expect(recipients.sort()).toEqual([CLIENT, WRITER].sort());
  });

  it("accepts a split of the whole balance among them", () => {
    expect(() => checkDistributions(escrow, resolve([{ address: CLIENT, amount: 0.5 }]), recipients)).not.toThrow();
    expect(() =>
      checkDistributions(escrow, resolve([{ address: CLIENT, amount: 0.1 }, { address: WRITER, amount: 0.4 }]), recipients),
    ).not.toThrow();
  });

  it("refuses an outsider, the resolver itself and a wrong total", () => {
    expect(() => checkDistributions(escrow, resolve([{ address: ATTACKER, amount: 0.5 }]), recipients)).toThrow(
      expect.objectContaining({ code: "DISTRIBUTION_RECIPIENT_NOT_ALLOWED" }),
    );
    expect(() => checkDistributions(escrow, resolve([{ address: RESOLVER, amount: 0.5 }]), recipients)).toThrow(
      expect.objectContaining({ code: "DISTRIBUTION_RECIPIENT_NOT_ALLOWED" }),
    );
    expect(() => checkDistributions(escrow, resolve([{ address: CLIENT, amount: 0.4 }]), recipients)).toThrow(
      expect.objectContaining({ code: "DISTRIBUTIONS_TOTAL_MISMATCH" }),
    );
  });
});
