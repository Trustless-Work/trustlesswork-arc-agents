import { describe, expect, it } from "vitest";

import { checkEveryMinutes, scheduleNextCheck } from "../agent/lib/dispatch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("checking quiet escrows less often", () => {
  it("reads every minute, every 10 minutes after a quiet hour, every hour after a quiet day", () => {
    expect(checkEveryMinutes(0)).toBe(1);
    expect(checkEveryMinutes(59 * MINUTE)).toBe(1);
    expect(checkEveryMinutes(HOUR)).toBe(10);
    expect(checkEveryMinutes(23 * HOUR)).toBe(10);
    expect(checkEveryMinutes(24 * HOUR)).toBe(60);
  });

  it("goes back to every minute when the escrow changes", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const quiet = { since: "2026-10-20T12:00:00.000Z", seenSnapshot: "a", changedAt: "2026-10-21T12:00:00.000Z" };
    expect(scheduleNextCheck(quiet, "a", now)).toMatchObject({ checkEveryMinutes: 60, changedAt: quiet.changedAt });
    const changed = scheduleNextCheck(quiet, "b", now);
    expect(changed).toMatchObject({ checkEveryMinutes: 1, seenSnapshot: "b", changedAt: new Date(now).toISOString() });
    expect(Date.parse(changed.nextCheckAt!) - now).toBe(40_000);
  });

  it("counts a watch with no history as quiet since it started", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const fresh = scheduleNextCheck({ since: "2026-10-23T09:00:00.000Z" }, "a", now);
    expect(fresh.checkEveryMinutes).toBe(1);
    const old = scheduleNextCheck({ since: "2026-10-23T09:00:00.000Z", seenSnapshot: "a" }, "a", now);
    expect(old.checkEveryMinutes).toBe(10);
  });
});
