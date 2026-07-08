import { describe, expect, it } from "vitest";
import { shouldRunDailyReflection } from "@/server/evolution/reflection";

describe("shouldRunDailyReflection", () => {
  it("runs when no reflection exists in the last day", () => {
    expect(shouldRunDailyReflection(new Date("2026-07-05T10:00:00+08:00"), null)).toBe(true);
    expect(
      shouldRunDailyReflection(
        new Date("2026-07-05T10:00:00+08:00"),
        new Date("2026-07-04T09:59:00+08:00"),
      ),
    ).toBe(true);
    expect(
      shouldRunDailyReflection(
        new Date("2026-07-05T10:00:00+08:00"),
        new Date("2026-07-04T10:01:00+08:00"),
      ),
    ).toBe(false);
  });
});
