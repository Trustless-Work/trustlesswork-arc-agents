import { describe, expect, it } from "vitest";

import { isClosed, pendingTasks, waitingFor, type EscrowView, type MilestoneView } from "../agent/lib/escrow";

const AGENT = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";

function milestone(patch: Partial<MilestoneView> = {}): MilestoneView {
  return {
    description: "Deliver the post",
    status: "pending",
    evidence: "",
    approvals: { target: 1, approvalCount: 0, approvedBy: [] },
    ...patch,
  };
}

function single(patch: Partial<EscrowView> = {}): EscrowView {
  return {
    type: "single-release",
    contractId: "0x00000000000000000000000000000000000000e5",
    amount: 1,
    balance: 1,
    roles: {
      approvers: [AGENT.toUpperCase().replace("0X", "0x")],
      serviceProviders: [OTHER],
      releaseSigners: [AGENT],
      disputeResolvers: ["0x00000000000000000000000000000000000000cc"],
      receiver: OTHER,
      platform: "0x00000000000000000000000000000000000000dd",
      admin: "0x00000000000000000000000000000000000000dd",
    },
    milestones: [milestone()],
    dispute: { isDisputed: false, reason: "", resolved: false },
    released: false,
    escrowHash: "0xhash",
    ...patch,
  };
}

describe("pendingTasks, single-release", () => {
  it("has nothing to do before the delivery", () => {
    expect(pendingTasks(single(), AGENT, ["approver", "releaseSigner"])).toEqual([]);
  });

  it("asks the approver to review a delivery, whatever the letter case of its address", () => {
    const escrow = single({ milestones: [milestone({ status: "completed", evidence: "the post" })] });
    expect(pendingTasks(escrow, AGENT, ["approver"])).toEqual([{ type: "review", milestoneIndexes: [0] }]);
  });

  it("treats evidence without the completed status as a delivery", () => {
    const escrow = single({ milestones: [milestone({ status: "in review", evidence: "https://x.test/a" })] });
    expect(pendingTasks(escrow, AGENT, ["approver"])).toEqual([{ type: "review", milestoneIndexes: [0] }]);
  });

  it("does not wake an approver before the escrow is funded", () => {
    const escrow = single({ balance: 0, milestones: [milestone({ status: "completed" })] });
    expect(pendingTasks(escrow, AGENT, ["approver"])).toEqual([]);
  });

  it("asks the release signer to release once every milestone is approved", () => {
    const approved = milestone({ status: "completed", approvals: { target: 1, approvalCount: 1, approvedBy: [OTHER] } });
    expect(pendingTasks(single({ milestones: [approved] }), AGENT, ["releaseSigner"])).toEqual([
      { type: "release", milestoneIndexes: [] },
    ]);
  });

  it("skips a milestone the agent already approved", () => {
    const mine = milestone({ status: "completed", approvals: { target: 2, approvalCount: 1, approvedBy: [AGENT] } });
    expect(pendingTasks(single({ milestones: [mine] }), AGENT, ["approver"])).toEqual([]);
  });

  it("leaves a disputed or closed escrow alone", () => {
    const delivered = [milestone({ status: "completed" })];
    expect(pendingTasks(single({ milestones: delivered, dispute: { isDisputed: true, reason: "x", resolved: false } }), AGENT, ["approver"])).toEqual([]);
    const released = single({ released: true, milestones: delivered });
    expect(isClosed(released)).toBe(true);
    expect(pendingTasks(released, AGENT, ["approver", "releaseSigner"])).toEqual([]);
  });

  it("ignores escrow roles the agent was not created with", () => {
    const escrow = single({ milestones: [milestone({ status: "completed" })] });
    expect(pendingTasks(escrow, AGENT, ["releaseSigner"])).toEqual([]);
  });

  it("does nothing for a wallet the escrow does not name", () => {
    const escrow = single({ milestones: [milestone({ status: "completed" })] });
    expect(pendingTasks(escrow, OTHER, ["approver", "releaseSigner"])).toEqual([]);
  });
});

describe("pendingTasks, multi-release", () => {
  const multi = (milestones: MilestoneView[], balance = 2): EscrowView => ({
    ...single(),
    type: "multi-release",
    amount: undefined,
    balance,
    milestones,
    dispute: undefined,
    released: undefined,
  });
  const open = { isDisputed: false, reason: "", resolved: false };

  it("handles each milestone on its own", () => {
    const escrow = multi([
      milestone({ amount: 1, status: "completed", dispute: open }),
      milestone({ amount: 1, status: "completed", dispute: open, approvals: { target: 1, approvalCount: 1, approvedBy: [OTHER] } }),
    ]);
    expect(pendingTasks(escrow, AGENT, ["approver", "releaseSigner"])).toEqual([
      { type: "review", milestoneIndexes: [0] },
      { type: "release", milestoneIndexes: [1] },
    ]);
  });

  it("skips disputed and released milestones, and counts only open ones as owed", () => {
    const escrow = multi(
      [
        milestone({ amount: 1, status: "completed", dispute: { ...open, isDisputed: true } }),
        milestone({ amount: 1, status: "completed", released: true, dispute: open }),
        milestone({ amount: 1, status: "completed", dispute: open }),
      ],
      2,
    );
    expect(pendingTasks(escrow, AGENT, ["approver"])).toEqual([{ type: "review", milestoneIndexes: [2] }]);
  });

  it("waits while the open milestones are not covered", () => {
    const escrow = multi([milestone({ amount: 1, status: "completed", dispute: open }), milestone({ amount: 2, dispute: open })], 2);
    expect(pendingTasks(escrow, AGENT, ["approver"])).toEqual([]);
  });
});

