import { describe, expect, it } from "vitest";

import { allowedActions, roleConflicts, rolesAllow, slotsOf } from "../agent/lib/roles";

describe("roles", () => {
  it("lets an approver approve and dispute, but not release", () => {
    expect(allowedActions(slotsOf(["approver"]))).toEqual(["approve-milestones", "dispute"]);
  });

  it("lets a release signer release and dispute, but not approve", () => {
    expect(allowedActions(slotsOf(["releaseSigner"]))).toEqual(["release-funds", "dispute"]);
  });

  it("needs both roles to approve and release in one step", () => {
    expect(rolesAllow(["approver"], "approve-and-release-milestones")).toBe(false);
    expect(rolesAllow(["approver", "releaseSigner"], "approve-and-release-milestones")).toBe(true);
  });

  it("lets a service provider deliver and dispute, as provider or receiver", () => {
    expect(slotsOf(["serviceProvider"])).toEqual(["serviceProvider", "receiver"]);
    expect(allowedActions(slotsOf(["serviceProvider"]))).toEqual(["deliver", "dispute"]);
    expect(allowedActions(["receiver"])).toEqual(["dispute"]);
  });

  it("lets a dispute resolver resolve and return leftovers, but never dispute", () => {
    expect(allowedActions(slotsOf(["disputeResolver"]))).toEqual(["resolve-dispute", "withdraw-remaining-funds"]);
  });

  it("lets an admin dispute only where it is also the platform", () => {
    expect(allowedActions(["admin"])).toEqual([]);
    expect(allowedActions(["admin", "platform"])).toEqual(["dispute"]);
  });

  it("follows the contract's overlap rules", () => {
    expect(roleConflicts(["approver", "releaseSigner", "serviceProvider"])).toEqual([]);
    expect(roleConflicts(["disputeResolver"])).toEqual([]);
    expect(roleConflicts(["admin"])).toEqual([]);
    expect(roleConflicts(["disputeResolver", "approver"])).toHaveLength(1);
    expect(roleConflicts(["admin", "serviceProvider"])).toHaveLength(1);
    expect(roleConflicts(["admin", "disputeResolver"])).toHaveLength(2);
  });
});
