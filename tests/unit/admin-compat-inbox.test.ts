import { describe, expect, it, vi } from "vitest";
import {
  createPostgresAdminInboxService,
  projectAdminInbox,
  toPendingApproval,
  type AdminInboxRecord,
} from "@/server/admin/views/inbox";
import {
  createApprovalCommandHandler,
  createCheckCommandHandler,
  createResolveAccessHandler,
  createUpdateAccessMetadataHandler,
  type AdminInboxService,
} from "@/server/admin/compat/handlers/inbox";
import type { AdminCompatContext } from "@/server/admin/compat/types";

const scopeA = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};
const scopeB = {
  userId: scopeA.userId,
  agentId: "10000000-0000-4000-8000-000000000012",
};

function record(
  input: Partial<AdminInboxRecord> &
    Pick<AdminInboxRecord, "id" | "kind">,
): AdminInboxRecord {
  return {
    id: input.id,
    kind: input.kind,
    agentId: input.agentId ?? scopeA.agentId,
    title: input.title ?? "待确认项目",
    summary: input.summary ?? "安全摘要",
    status: input.status ?? "pending",
    revision: input.revision ?? 1,
    createdAt: input.createdAt ?? new Date("2026-07-27T01:00:00Z"),
    source: input.source ?? {},
  };
}

