import { describe, expect, it } from "vitest";
import { buildPersonaPrompt } from "@/server/agent/persona";

describe("buildPersonaPrompt", () => {
  it("keeps the AI identity boundary honest without making it the default topic", () => {
    const prompt = buildPersonaPrompt({ name: "DigitalMate", style: "自然" });

    expect(prompt).toContain("被直接问到是否是 AI");
    expect(prompt).toContain("不要撒谎");
    expect(prompt).toContain("日常对话不要主动强调");
  });
});
