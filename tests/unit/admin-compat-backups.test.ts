import { describe, expect, it, vi } from "vitest";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createDeleteBackupsHandler,
  createExportBackupHandler,
  createGetBackupHandler,
  createListBackupsHandler,
  createRestoreBackupHandler,
  type AdminBackupsService,
} from "@/server/admin/compat/handlers/backups";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility backups", () => {
  it("列表和详情不返回私有 storage path 或 storage key", async () => {
    const meta = {
      id: "40000000-0000-4000-8000-000000000001",
      name: "daily",
      description: "",
      created_at: "2026-07-27T00:00:00.000Z",
      scope: {
        include_agents: true,
        include_global_config: true,
        include_secrets: true,
        include_skill_pool: true,
      },
      agent_count: 1,
    };
    const service = {
      list: vi.fn().mockResolvedValue([meta]),
      get: vi.fn().mockResolvedValue({
        ...meta,
        workspace_stats: {
          [scope.agentId]: {
            name: "DigitalMate",
            files: 3,
            size: 100,
          },
        },
      }),
    } as unknown as AdminBackupsService;

    const listed = await createListBackupsHandler(service)(
      context("GET", "/backups"),
    );
    const detail = await createGetBackupHandler(service)(
      context("GET", `/backups/${meta.id}`, {
        backupId: meta.id,
      }),
    );

    expect({ listed, detail }).toMatchObject({
      listed: [meta],
      detail: {
        id: meta.id,
        workspace_stats: expect.any(Object),
      },
    });
    expect(JSON.stringify({ listed, detail })).not.toMatch(
      /storage_key|storagePath|\/private\//iu,
    );
  });

  it("恢复仅接受已由 Console 确认的当前 agent 选择", async () => {
    const restore = vi.fn().mockResolvedValue({
      ok: true,
      preserved_local_keys: [],
    });
    const service = {
      restore,
    } as unknown as AdminBackupsService;
    const backupId =
      "40000000-0000-4000-8000-000000000001";

    await createRestoreBackupHandler(service)(
      context(
        "POST",
        `/backups/${backupId}/restore`,
        { backupId },
        {
          include_agents: true,
          agent_ids: [scope.agentId],
          include_global_config: true,
          include_secrets: true,
          include_skill_pool: true,
          mode: "full",
        },
      ),
    );

    expect(restore).toHaveBeenCalledWith(
      scope,
      backupId,
      expect.objectContaining({
        agentIds: [scope.agentId],
        confirmed: true,
      }),
      expect.any(AbortSignal),
    );
    await expect(
      createRestoreBackupHandler(service)(
        context(
          "POST",
          `/backups/${backupId}/restore`,
          { backupId },
          {
            include_agents: true,
            agent_ids: [
              "10000000-0000-4000-8000-000000000099",
            ],
            include_global_config: false,
            include_secrets: true,
            include_skill_pool: false,
          },
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "backup_agent_mismatch",
    });
  });

  it("导出使用私有文件响应，批量删除仍按当前 scope", async () => {
    const backupId =
      "40000000-0000-4000-8000-000000000001";
    const service = {
      export: vi.fn().mockResolvedValue({
        bytes: Buffer.from("encrypted"),
        fileName: "daily.dmbackup",
      }),
      delete: vi.fn().mockResolvedValue({
        deleted: [backupId],
        failed: [],
      }),
    } as unknown as AdminBackupsService;

    const response = await createExportBackupHandler(service)(
      context("GET", `/backups/${backupId}/export`, {
        backupId,
      }),
    );
    const deleted = await createDeleteBackupsHandler(service)(
      context("POST", "/backups/delete", {}, {
        ids: [backupId],
      }),
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("content-type"))
      .toBe("application/octet-stream");
    expect(deleted).toEqual({
      deleted: [backupId],
      failed: [],
    });
  });
});

function context(
  method: string,
  route: string,
  params: Readonly<Record<string, string>> = {},
  body?: unknown,
): AdminCompatContext {
  return {
    request: new Request(`http://localhost/api/admin${route}`, {
      method,
      headers: body
        ? { "content-type": "application/json" }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    params,
    scope,
    csrfVerified: true,
    resources: {} as AdminCompatContext["resources"],
    signal: new AbortController().signal,
  };
}
