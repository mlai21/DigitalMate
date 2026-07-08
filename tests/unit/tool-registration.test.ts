import { describe, expect, it } from "vitest";
import { createToolRegistrationDraft, mcpToolResultToText } from "@/server/tasks/tools";

describe("createToolRegistrationDraft", () => {
  it("defaults new tools to pending confirmation", () => {
    const draft = createToolRegistrationDraft({
      name: "xlsx_summary",
      description: "Summarize uploaded spreadsheets",
      command: "node tools/xlsx-summary.js",
    });

    expect(draft.status).toBe("pending");
    expect(draft.requiresConfirmation).toBe(true);
  });

  it("can create pending MCP tool registrations", () => {
    const draft = createToolRegistrationDraft({
      name: "search_docs",
      description: "Search project docs through MCP",
      command: "node mcp-server.js",
      kind: "mcp",
      mcpToolName: "search_docs",
    });

    expect(draft.kind).toBe("mcp");
    expect(draft.mcpToolName).toBe("search_docs");
    expect(draft.status).toBe("pending");
  });

  it("normalizes MCP tool text content", () => {
    expect(
      mcpToolResultToText({
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      }),
    ).toBe("第一段\n第二段");
  });
});
