import pptxgen from "pptxgenjs";
import type { CsvSummary } from "@/server/tasks/csv";

export type PresentationInput = {
  title: string;
  dataSummary?: CsvSummary;
  slides: Array<{
    title: string;
    bullets: string[];
  }>;
};

export type PresentationFile = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

type Pptx = InstanceType<typeof pptxgen>;

export function parsePresentationOutline(outline: string): PresentationInput["slides"] {
  return outline
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [title = "未命名页面", ...lines] = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const bullets = lines
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
      return { title, bullets };
    });
}

export async function buildPresentation(input: PresentationInput): Promise<PresentationFile> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "DigitalMate";
  pptx.subject = input.title;
  pptx.title = input.title;
  pptx.company = "DigitalMate";
  pptx.theme = {
    headFontFace: "PingFang SC",
    bodyFontFace: "PingFang SC",
  };

  const cover = pptx.addSlide();
  cover.background = { color: "FAF7F2" };
  cover.addText(input.title, {
    x: 0.8,
    y: 1.9,
    w: 11.6,
    h: 0.8,
    fontFace: "PingFang SC",
    fontSize: 34,
    bold: true,
    color: "2D2A26",
    margin: 0,
  });
  cover.addText("DigitalMate 自动生成", {
    x: 0.82,
    y: 2.85,
    w: 8,
    h: 0.4,
    fontSize: 15,
    color: "6E675F",
    margin: 0,
  });

  if (input.dataSummary) {
    addDataOverviewSlide(pptx, input.dataSummary);
    addDataChartSlide(pptx, input.dataSummary);
  }

  for (const slideInput of input.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: "FAF7F2" };
    slide.addText(slideInput.title, {
      x: 0.7,
      y: 0.55,
      w: 11.8,
      h: 0.5,
      fontSize: 24,
      bold: true,
      color: "2D2A26",
      margin: 0,
    });
    slide.addText(
      slideInput.bullets.map((bullet) => ({ text: bullet, options: { bullet: { type: "bullet" } } })),
      {
        x: 0.95,
        y: 1.45,
        w: 11.2,
        h: 4.8,
        fontSize: 17,
        color: "2D2A26",
        breakLine: false,
        fit: "shrink",
        paraSpaceAfter: 12,
      },
    );
  }

  const data = await pptx.write({ outputType: "nodebuffer" });
  return {
    fileName: `${safeFileName(input.title)}.pptx`,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
  };
}

function addDataOverviewSlide(pptx: Pptx, summary: CsvSummary): void {
  const slide = pptx.addSlide();
  slide.background = { color: "FAF7F2" };
  slide.addText("数据概览", {
    x: 0.7,
    y: 0.55,
    w: 11.8,
    h: 0.5,
    fontSize: 24,
    bold: true,
    color: "2D2A26",
    margin: 0,
  });

  const totals = Object.entries(summary.numericTotals)
    .slice(0, 6)
    .map(([key, value]) => `${key}：${formatNumber(value)}`);
  const bullets = [
    `行数：${summary.rowCount}`,
    `字段：${summary.headers.join("、") || "无"}`,
    ...(totals.length ? totals.map((total) => `合计 ${total}`) : ["没有可汇总的数值列"]),
  ];

  slide.addText(
    bullets.map((bullet) => ({ text: bullet, options: { bullet: { type: "bullet" } } })),
    {
      x: 0.95,
      y: 1.45,
      w: 11.2,
      h: 4.8,
      fontSize: 17,
      color: "2D2A26",
      breakLine: false,
      fit: "shrink",
      paraSpaceAfter: 12,
    },
  );
}

function addDataChartSlide(pptx: Pptx, summary: CsvSummary): void {
  const chartData = firstPresentationChartData(summary);
  if (!chartData) return;

  const slide = pptx.addSlide();
  slide.background = { color: "FAF7F2" };
  slide.addText("分组图表", {
    x: 0.7,
    y: 0.55,
    w: 11.8,
    h: 0.5,
    fontSize: 24,
    bold: true,
    color: "2D2A26",
    margin: 0,
  });
  slide.addText(`按 ${chartData.groupHeader} 汇总 ${chartData.measure}`, {
    x: 0.72,
    y: 1.08,
    w: 10.8,
    h: 0.3,
    fontSize: 13,
    color: "6E675F",
    margin: 0,
  });

  const baseY = 5.72;
  const chartX = 0.95;
  const chartWidth = 11;
  const maxValue = Math.max(...chartData.rows.map((row) => row.value), 1);
  const slotWidth = chartWidth / chartData.rows.length;
  const barWidth = Math.min(0.95, Math.max(0.35, slotWidth * 0.56));
  slide.addShape(pptx.ShapeType.line, {
    x: chartX,
    y: baseY,
    w: chartWidth,
    h: 0,
    line: { color: "D8D0C7", width: 1 },
  });

  chartData.rows.forEach((row, index) => {
    const barHeight = (row.value / maxValue) * 3.5;
    const x = chartX + index * slotWidth + (slotWidth - barWidth) / 2;
    const y = baseY - barHeight;
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: barWidth,
      h: Math.max(0.08, barHeight),
      fill: { color: "E8684A" },
      line: { color: "E8684A" },
    });
    slide.addText(formatNumber(row.value), {
      x: x - 0.15,
      y: y - 0.28,
      w: barWidth + 0.3,
      h: 0.22,
      align: "center",
      fontSize: 11,
      color: "2D2A26",
      margin: 0,
    });
    slide.addText(row.label, {
      x: x - 0.25,
      y: baseY + 0.16,
      w: barWidth + 0.5,
      h: 0.45,
      align: "center",
      fontSize: 11,
      color: "5F5850",
      margin: 0,
      fit: "shrink",
    });
  });
}

function firstPresentationChartData(summary: CsvSummary): {
  groupHeader: string;
  measure: string;
  rows: Array<{ label: string; value: number }>;
} | null {
  for (const [groupHeader, groups] of Object.entries(summary.groupedTotals)) {
    const firstTotals = Object.values(groups)[0];
    const measure = firstTotals ? Object.keys(firstTotals)[0] : undefined;
    if (!measure) continue;
    const rows = Object.entries(groups)
      .map(([label, totals]) => ({ label, value: totals[measure] ?? 0 }))
      .filter((row) => row.value > 0)
      .slice(0, 8);
    if (rows.length === 0) continue;
    return { groupHeader, measure, rows };
  }
  return null;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "presentation";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
