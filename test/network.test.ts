import { describe, expect, it } from "vitest";

import { cloneCode, IMPLEMENTATIONS, isOfficialCode, PREVIOUS_IMPLEMENTATIONS } from "../agent/lib/network";

describe("isOfficialCode", () => {
  it("accepts a clone of the current implementation of the kind", () => {
    expect(isOfficialCode(cloneCode(IMPLEMENTATIONS["single-release"]), "single-release")).toBe(true);
  });

  it("accepts a clone of an earlier implementation, so older escrows can finish", () => {
    const earlier = PREVIOUS_IMPLEMENTATIONS["multi-release"][0]!;
    expect(isOfficialCode(cloneCode(earlier), "multi-release")).toBe(true);
  });

  it("refuses the other kind, another implementation and any other code", () => {
    expect(isOfficialCode(cloneCode(IMPLEMENTATIONS["multi-release"]), "single-release")).toBe(false);
    expect(isOfficialCode(cloneCode(PREVIOUS_IMPLEMENTATIONS["multi-release"][0]!), "single-release")).toBe(false);
    expect(isOfficialCode(cloneCode("0x0000000000000000000000000000000000000001"), "single-release")).toBe(false);
    expect(isOfficialCode("0x6080", "single-release")).toBe(false);
    expect(isOfficialCode(undefined, "single-release")).toBe(false);
  });
});
