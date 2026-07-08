import { describe, expect, it } from "vitest";
import { buildReflectionPrompt, normalizeReflection } from "@/server/evolution/reflection";
import { createSkillDraft, createTaskSkillDraft } from "@/server/evolution/skills";

describe("reflection helpers", () => {
  it("builds a private reflection prompt without exposing it to chat output", () => {
    const prompt = buildReflectionPrompt({
      messages: ["用户说最近在准备演讲", "助手问演讲练得怎么样"],
      toolFailures: ["web_search timeout"],
    });

    expect(prompt).toContain("只写入后台反思记录");
    expect(prompt).toContain("web_search timeout");
  });

  it("normalizes structured reflection records", () => {
    expect(normalizeReflection("做得好：记住了演讲。需要改进：少追问。建议：降低主动频率。")).toEqual({
      positives: ["记住了演讲"],
      negatives: ["少追问"],
      suggestions: ["降低主动频率"],
    });
  });
});

describe("createSkillDraft", () => {
  it("creates pending skill drafts that require user confirmation", () => {
    const draft = createSkillDraft({
      name: "信息整理",
      trigger: "整理搜索结果",
      steps: ["确认问题", "联网搜索", "按来源摘要"],
    });

    expect(draft.status).toBe("pending");
    expect(draft.content).toContain("## 适用场景");
    expect(draft.content).toContain("整理搜索结果");
  });

  it("creates pending skill drafts from completed task runs", () => {
    const draft = createTaskSkillDraft({
      kind: "presentation",
      inputSummary: "PPT 生成：周报",
      outputSummary: "PPT 文件已生成。",
    });

    expect(draft.status).toBe("pending");
    expect(draft.name).toBe("PPT 生成任务流程");
    expect(draft.trigger).toContain("PPT 生成：周报");
    expect(draft.content).toContain("将大纲拆成幻灯片");
    expect(draft.content).toContain("如有 CSV 或 Excel 数据素材");
    expect(draft.content).toContain("生成数据概览和分组图表页");
    expect(draft.content).toContain("启用前需要用户在后台确认。");
  });

  it("captures spreadsheet reports with grouped summaries and chart artifacts", () => {
    const draft = createTaskSkillDraft({
      kind: "spreadsheet",
      inputSummary: "表格汇总：sales.xlsx",
      outputSummary: "表格汇总报告和图表已生成。",
    });

    expect(draft.name).toBe("表格汇总任务流程");
    expect(draft.content).toContain("按分类列生成分组汇总");
    expect(draft.content).toContain("生成 SVG 图表");
    expect(draft.content).toContain("保存报告和图表供用户下载");
  });
});
