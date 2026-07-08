import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { summarizeCsv } from "@/server/tasks/csv";
import { buildPresentation } from "@/server/tasks/presentation";

describe("buildPresentation", () => {
  it("creates a pptx buffer from slide outlines", async () => {
    const file = await buildPresentation({
      title: "周报",
      slides: [
        { title: "本周进展", bullets: ["完成聊天 MVP", "接入长期记忆"] },
        { title: "下周计划", bullets: ["完善 IM 渠道", "验证任务沙箱"] },
      ],
    });

    expect(file.fileName).toBe("周报.pptx");
    expect(file.mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(file.buffer.byteLength).toBeGreaterThan(1000);
  });

  it("adds spreadsheet data overview and chart slides when data is provided", async () => {
    const file = await buildPresentation({
      title: "销售汇报",
      slides: [{ title: "结论", bullets: ["华东表现最好"] }],
      dataSummary: summarizeCsv("region,amount\n华东,120\n华南,80\n"),
    });

    const text = pptxText(file.buffer);
    expect(text).toContain("数据概览");
    expect(text).toContain("行数：2");
    expect(text).toContain("分组图表");
    expect(text).toContain("华东");
    expect(text).toContain("120");
  });
});

function pptxText(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  return Object.entries(files)
    .filter(([path]) => path.startsWith("ppt/slides/") && path.endsWith(".xml"))
    .map(([, content]) => strFromU8(content))
    .join("\n");
}