describe("pendingTasks, new roles", () => {
  const PROVIDER = "0x00000000000000000000000000000000000000a1";
  const RESOLVER = "0x00000000000000000000000000000000000000a2";
  const ADMIN = "0x00000000000000000000000000000000000000a3";
  const base = (patch: Partial<EscrowView> = {}) =>
    single({
      roles: {
        approvers: [OTHER],
        serviceProviders: [PROVIDER],
        releaseSigners: [OTHER],
        disputeResolvers: [RESOLVER],
        receiver: PROVIDER,
        platform: ADMIN,
        admin: ADMIN,
      },
      ...patch,
    });

  it("asks the service provider to deliver once the escrow is funded", () => {
    expect(pendingTasks(base(), PROVIDER, ["serviceProvider"])).toEqual([{ type: "deliver", milestoneIndexes: [0] }]);
    expect(pendingTasks(base({ balance: 0 }), PROVIDER, ["serviceProvider"])).toEqual([]);
    expect(pendingTasks(base({ milestones: [milestone({ status: "completed", evidence: "done" })] }), PROVIDER, ["serviceProvider"])).toEqual([]);
  });

  it("lets the service provider answer a dispute on its work", () => {
    const disputed = base({
      milestones: [milestone({ status: "completed", evidence: "done" })],
      dispute: { isDisputed: true, reason: "late", resolved: false },
    });
    expect(pendingTasks(disputed, PROVIDER, ["serviceProvider"])).toEqual([{ type: "answer-dispute", milestoneIndexes: [] }]);
  });

  it("asks the dispute resolver to resolve, and to return leftovers of a finished escrow", () => {
    const disputed = base({ dispute: { isDisputed: true, reason: "late", resolved: false } });
    expect(pendingTasks(disputed, RESOLVER, ["disputeResolver"])).toEqual([{ type: "resolve", milestoneIndexes: [] }]);
    expect(pendingTasks(base({ dispute: { isDisputed: true, reason: "x", resolved: false }, balance: 0 }), RESOLVER, ["disputeResolver"])).toEqual([]);
    expect(pendingTasks(base({ released: true, balance: 0.2 }), RESOLVER, ["disputeResolver"])).toEqual([
      { type: "leftover", milestoneIndexes: [] },
    ]);
    expect(pendingTasks(base({ released: true, balance: 0 }), RESOLVER, ["disputeResolver"])).toEqual([]);
  });

  it("resolves only the disputed milestones the escrow can pay, in multi-release", () => {
    const open = { isDisputed: false, reason: "", resolved: false };
    const escrow: EscrowView = {
      ...base(),
      type: "multi-release",
      balance: 1,
      dispute: undefined,
      released: undefined,
      milestones: [
        milestone({ amount: 1, receiver: PROVIDER, dispute: { ...open, isDisputed: true } }),
        milestone({ amount: 1, receiver: PROVIDER, dispute: open }),
      ],
    };
    expect(pendingTasks(escrow, RESOLVER, ["disputeResolver"])).toEqual([{ type: "resolve", milestoneIndexes: [0] }]);
  });

  it("gives an admin nothing to do", () => {
    expect(pendingTasks(base(), ADMIN, ["admin"])).toEqual([]);
  });
});

describe("waitingFor", () => {
  it("says who the escrow waits on, stage by stage", () => {
    expect(waitingFor(single({ balance: 0 }), AGENT)).toBe("Waiting for the escrow to be funded.");
    expect(waitingFor(single(), AGENT)).toBe("Waiting for the service provider to deliver.");
    const delivered = milestone({ status: "completed", approvals: { target: 2, approvalCount: 1, approvedBy: [AGENT] } });
    expect(waitingFor(single({ milestones: [delivered] }), AGENT)).toBe("Waiting for the other approvers.");
    const approved = milestone({ status: "completed", approvals: { target: 1, approvalCount: 1, approvedBy: [AGENT] } });
    expect(waitingFor(single({ milestones: [approved] }), AGENT)).toBe("Waiting for a release signer to release the payment.");
    expect(waitingFor(single({ dispute: { isDisputed: true, reason: "x", resolved: false } }), AGENT)).toBe(
      "In dispute: waiting for the dispute resolver to decide.",
    );
    expect(waitingFor(single({ released: true }), AGENT)).toBe("Finished.");
  });
});
