import { describe, expect, it } from "vitest";
import { buildProactiveShareContent, shouldCreateProactiveShare } from "@/server/agent/proactive-share";

describe("shouldCreateProactiveShare", () => {
  it("allows one share when policy permits and no recent share exists", () => {
    expect(
      shouldCreateProactiveShare({
        now: new Date("2026-07-05T10:00:00+08:00"),
        latestShareAt: null,
        quietStart: "23:00",
        quietEnd: "08:00",
        sentToday: 0,
        maxPerDay: 3,
      }),
    ).toBe(true);
  });

  it("blocks quiet hours, daily caps, and shares within 24 hours", () => {
    const base = {
      now: new Date("2026-07-05T10:00:00+08:00"),
      quietStart: "23:00",
      quietEnd: "08:00",
      sentToday: 0,
      maxPerDay: 3,
    };

    expect(shouldCreateProactiveShare({ ...base, latestShareAt: new Date("2026-07-04T11:00:00+08:00") })).toBe(false);
    expect(shouldCreateProactiveShare({ ...base, latestShareAt: null, sentToday: 3 })).toBe(false);
    expect(shouldCreateProactiveShare({ ...base, latestShareAt: null, unansweredCount: 2 })).toBe(false);
    expect(
      shouldCreateProactiveShare({
        ...base,
        now: new Date("2026-07-05T23:30:00+08:00"),
        latestShareAt: null,
      }),
    ).toBe(false);
  });
});

describe("buildProactiveShareContent", () => {
  it("turns a memory and search summary into a natural share", () => {
    expect(
      buildProactiveShareContent({
        memory: "用户喜欢周末爬山",
        searchSummary: "这周末北京北部山区天气晴，午后风力较大。",
      }),
    ).toContain("你之前提到");
  });
});
