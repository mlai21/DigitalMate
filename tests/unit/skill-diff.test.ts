import { describe, expect, it } from "vitest";
import { buildLineDiff } from "@/server/skills/diff";

describe("buildLineDiff", () => {
  it("marks added, removed and context lines", () => {
    const diff = buildLineDiff("步骤一\n步骤二\n步骤三", "步骤一\n步骤二（更新）\n步骤三\n步骤四");

    expect(diff).toEqual([
      { type: "context", text: "步骤一" },
      { type: "removed", text: "步骤二" },
      { type: "added", text: "步骤二（更新）" },
      { type: "context", text: "步骤三" },
      { type: "added", text: "步骤四" },
    ]);
  });

  it("returns pure context for identical documents", () => {
    const diff = buildLineDiff("a\nb", "a\nb");

    expect(diff.every((line) => line.type === "context")).toBe(true);
  });
});
