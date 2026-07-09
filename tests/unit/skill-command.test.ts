import { describe, expect, it } from "vitest";
import { buildExplicitSkillFallbackMessage, parseSlashCommand } from "@/server/agent/skill-command";

describe("parseSlashCommand", () => {
  it("returns null for plain messages", () => {
    expect(parseSlashCommand("今天天气不错")).toBeNull();
    expect(parseSlashCommand("路径是 /usr/local，不是指令")).toBeNull();
  });

  it("parses the create-skill command with and without extra text", () => {
    expect(parseSlashCommand("/create-skill")).toEqual({ kind: "create_skill", rest: "" });
    expect(parseSlashCommand("/create-skill 我想沉淀周报的做法")).toEqual({
      kind: "create_skill",
      rest: "我想沉淀周报的做法",
    });
    expect(parseSlashCommand("/create_skill 兼容下划线")).toEqual({ kind: "create_skill", rest: "兼容下划线" });
  });

  it("parses explicit skill invocation with the remaining text", () => {
    expect(parseSlashCommand("/周报整理 帮我把这周的更新整理一下")).toEqual({
      kind: "use_skill",
      name: "周报整理",
      rest: "帮我把这周的更新整理一下",
    });
    expect(parseSlashCommand("/nuwa")).toEqual({ kind: "use_skill", name: "nuwa", rest: "" });
  });

  it("tolerates leading whitespace", () => {
    expect(parseSlashCommand("  /create-skill 试试")).toEqual({ kind: "create_skill", rest: "试试" });
  });
});

describe("buildExplicitSkillFallbackMessage", () => {
  it("builds a usable default instruction", () => {
    expect(buildExplicitSkillFallbackMessage("周报整理")).toContain("周报整理");
  });
});
