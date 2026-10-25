import { describe, expect, it } from "vitest";

import { describeCall, parseAddress } from "../agent/lib/activity";

describe("activity", () => {
  it("puts each tool call in words", () => {
    expect(describeCall("get_escrow")).toBe("Reading the escrow");
    expect(describeCall("fetch_evidence", { url: "https://github.com/x/y" })).toBe("Opening the evidence on github.com");
    expect(describeCall("approve_and_release", { milestoneIndexes: [0] })).toBe("Approving and releasing milestone 0");
    expect(describeCall("deliver_milestone", { milestoneIndexes: [0, 2] })).toBe("Delivering milestones 0, 2");
    expect(
      describeCall("resolve_dispute", { distributions: [{ address: "0x96dcba958fdce6552d69840d300471d7f69d764f", amount: 0.5 }] }),
    ).toBe("Resolving the dispute: 0.5 USDC to 0x96dc…764f");
  });

  it("reads the agent and escrow from a session address", () => {
    expect(parseAddress("c89af067:0x40b680265f8f1c1a73a4b5b71685ffbd302cc464")).toEqual({
      agentId: "c89af067",
      escrow: "0x40b680265f8f1c1a73a4b5b71685ffbd302cc464",
    });
    expect(parseAddress(undefined)).toBeUndefined();
  });
});
