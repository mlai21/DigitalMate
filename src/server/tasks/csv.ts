import { readSheet } from "read-excel-file/node";

export type CsvSummary = {
  headers: string[];
  rowCount: number;
  numericTotals: Record<string, number>;
  groupedTotals: Record<string, Record<string, Record<string, number>>>;
};

export type CsvReportFile = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

export function summarizeCsv(csv: string): CsvSummary {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => parseCsvLine(line));
  return summarizeRows(rows);
}

export function summarizeRows(rows: unknown[][]): CsvSummary {
  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((row) => row.some((value) => cellToString(value) !== ""));
  const numericTotals: Record<string, number> = {};
  const groupedTotals: CsvSummary["groupedTotals"] = {};
  const headerNames = headers.map((header, index) => cellToString(header) || `column_${index + 1}`);
  const numericColumnIndexes = new Set<number>();

  for (const row of dataRows) {
    row.forEach((value, index) => {
      const number = cellToNumber(value);
      if (number === null) return;
      numericColumnIndexes.add(index);
      const header = headerNames[index] || `column_${index + 1}`;
      numericTotals[header] = (numericTotals[header] ?? 0) + number;
    });
  }

  for (const row of dataRows) {
    row.forEach((groupValue, groupIndex) => {
      if (numericColumnIndexes.has(groupIndex)) return;
      const groupKey = cellToString(groupValue);
      if (!groupKey) return;
      const groupHeader = headerNames[groupIndex] || `column_${groupIndex + 1}`;
      const bucket = (groupedTotals[groupHeader] ??= {});
      const totals = (bucket[groupKey] ??= {});

      row.forEach((value, index) => {
        if (!numericColumnIndexes.has(index)) return;
        const number = cellToNumber(value);
        if (number === null) return;
        const header = headerNames[index] || `column_${index + 1}`;
        totals[header] = (totals[header] ?? 0) + number;
      });
    });
  }

  return {
    headers: headerNames,
    rowCount: dataRows.length,
    numericTotals,
    groupedTotals,
  };
}

export function buildCsvSummaryReport(csv: string): CsvReportFile {
  return buildSummaryReport("CSV 汇总报告", "csv-summary.md", summarizeCsv(csv));
}

export function buildCsvSummaryFiles(csv: string): CsvReportFile[] {
  return buildSummaryFiles("CSV 汇总报告", "csv-summary", summarizeCsv(csv));
}

export async function buildSpreadsheetSummaryReport(input: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<CsvReportFile> {
  return (await buildSpreadsheetSummaryFiles(input))[0];
}

export async function buildSpreadsheetSummaryFiles(input: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<CsvReportFile[]> {
  const summary = await summarizeSpreadsheetFile(input);
  if (isXlsxFile(input.fileName, input.mimeType)) {
    return buildSummaryFiles("表格汇总报告", "spreadsheet-summary", summary);
  }
  return buildSummaryFiles("CSV 汇总报告", "csv-summary", summary);
}

export async function summarizeSpreadsheetFile(input: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<CsvSummary> {
  if (isXlsxFile(input.fileName, input.mimeType)) {
    const rows = await readSheet(input.buffer);
    return summarizeRows(rows);
  }

  return summarizeCsv(input.buffer.toString("utf8"));
}

function buildSummaryReport(title: string, fileName: string, summary: CsvSummary): CsvReportFile {
  const totals = Object.entries(summary.numericTotals);
  const markdown = [
    `# ${title}`,
    "",
    `表头：${summary.headers.join("、") || "无"}`,
    `行数：${summary.rowCount}`,
    "",
    "## 数值列合计",
    ...(totals.length ? totals.map(([key, value]) => `- ${key}：${value}`) : ["- 无"]),
    "",
    ...formatGroupedTotals(summary.groupedTotals),
    "",
  ].join("\n");

  return {
    fileName,
    mimeType: "text/markdown; charset=utf-8",
    buffer: Buffer.from(markdown, "utf8"),
  };
}

function buildSummaryFiles(title: string, baseFileName: string, summary: CsvSummary): CsvReportFile[] {
  const files = [buildSummaryReport(title, `${baseFileName}.md`, summary)];
  const chart = buildSummaryChart(summary, `${baseFileName}-chart.svg`);
  if (chart) files.push(chart);
  return files;
}

function buildSummaryChart(summary: CsvSummary, fileName: string): CsvReportFile | null {
  const chartData = firstGroupedChartData(summary);
  if (!chartData) return null;

  const width = 720;
  const height = 420;
  const margin = { top: 56, right: 32, bottom: 76, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...chartData.rows.map((row) => row.value), 1);
  const barWidth = Math.max(20, plotWidth / chartData.rows.length - 18);

  const bars = chartData.rows
    .map((row, index) => {
      const x = margin.left + index * (plotWidth / chartData.rows.length) + 9;
      const barHeight = (row.value / maxValue) * plotHeight;
      const y = margin.top + plotHeight - barHeight;
      return [
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="4" fill="#e8684a" />`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="13" fill="#2d2a26">${formatNumber(row.value)}</text>`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 36}" text-anchor="middle" font-size="13" fill="#5f5850">${escapeXml(row.label)}</text>`,
      ].join("\n");
    })
    .join("\n");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(chartData.title)}">`,
    `<rect width="100%" height="100%" fill="#faf7f2" />`,
    `<text x="${margin.left}" y="34" font-size="22" font-weight="700" fill="#2d2a26">${escapeXml(chartData.title)}</text>`,
    `<text x="${margin.left}" y="56" font-size="13" fill="#6e675f">按 ${escapeXml(chartData.groupHeader)} 汇总 ${escapeXml(chartData.measure)}</text>`,
    `<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}" stroke="#d8d0c7" />`,
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#d8d0c7" />`,
    bars,
    "</svg>",
    "",
  ].join("\n");

  return {
    fileName,
    mimeType: "image/svg+xml; charset=utf-8",
    buffer: Buffer.from(svg, "utf8"),
  };
}

function firstGroupedChartData(summary: CsvSummary): {
  title: string;
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
    return {
      title: "表格图表",
      groupHeader,
      measure,
      rows,
    };
  }
  return null;
}

function formatGroupedTotals(groupedTotals: CsvSummary["groupedTotals"]): string[] {
  return Object.entries(groupedTotals).flatMap(([groupHeader, groups]) => [
    `## 按 ${groupHeader} 汇总`,
    ...Object.entries(groups).map(([group, totals]) => {
      const values = Object.entries(totals).map(([key, value]) => `${key} ${value}`);
      return `- ${group}：${values.join("、") || "无"}`;
    }),
    "",
  ]);
}

function isXlsxFile(fileName: string, mimeType: string): boolean {
  return (
    fileName.toLowerCase().endsWith(".xlsx") ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function cellToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
