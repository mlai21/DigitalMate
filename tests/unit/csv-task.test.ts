import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { buildCsvSummaryFiles, buildCsvSummaryReport, buildSpreadsheetSummaryReport, summarizeCsv } from "@/server/tasks/csv";

describe("summarizeCsv", () => {
  it("summarizes headers, row count and numeric totals", () => {
    const summary = summarizeCsv("region,amount\nEast,10\nWest,20\nEast,5\n");

    expect(summary.headers).toEqual(["region", "amount"]);
    expect(summary.rowCount).toBe(3);
    expect(summary.numericTotals).toEqual({ amount: 35 });
  });

  it("summarizes numeric totals by categorical columns", () => {
    const summary = summarizeCsv("region,product,amount,units\nEast,A,10,1\nWest,B,20,2\nEast,B,5,3\n");

    expect(summary.groupedTotals.region).toEqual({
      East: { amount: 15, units: 4 },
      West: { amount: 20, units: 2 },
    });

    const report = buildCsvSummaryReport("region,product,amount,units\nEast,A,10,1\nWest,B,20,2\nEast,B,5,3\n");
    const text = report.buffer.toString("utf8");
    expect(text).toContain("## 按 region 汇总");
    expect(text).toContain("- East：amount 15、units 4");
    expect(text).toContain("- West：amount 20、units 2");
  });

  it("builds a markdown report and svg chart for numeric grouped summaries", () => {
    const files = buildCsvSummaryFiles("region,amount\nEast,10\nWest,20\nEast,5\n");

    expect(files.map((file) => file.fileName)).toEqual(["csv-summary.md", "csv-summary-chart.svg"]);
    const chart = files.find((file) => file.fileName === "csv-summary-chart.svg");
    expect(chart?.mimeType).toBe("image/svg+xml; charset=utf-8");
    expect(chart?.buffer.toString("utf8")).toContain("<svg");
    expect(chart?.buffer.toString("utf8")).toContain("East");
    expect(chart?.buffer.toString("utf8")).toContain("West");
    expect(chart?.buffer.toString("utf8")).toContain("amount");
  });

  it("builds a summary report from xlsx workbooks", async () => {
    const report = await buildSpreadsheetSummaryReport({
      fileName: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildTinyXlsx(),
    });

    expect(report.fileName).toBe("spreadsheet-summary.md");
    expect(report.buffer.toString("utf8")).toContain("行数：2");
    expect(report.buffer.toString("utf8")).toContain("amount：30");
  });
});

function buildTinyXlsx(): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>region</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>East</t></is></c><c r="B2"><v>10</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>West</t></is></c><c r="B3"><v>20</v></c></row>
  </sheetData>
</worksheet>`),
  };

  return Buffer.from(zipSync(files));
}
