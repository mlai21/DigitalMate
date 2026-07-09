import { describe, expect, it } from "vitest";
import { buildSkillBody, parseSkillMd, serializeSkillMd } from "@/server/skills/skill-md";
import { createSkillDraft } from "@/server/evolution/skills";

describe("parseSkillMd", () => {
  it("parses agentskills.io frontmatter with name and description", () => {
    const raw = [
      "---",
      "name: 周报整理",
      "description: 把零散更新整理成周报",
      "license: MIT",
      "---",
      "",
      "# 周报整理",
      "",
      "## 步骤",
      "1. 收集更新",
    ].join("\n");

    const document = parseSkillMd(raw);

    expect(document?.name).toBe("周报整理");
    expect(document?.description).toBe("把零散更新整理成周报");
    expect(document?.metadata.license).toBe("MIT");
    expect(document?.body).toContain("## 步骤");
    expect(document?.body).not.toContain("---");
  });

  it("falls back to the first heading and paragraph without frontmatter", () => {
    const document = parseSkillMd("# 数据清洗\n\n处理上传的脏数据。\n\n## 步骤\n1. 检查编码");

    expect(document?.name).toBe("数据清洗");
    expect(document?.description).toBe("处理上传的脏数据。");
  });

  it("strips quotes from frontmatter values", () => {
    const document = parseSkillMd('---\nname: "引号技能"\ndescription: \'场景\'\n---\n\n# 引号技能');

    expect(document?.name).toBe("引号技能");
    expect(document?.description).toBe("场景");
  });

  it("returns null for empty or nameless content", () => {
    expect(parseSkillMd("")).toBeNull();
    expect(parseSkillMd("没有标题的普通段落")).toBeNull();
  });
});

describe("serializeSkillMd", () => {
  it("round-trips through parseSkillMd", () => {
    const raw = serializeSkillMd({
      name: "信息整理",
      description: "整理搜索结果并输出摘要",
      body: buildSkillBody({
        name: "信息整理",
        scenario: "整理搜索结果并输出摘要",
        steps: ["确认目标", "联网搜索", "输出结论"],
      }),
    });

    const document = parseSkillMd(raw);

    expect(document?.name).toBe("信息整理");
    expect(document?.description).toBe("整理搜索结果并输出摘要");
    expect(document?.body).toContain("1. 确认目标");
    expect(document?.body).toContain("## 注意事项");
  });

  it("quotes frontmatter values containing special characters", () => {
    const raw = serializeSkillMd({ name: "带冒号: 的名字", description: "描述", body: "# 带冒号: 的名字" });

    expect(raw).toContain('name: "带冒号: 的名字"');
    expect(parseSkillMd(raw)?.name).toBe("带冒号: 的名字");
  });
});

describe("createSkillDraft", () => {
  it("produces SKILL.md formatted content with frontmatter", () => {
    const draft = createSkillDraft({
      name: "信息整理",
      trigger: "整理搜索结果",
      steps: ["确认目标", "输出结论"],
      source: "agent",
    });

    expect(draft.source).toBe("agent");
    const document = parseSkillMd(draft.content);
    expect(document?.name).toBe("信息整理");
    expect(document?.description).toBe("整理搜索结果");
  });
});