describe("admin compatibility inbox", () => {
  it("合并三类审批且绝不跨 agent", () => {
    const result = projectAdminInbox(
      scopeA,
      [
        record({
          id: "10000000-0000-4000-8000-000000000101",
          kind: "channel_access",
        }),
        record({
          id: "10000000-0000-4000-8000-000000000102",
          kind: "skill_revision",
          agentId: scopeB.agentId,
        }),
        record({
          id: "10000000-0000-4000-8000-000000000103",
          kind: "tool_registration",
        }),
        record({
          id: "10000000-0000-4000-8000-000000000104",
          kind: "skill_revision",
        }),
      ],
      { status: "pending", cursor: null, limit: 20 },
    );

    expect(result.items.map((item) => item.kind).sort()).toEqual([
      "channel_access",
      "skill_revision",
      "tool_registration",
    ]);
    expect(
      result.items.every((item) => item.agent_id === scopeA.agentId),
    ).toBe(true);
  });

  it("分页游标稳定且公共投影不携带任意源字段", () => {
    const records = [
      record({
        id: "10000000-0000-4000-8000-000000000111",
        kind: "skill_revision",
        createdAt: new Date("2026-07-27T03:00:00Z"),
        source: {
          proposed_content: "API_KEY=secret-value",
          system_prompt: "hidden",
        },
      }),
      record({
        id: "10000000-0000-4000-8000-000000000112",
        kind: "tool_registration",
        createdAt: new Date("2026-07-27T02:00:00Z"),
        source: { command: "curl -H Authorization:secret" },
      }),
    ];
    const first = projectAdminInbox(scopeA, records, {
      status: "pending",
      cursor: null,
      limit: 1,
    });
    const second = projectAdminInbox(scopeA, records, {
      status: "pending",
      cursor: first.next_cursor,
      limit: 1,
    });

    expect(first.items[0]?.id).toBe(
      "10000000-0000-4000-8000-000000000111",
    );
    expect(second.items[0]?.id).toBe(
      "10000000-0000-4000-8000-000000000112",
    );
    expect(JSON.stringify([first, second])).not.toContain("secret-value");
    expect(JSON.stringify([first, second])).not.toContain("system_prompt");
    expect(JSON.stringify([first, second])).not.toContain("Authorization");
  });

  it("把统一审批投影为上游 PendingApproval，参数只含白名单摘要", () => {
    const approval = toPendingApproval(
      record({
        id: "10000000-0000-4000-8000-000000000121",
        kind: "tool_registration",
        title: "启用工具 calendar",
        summary: "工具需要用户确认后启用",
        source: { command: "secret command", tool_name: "calendar" },
      }),
    );

    expect(approval).toMatchObject({
      request_id: "10000000-0000-4000-8000-000000000121",
      agent_id: scopeA.agentId,
      tool_name: "calendar",
      findings_summary: "工具需要用户确认后启用",
      tool_params: {},
    });
    expect(JSON.stringify(approval)).not.toContain("secret command");
  });

  it("审批命令带 scope 与版本写入服务，旧 revision 映射为 409", async () => {
    const resolveApproval = vi
      .fn<AdminInboxService["resolveApproval"]>()
      .mockResolvedValueOnce({ status: "approved", revision: 2 })
      .mockRejectedValueOnce(
        Object.assign(new Error("revision_conflict"), {
          code: "revision_conflict",
          currentRevision: 2,
        }),
      );
    const handler = createApprovalCommandHandler({
      resolveApproval,
    } as unknown as AdminInboxService);
    const createContext = () =>
      ({
        request: new Request(
          "https://mate.example/api/admin/compat/approval/approve",
          {
            method: "POST",
            body: JSON.stringify({
              request_id:
                "10000000-0000-4000-8000-000000000131",
              session_id: scopeA.agentId,
              revision: 1,
              scope: "exact",
            }),
          },
        ),
        params: { action: "approve" },
        scope: scopeA,
        csrfVerified: true,
        resources: {},
        signal: new AbortController().signal,
      }) as unknown as AdminCompatContext;
    const context = createContext();

    await expect(handler(context)).resolves.toMatchObject({
      success: true,
      revision: 2,
    });
    expect(resolveApproval).toHaveBeenCalledWith(
      scopeA,
      expect.objectContaining({
        id: "10000000-0000-4000-8000-000000000131",
        action: "approve",
        expectedRevision: 1,
        confirmationSourceId:
          "10000000-0000-4000-8000-000000000131",
      }),
      context.signal,
    );

    await expect(handler(createContext())).rejects.toMatchObject({
      status: 409,
      code: "config_revision_conflict",
      details: { current_revision: 2 },
    });
  });

  it("访问申请支持带版本 dismiss 与 pending remark", async () => {
    const resolveAccessRequests = vi
      .fn<AdminInboxService["resolveAccessRequests"]>()
      .mockResolvedValue(undefined);
    const updateAccessMetadata = vi
      .fn<AdminInboxService["updateAccessMetadata"]>()
      .mockResolvedValue(undefined);
    const service = {
      resolveAccessRequests,
      updateAccessMetadata,
    } as unknown as AdminInboxService;
    const dismiss = createResolveAccessHandler(
      service,
      "dismiss",
    );
    const remark = createUpdateAccessMetadataHandler(
      service,
      "remark",
      true,
    );
    const signal = new AbortController().signal;
    const entry = {
      channel: "telegram",
      user_id: "external-user-1",
      revision: 4,
    };
    const createContext = (
      path: string,
      body: unknown,
    ): AdminCompatContext =>
      ({
        request: new Request(
          `https://mate.example/api/admin/compat/${path}`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        ),
        params: {},
        scope: scopeA,
        csrfVerified: true,
        resources: {},
        signal,
      }) as unknown as AdminCompatContext;

    await expect(
      dismiss(
        createContext(
          "access-control/pending/dismiss",
          { entries: [entry] },
        ),
      ),
    ).resolves.toEqual({ success: true });
    expect(resolveAccessRequests).toHaveBeenCalledWith(
      scopeA,
      "dismiss",
      [entry],
      signal,
    );

    await expect(
      remark(
        createContext(
          "access-control/pending/remark",
          {
            channel: "telegram",
            user_id: "external-user-1",
            remark: "家人",
          },
        ),
      ),
    ).resolves.toEqual({ success: true });
    expect(updateAccessMetadata).toHaveBeenCalledWith(
      scopeA,
      {
        channel: "telegram",
        userId: "external-user-1",
        field: "remark",
        value: "家人",
        pendingOnly: true,
      },
      signal,
    );
  });

  it("已配置但尚无规则的渠道也能进入访问控制列表", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          channel_type: "telegram",
          target_id: null,
          effect: null,
          remark: null,
          username: null,
        },
      ],
    });
    const service = createPostgresAdminInboxService(
      { query } as never,
    );

    await expect(
      service.listAccessControl(
        scopeA,
        null,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      telegram: {
        whitelist: {},
        blacklist: {},
        pending: [],
      },
    });
  });

  it("命令检查同时返回当前分身已启用 Skill 的 slash catalog", async () => {
    const listEnabledForAgent = vi.fn().mockResolvedValue([
      {
        id: "10000000-0000-4000-8000-000000000201",
        name: "Weekly Report",
        trigger: "整理一周进展",
      },
      {
        id: "10000000-0000-4000-8000-000000000202",
        name: "会议纪要",
        trigger: "提取行动项",
      },
    ]);
    const handler = createCheckCommandHandler();
    const result = await handler({
      request: new Request(
        "https://mate.example/api/admin/compat/commands/check",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/weekly-report" }),
        },
      ),
      params: {},
      scope: scopeA,
      csrfVerified: true,
      resources: {
        skills: { listEnabledForAgent },
      } as unknown as AdminCompatContext["resources"],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      is_control_command: false,
      commands: [
        {
          command: "/weekly-report",
          name: "Weekly Report",
        },
        {
          command: "/会议纪要",
          name: "会议纪要",
        },
      ],
    });
    expect(listEnabledForAgent).toHaveBeenCalledWith(scopeA);
  });
});
