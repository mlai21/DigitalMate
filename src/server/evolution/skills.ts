export type SkillDraftInput = {
  name: string;
  trigger: string;
  steps: string[];
};

export type SkillDraft = {
  name: string;
  trigger: string;
  content: string;
  status: "pending";
};

export type TaskSkillDraftInput = {
  kind: "sandbox" | "spreadsheet" | "presentation";
  inputSummary: string;
  outputSummary: string;
};

export function createSkillDraft(input: SkillDraftInput): SkillDraft {
  return {
    name: input.name,
    trigger: input.trigger,
    status: "pending",
    content: [
      `# ${input.name}`,
      "",
      "## 适用场景",
      input.trigger,
      "",
      "## 步骤",
      ...input.steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      "## 注意事项",
      "启用前需要用户在后台确认。",
    ].join("\n"),
  };
}

export function createTaskSkillDraft(input: TaskSkillDraftInput): SkillDraft {
  const configs: Record<TaskSkillDraftInput["kind"], { name: string; triggerPrefix: string; steps: string[] }> = {
    sandbox: {
      name: "沙箱任务执行流程",
      triggerPrefix: "需要再次执行类似的安全沙箱任务",
      steps: ["确认脚本符合安全策略", "在无网络容器沙箱中执行脚本", "整理 stdout 和 stderr", "保存输出文件供用户下载"],
    },
    spreadsheet: {
      name: "表格汇总任务流程",
      triggerPrefix: "需要再次处理类似的 CSV 或 Excel 表格汇总任务",
      steps: [
        "确认上传文件类型",
        "读取 CSV 或 Excel 工作簿",
        "统计表头、行数、数值列合计，并按分类列生成分组汇总",
        "生成 Markdown 汇总报告",
        "根据分组汇总生成 SVG 图表",
        "保存报告和图表供用户下载",
      ],
    },
    presentation: {
      name: "PPT 生成任务流程",
      triggerPrefix: "需要再次生成类似的 PPT 汇报文件",
      steps: [
        "确认标题和页面大纲",
        "将大纲拆成幻灯片",
        "如有 CSV 或 Excel 数据素材，先生成数据概览和分组图表页",
        "生成 PPTX 文件",
        "保存产物供用户下载",
      ],
    },
  };
  const config = configs[input.kind];
  return createSkillDraft({
    name: config.name,
    trigger: `${config.triggerPrefix}：${input.inputSummary}`,
    steps: [...config.steps, `本次结果参考：${input.outputSummary}`],
  });
}
