import { describe, expect, it } from "vitest";

import { walletName } from "../agent/lib/circle";

describe("walletName", () => {
  it("drops the punctuation Circle rejects and keeps the rest", () => {
    expect(walletName("Approver only (UI test)")).toBe("Approver only UI test");
    expect(walletName("Post reviewer")).toBe("Post reviewer");
    expect(walletName("¡¿()!")).toBe("Trustless Work agent");
    expect(walletName("x".repeat(80))).toHaveLength(50);
  });
});
