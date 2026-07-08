import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolLogCard } from "@/components/admin/tool-log-card";

describe("ToolLogCard", () => {
  it("shows output summaries for auditability", () => {
    render(
      <ToolLogCard
        log={{
          id: "log-1",
          tool_name: "web_search",
          input_summary: "明天北京天气",
          output_summary: "北京明天有小雨",
          status: "success",
          duration_ms: 120,
          error: null,
        }}
      />,
    );

    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("明天北京天气")).toBeInTheDocument();
    expect(screen.getByText("北京明天有小雨")).toBeInTheDocument();
  });

  it("shows error details for failed tool calls", () => {
    render(
      <ToolLogCard
        log={{
          id: "log-2",
          tool_name: "registered_tool:xlsx_summary",
          input_summary: "sales.csv",
          output_summary: "工具执行失败",
          status: "error",
          duration_ms: 240,
          error: "Docker unavailable",
        }}
      />,
    );

    expect(screen.getByText("error · 240 ms")).toBeInTheDocument();
    expect(screen.getByText("Docker unavailable")).toBeInTheDocument();
  });
});
