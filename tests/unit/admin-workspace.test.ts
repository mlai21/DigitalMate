import { describe, expect, it, vi } from "vitest";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createGetWorkspaceFileHandler,
  createListWorkspaceFilesHandler,
  createPutWorkspaceFileHandler,
} from "@/server/admin/compat/handlers/workspace";
import {
  VIRTUAL_FILES,
  normalizeVirtualFilePath,
  parseAgentVirtualFile,
  parseProactivityVirtualFile,
  serializeAgentVirtualFile,
  serializeProactivityVirtualFile,
} from "@/server/admin/workspace/files";
import {
  AdminWorkspaceError,
  type AdminWorkspaceService,
} from "@/server/admin/workspace/service";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin virtual workspace", () => {
  it("只暴露四个数据库投影文件，且不包含凭据、路径或系统提示", async () => {
    expect(Object.keys(VIRTUAL_FILES)).toEqual([
      "/AGENT.md",
      "/PROACTIVITY.md",
      "/CHANNELS.md",
      "/RUNTIME.json",
    ]);

    const list = vi.fn<AdminWorkspaceService["list"]>().mockResolvedValue([
      workspaceFile("/AGENT.md", true),
      workspaceFile("/PROACTIVITY.md", true),
      workspaceFile("/CHANNELS.md", false),
      workspaceFile("/RUNTIME.json", false),
    ]);
    const handler = createListWorkspaceFilesHandler({
      list,
    } as unknown as AdminWorkspaceService);
    const result = await handler(context("GET", "/workspace/files"));

    expect(result).toEqual([
      expect.objectContaining({ path: "/AGENT.md", writable: true }),
      expect.objectContaining({ path: "/PROACTIVITY.md", writable: true }),
      expect.objectContaining({ path: "/CHANNELS.md", writable: false }),
      expect.objectContaining({ path: "/RUNTIME.json", writable: false }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /DATABASE_URL|APP_SECRET|storage_key|system prompt|ciphertext|nonce/i,
    );
  });

  it("AGENT 与 PROACTIVITY 文件可严格往返且携带 revision", () => {
    const agentContent = serializeAgentVirtualFile({
      revision: 7,
      displayName: "DigitalMate",
      persona: {
        name: "小数",
        style: "温暖、克制",
        emojiHabit: "少量使用",
      },
    });
    expect(parseAgentVirtualFile(agentContent)).toEqual({
      revision: 7,
      displayName: "DigitalMate",
      persona: {
        name: "小数",
        style: "温暖、克制",
        emojiHabit: "少量使用",
      },
    });

    const proactivityContent = serializeProactivityVirtualFile({
      revision: 8,
      proactivity: {
        quietStart: "23:00",
        quietEnd: "08:00",
        minIntervalMinutes: 30,
        maxPerHour: 2,
        maxPerDay: 3,
      },
    });
    expect(parseProactivityVirtualFile(proactivityContent)).toEqual({
      revision: 8,
      proactivity: {
        quietStart: "23:00",
        quietEnd: "08:00",
        minIntervalMinutes: 30,
        maxPerHour: 2,
        maxPerDay: 3,
      },
    });
    expect(() =>
      parseAgentVirtualFile(`${agentContent}\nDATABASE_URL: "secret"`),
    ).toThrow("virtual_file_invalid_format");
  });

  it("拒绝路径穿越、未知文件和只读文件写入", async () => {
    for (const path of [
      "../AGENT.md",
      "%2e%2e%2fAGENT.md",
      "/nested/AGENT.md",
      "/UNKNOWN.md",
      "AGENT.md\u0000",
    ]) {
      expect(() => normalizeVirtualFilePath(path)).toThrow(
        "virtual_file_not_found",
      );
    }

    const read = vi
      .fn<AdminWorkspaceService["read"]>()
      .mockRejectedValue(
        new AdminWorkspaceError(404, "virtual_file_not_found"),
      );
    const readHandler = createGetWorkspaceFileHandler({
      read,
    } as unknown as AdminWorkspaceService);
    await expect(
      readHandler(
        context(
          "GET",
          "/workspace/files/..%2FAGENT.md",
          undefined,
          { fileName: "../AGENT.md" },
        ),
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });

    const write = vi
      .fn<AdminWorkspaceService["write"]>()
      .mockRejectedValue(
        new AdminWorkspaceError(405, "virtual_file_read_only"),
      );
    const writeHandler = createPutWorkspaceFileHandler({
      write,
    } as unknown as AdminWorkspaceService);
    await expect(
      writeHandler(
        context(
          "PUT",
          "/workspace/files/CHANNELS.md",
          {
            content: "# channels",
            operation_id:
              "10000000-0000-4000-8000-000000000099",
          },
          { fileName: "CHANNELS.md" },
        ),
      ),
    ).rejects.toMatchObject({
      status: 405,
      code: "method_not_allowed",
    });
  });

  it("写回沿用文件 revision，冲突稳定返回 409", async () => {
    const write = vi
      .fn<AdminWorkspaceService["write"]>()
      .mockRejectedValue(
        new AdminWorkspaceError(409, "revision_conflict"),
      );
    const handler = createPutWorkspaceFileHandler({
      write,
    } as unknown as AdminWorkspaceService);
    const content = serializeAgentVirtualFile({
      revision: 3,
      displayName: "DigitalMate",
      persona: {
        name: "小数",
        style: "自然",
        emojiHabit: "少量",
      },
    });

    await expect(
      handler(
        context(
          "PUT",
          "/workspace/files/AGENT.md",
          {
            content,
            operation_id:
              "10000000-0000-4000-8000-000000000098",
          },
          { fileName: "AGENT.md" },
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
    expect(write).toHaveBeenCalledWith(
      scope,
      "/AGENT.md",
      expect.objectContaining({
        expectedRevision: 3,
      }),
      expect.any(AbortSignal),
    );
  });
});

function workspaceFile(path: keyof typeof VIRTUAL_FILES, writable: boolean) {
  return {
    filename: path.slice(1),
    path,
    size: 10,
    created_time: "2026-07-27T00:00:00.000Z",
    modified_time: "2026-07-27T00:00:00.000Z",
    writable,
    source: VIRTUAL_FILES[path].source,
  };
}

function context(
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): AdminCompatContext {
  return {
    request: new Request(
      `https://mate.example/api/admin/compat${path}`,
      {
        method,
        headers:
          body === undefined
            ? undefined
            : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ),
    params,
    scope,
    csrfVerified: method === "GET",
    resources: {} as AdminCompatContext["resources"],
    signal: new AbortController().signal,
  };
}
