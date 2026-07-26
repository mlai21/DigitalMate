import { describe, expect, it, vi } from "vitest";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createCreateSkillHandler,
  createListMcpClientsHandler,
  createListSkillsHandler,
  createListToolsHandler,
  createSetSkillEnabledHandler,
  createSaveSkillHandler,
} from "@/server/admin/compat/handlers/agent-resources";
import {
  projectMcpClient,
  projectSkill,
  projectTool,
  type AdminAgentResourcesService,
} from "@/server/admin/views/agent-resources";
import { UPSTREAM_API_CONTRACT } from "@/server/admin/compat/upstream-contract";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};
const skillId = "10000000-0000-4000-8000-000000000021";

describe("admin compatibility agent resources", () => {
  it("Skills 投影保留版本、来源与当前分身授权，不返回扫描原始载荷", () => {
    const projected = projectSkill({
      id: skillId,
      name: "周报",
      trigger: "整理一周进展",
      content: "# Weekly",
      status: "enabled",
      source: "imported",
      sourceUrl: "https://github.com/example/weekly",
      version: 2,
      revision: 4,
      usageCount: 3,
      lastUsedAt: new Date("2026-07-27T01:00:00Z"),
      updatedAt: new Date("2026-07-27T02:00:00Z"),
      granted: true,
      scanVerdict: "safe",
    });

    expect(projected).toMatchObject({
      id: skillId,
      name: "周报",
      description: "整理一周进展",
      version_text: "2",
      revision: 4,
      enabled: true,
      source: "imported",
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /raw|prompt|authorization|Bearer /i,
    );
  });

  it("Skill 启用必须显式确认、携带 revision 与操作 ID", async () => {
    const setSkillEnabled = vi
      .fn<AdminAgentResourcesService["setSkillEnabled"]>()
      .mockResolvedValue(
        projectSkill({
          id: skillId,
          name: "周报",
          trigger: "整理一周进展",
          content: "# Weekly",
          status: "enabled",
          source: "manual",
          sourceUrl: null,
          version: 1,
          revision: 5,
          usageCount: 0,
          lastUsedAt: null,
          updatedAt: new Date("2026-07-27T02:00:00Z"),
          granted: true,
          scanVerdict: null,
        }),
      );
    const handler = createSetSkillEnabledHandler(
      { setSkillEnabled } as unknown as AdminAgentResourcesService,
      true,
    );
    const base = {
      revision: 4,
      operation_id:
        "10000000-0000-4000-8000-000000000099",
    };

    await expect(
      handler(
        context(
          "POST",
          "/skills/weekly/enable",
          { ...base, confirmed: false },
          { skillName: "weekly" },
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "confirmation_required",
    });
    await handler(
      context(
        "POST",
        "/skills/weekly/enable",
        { ...base, confirmed: true },
        { skillName: "weekly" },
      ),
    );
    expect(setSkillEnabled).toHaveBeenCalledWith(
      scope,
      "weekly",
      true,
      {
        expectedRevision: 4,
        operationId: base.operation_id,
        confirmed: true,
      },
      expect.any(AbortSignal),
    );
  });

  it("手动创建 Skill 可映射现有能力，但直接启用仍需明确确认", async () => {
    const createSkill = vi
      .fn<AdminAgentResourcesService["createSkill"]>()
      .mockResolvedValue({
        created: true,
        name: "周报",
        enabled: true,
        approval_status: "enabled",
      });
    const handler = createCreateSkillHandler({
      createSkill,
    } as unknown as AdminAgentResourcesService);
    const body = {
      name: "周报",
      content: "---\nname: 周报\ndescription: 整理进展\n---\n# 周报",
      enable: true,
      operation_id:
        "10000000-0000-4000-8000-000000000097",
    };

    await expect(
      handler(
        context("POST", "/skills", {
          ...body,
          confirmed: false,
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "confirmation_required",
    });
    await handler(
      context("POST", "/skills", {
        ...body,
        confirmed: true,
      }),
    );
    expect(createSkill).toHaveBeenCalledWith(
      scope,
      {
        name: "周报",
        content: body.content,
        enabled: true,
      },
      {
        operationId: body.operation_id,
        confirmed: true,
      },
      expect.any(AbortSignal),
    );
  });

  it("编辑 Skill 只创建待审批修订，不直接覆盖已启用内容", async () => {
    const proposeSkillRevision = vi
      .fn<AdminAgentResourcesService["proposeSkillRevision"]>()
      .mockResolvedValue({
        success: true,
        mode: "edit",
        name: "周报",
        approval_status: "pending",
        revision_id:
          "10000000-0000-4000-8000-000000000029",
      });
    const handler = createSaveSkillHandler({
      proposeSkillRevision,
    } as unknown as AdminAgentResourcesService);
    const operationId =
      "10000000-0000-4000-8000-000000000096";
    await handler(
      context("PUT", "/skills/save", {
        name: "周报",
        source_name: "周报",
        content: "# 周报\n\n加入风险项。",
        revision: 4,
        operation_id: operationId,
        confirmed: true,
      }),
    );

    expect(proposeSkillRevision).toHaveBeenCalledWith(
      scope,
      "周报",
      {
        content: "# 周报\n\n加入风险项。",
        expectedRevision: 4,
        operationId,
        confirmed: true,
      },
      expect.any(AbortSignal),
    );
  });

  it("Tools 与 MCP 只暴露脱敏注册状态和权限，不返回命令、env 或凭据", async () => {
    const tool = projectTool({
      id: "10000000-0000-4000-8000-000000000031",
      name: "calendar",
      description: "读取日历",
      kind: "script",
      mcpToolName: null,
      status: "enabled",
      requiresConfirmation: true,
      revision: 3,
      granted: true,
      commandConfigured: true,
    });
    const mcp = projectMcpClient({
      id: "10000000-0000-4000-8000-000000000032",
      name: "notion_search",
      description: "查询笔记",
      kind: "mcp",
      mcpToolName: "search",
      status: "disabled",
      requiresConfirmation: true,
      revision: 2,
      granted: false,
      commandConfigured: true,
    });
    const service = {
      listTools: vi.fn().mockResolvedValue([tool]),
      listMcpClients: vi.fn().mockResolvedValue([mcp]),
    } as unknown as AdminAgentResourcesService;

    const tools = await createListToolsHandler(service)(
      context("GET", "/tools"),
    );
    const clients = await createListMcpClientsHandler(service)(
      context("GET", "/mcp"),
    );

    expect(tools).toEqual([expect.objectContaining({
      name: "calendar",
      enabled: true,
      requires_confirmation: true,
      command_configured: true,
    })]);
    expect(clients).toEqual([expect.objectContaining({
      key: "10000000-0000-4000-8000-000000000032",
      enabled: false,
      tools: ["search"],
    })]);
    expect(JSON.stringify({ tools, clients })).not.toMatch(
      /command":|DATABASE_URL|APP_SECRET|Bearer |"env":\{"|ciphertext|nonce/i,
    );
  });

  it("读取端点 mapped，动态 MCP、Tool 执行与 ACP 仍准确禁用", () => {
    expect(endpoint("skill", "GET /skills")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("skill", "POST /skills")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("skill", "PUT /skills/save")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("tools", "GET /tools")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("mcp", "GET /mcp")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("mcp", "POST /mcp")).toMatchObject({
      status: "disabled",
      disabledCode: "p2_sandbox",
    });
    expect(endpoint("tools", "PATCH /tools/:toolName/toggle")).toMatchObject({
      status: "disabled",
      disabledCode: "p2_sandbox",
    });
    expect(UPSTREAM_API_CONTRACT.acp.endpoints.every(
      (contract) => contract.status === "disabled",
    )).toBe(true);
  });

  it("列表 handler 使用当前 agent scope", async () => {
    const listSkills = vi
      .fn<AdminAgentResourcesService["listSkills"]>()
      .mockResolvedValue([]);
    await createListSkillsHandler({
      listSkills,
    } as unknown as AdminAgentResourcesService)(
      context("GET", "/skills"),
    );
    expect(listSkills).toHaveBeenCalledWith(
      scope,
      expect.any(AbortSignal),
    );
  });
});

function endpoint(
  moduleName: "skill" | "tools" | "mcp",
  signature: string,
) {
  const [method, path] = signature.split(" ");
  return UPSTREAM_API_CONTRACT[moduleName].endpoints.find(
    (candidate) =>
      candidate.method === method && candidate.path === path,
  );
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
