import { describe, expect, it, vi } from "vitest";
import {
  AdminScheduleError,
  assertPersistentScheduleAuthorization,
  computeNextScheduleTime,
  normalizeAdminCronSpec,
  processDueScheduledJobs,
  projectHeartbeatConfig,
  validateHeartbeatTrigger,
} from "@/server/admin/views/schedules";
import {
  createCreateCronJobHandler,
  type AdminSchedulesService,
} from "@/server/admin/compat/handlers/schedules";
import type { AdminCompatContext } from "@/server/admin/compat/types";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility schedules", () => {
  it("没有持久授权类型与来源 ID 的联网 Cron 不能启用", () => {
    expect(() =>
      assertPersistentScheduleAuthorization({
        kind: "scheduled_digest",
        enabled: true,
        networkEnabled: true,
        authorizationType: null,
        authorizationSourceId: null,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AdminScheduleError>>({
        code: "persistent_authorization_required",
        status: 400,
      }),
    );
  });

  it("离线提醒不需要联网授权", () => {
    expect(() =>
      assertPersistentScheduleAuthorization({
        kind: "reminder",
        enabled: true,
        networkEnabled: false,
        authorizationType: null,
        authorizationSourceId: null,
      }),
    ).not.toThrow();
  });

  it("Heartbeat 默认关闭且普通目标不能触发后台任务", () => {
    expect(projectHeartbeatConfig(null)).toEqual({
      enabled: false,
      every: "6h",
      target: "inbox",
      timeoutSeconds: 300,
      activeHours: null,
      revision: 0,
      authorization: null,
    });
    expect(() =>
      validateHeartbeatTrigger({
        enabled: true,
        target: "main",
        authorization: null,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AdminScheduleError>>({
        code: "persistent_authorization_required",
      }),
    );
  });

  it("Heartbeat 只接受显式 schedule/goal 合同来源", () => {
    expect(() =>
      validateHeartbeatTrigger({
        enabled: true,
        target: "inbox",
        authorization: {
          type: "goal_contract",
          sourceId: "10000000-0000-4000-8000-000000000301",
        },
      }),
    ).not.toThrow();
  });

  it("把上游 text Cron 规范化为离线提醒并计算下一次运行", () => {
    const normalized = normalizeAdminCronSpec(
      {
        id: "",
        name: "每天喝水",
        enabled: true,
        schedule: {
          type: "cron",
          cron: "0 9 * * *",
          timezone: "Asia/Shanghai",
        },
        task_type: "text",
        text: "喝水",
        dispatch: {
          type: "channel",
          channel: "console",
          target: {
            user_id: scope.userId,
            session_id:
              "10000000-0000-4000-8000-000000000201",
          },
        },
        meta: { digitalmate_kind: "reminder" },
      },
      {
        jobId: "10000000-0000-4000-8000-000000000401",
        now: new Date("2026-07-27T00:30:00Z"),
      },
    );

    expect(normalized).toMatchObject({
      id: "10000000-0000-4000-8000-000000000401",
      kind: "reminder",
      taskType: "text",
      content: "喝水",
      networkEnabled: false,
    });
    expect(normalized.nextRunAt?.toISOString()).toBe(
      "2026-07-27T01:00:00.000Z",
    );
  });

  it("标准五段 Cron 支持列表、范围与步长", () => {
    expect(
      computeNextScheduleTime(
        {
          type: "cron",
          cron: "*/15 9-10 * * 1,2,3,4,5",
          timezone: "UTC",
        },
        new Date("2026-07-27T09:01:00Z"),
      ).toISOString(),
    ).toBe("2026-07-27T09:15:00.000Z");
  });

  it("创建 Cron handler 保留当前分身 scope", async () => {
    const createJob = vi
      .fn<AdminSchedulesService["createJob"]>()
      .mockResolvedValue({ id: "job-1" });
    const handler = createCreateCronJobHandler({
      createJob,
    } as unknown as AdminSchedulesService);
    const body = {
      id: "",
      name: "一次提醒",
      enabled: false,
      schedule: {
        type: "once",
        run_at: "2026-07-28T09:00:00",
        timezone: "Asia/Shanghai",
      },
      task_type: "text",
      text: "记得喝水",
      dispatch: {
        type: "channel",
        channel: "console",
        target: {
          user_id: scope.userId,
          session_id:
            "10000000-0000-4000-8000-000000000201",
        },
      },
    };
    const context = {
      request: new Request(
        "https://mate.example/api/admin/compat/cron/jobs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      params: {},
      scope,
      csrfVerified: true,
      resources: {},
      signal: new AbortController().signal,
    } as unknown as AdminCompatContext;

    await expect(handler(context)).resolves.toEqual({
      id: "job-1",
    });
    expect(createJob).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ name: "一次提醒" }),
      context.signal,
    );
  });

  it("同一计划触发源重复领取只生成一个主动任务", async () => {
    const dueRow = {
      id: "10000000-0000-4000-8000-000000000401",
      user_id: scope.userId,
      agent_id: scope.agentId,
      conversation_id:
        "10000000-0000-4000-8000-000000000201",
      name: "一次提醒",
      enabled: true,
      kind: "reminder",
      schedule: {
        type: "once",
        run_at: "2026-07-27T09:00:00Z",
        timezone: "UTC",
      },
      task_type: "text",
      content: "喝水",
      request: null,
      dispatch: {
        type: "channel",
        channel: "console",
        target: {
          user_id: scope.userId,
          session_id:
            "10000000-0000-4000-8000-000000000201",
        },
      },
      runtime: {},
      meta: {},
      save_result_to_inbox: true,
      network_enabled: false,
      authorization_type: null,
      authorization_source_id: null,
      next_run_at: new Date("2026-07-27T09:00:00Z"),
      revision: 1,
    };
    const poolQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [dueRow] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: [dueRow] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const firstClientQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10000000-0000-4000-8000-000000000411",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10000000-0000-4000-8000-000000000421",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const secondClientQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const connect = vi
      .fn()
      .mockResolvedValueOnce({
        query: firstClientQuery,
        release: vi.fn(),
      })
      .mockResolvedValueOnce({
        query: secondClientQuery,
        release: vi.fn(),
      });
    const pool = {
      query: poolQuery,
      connect,
    } as never;
    const input = {
      pool,
      scope,
      now: new Date("2026-07-27T09:00:01Z"),
    };

    await expect(processDueScheduledJobs(input)).resolves.toEqual({
      dispatched: 1,
      failed: 0,
    });
    await expect(processDueScheduledJobs(input)).resolves.toEqual({
      dispatched: 0,
      failed: 0,
    });
    expect(
      firstClientQuery.mock.calls.filter(([sql]) =>
        String(sql).includes("INSERT INTO proactive_tasks"),
      ),
    ).toHaveLength(1);
    expect(
      secondClientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO proactive_tasks"),
      ),
    ).toBe(false);
  });
});
