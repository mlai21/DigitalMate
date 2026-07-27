import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createAdminAgentProfileService } from "@/server/admin/agent-profile";
import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import type { AdminCompatRuntime } from "@/server/admin/compat/router";
import type { AdminCompatResources } from "@/server/admin/compat/types";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const AGENT_A = "10000000-0000-4000-8000-000000000011";
const AGENT_A2 = "10000000-0000-4000-8000-000000000012";
const AGENT_B = "20000000-0000-4000-8000-000000000011";
const OPERATION_ID = "30000000-0000-4000-8000-000000000031";
const OTHER_OPERATION_ID =
  "30000000-0000-4000-8000-000000000032";

describe("admin default-agent profile transaction", () => {
  let embeddedPostgres: EmbeddedPostgres;
  let databaseDirectory: string;
  let primaryPool: Pool;
  let secondaryPool: Pool;
  let databaseLifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    databaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-admin-agent-profile-"),
    );
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embeddedPostgres.initialise();
    await embeddedPostgres.start();
    const connectionString =
      `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    const poolOptions = {
      connectionString,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    };
    primaryPool = new Pool(poolOptions);
    secondaryPool = new Pool(poolOptions);
    databaseLifecycle = trackEmbeddedPostgresPool(primaryPool);
    await installVectorCompatibility(primaryPool);
    await primaryPool.query(
      adaptSchemaForEmbeddedPostgres(
        await readFile(
          path.join(process.cwd(), "src/server/db/schema.sql"),
          "utf8",
        ),
      ),
    );
  }, 60_000);

  beforeEach(async () => {
    await primaryPool.query(`
      DROP TRIGGER IF EXISTS fail_agent_audit_insert ON admin_audit_logs;
      DROP FUNCTION IF EXISTS fail_agent_audit_insert();
      TRUNCATE admin_audit_logs, agent_settings, digital_agents,
        settings, users CASCADE;
    `);
    await primaryPool.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'User A'), ($2, 'User B')`,
      [USER_A, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO settings (
         user_id, persona, proactivity, model_routing, cadence, search
       )
       VALUES
         ($1, '{}', '{}', '{}', '{}', '{}'),
         ($2, '{}', '{}', '{}', '{}', '{}')`,
      [USER_A, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, persona, is_default
       )
       VALUES
         ($1, $2, 'default-a', 'Agent A',
          '{"name":"Agent A","style":"old-style","emojiHabit":"rare"}', true),
         ($3, $2, 'second-a', 'Agent A2', '{}', false),
         ($4, $5, 'default-b', 'Agent B', '{}', true)`,
      [AGENT_A, USER_A, AGENT_A2, AGENT_B, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO agent_settings (
         user_id, agent_id, persona, proactivity, cadence, search
       )
       VALUES
         ($1, $2,
          '{"name":"Agent A","style":"old-style","emojiHabit":"rare"}',
          '{"quietStart":"23:00","quietEnd":"08:00","minIntervalMinutes":30,"maxPerHour":2,"maxPerDay":3}',
          '{"responseDelayMs":480,"segmentDelayMs":240,"maxSegments":5}',
          '{"aggressiveness":"conservative"}'),
         ($1, $3, '{}', '{}', '{}', '{}'),
         ($4, $5, '{}', '{}', '{}', '{}')`,
      [USER_A, AGENT_A, AGENT_A2, USER_B, AGENT_B],
    );
  });

  afterAll(async () => {
    await secondaryPool?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await databaseLifecycle?.stop(embeddedPostgres);
    if (databaseDirectory) {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("reads a selected non-default agent profile", async () => {
    await expect(
      createAdminAgentProfileService(primaryPool).read({
        userId: USER_A,
        agentId: AGENT_A2,
      }),
    ).resolves.toMatchObject({
      id: AGENT_A2,
      displayName: "Agent A2",
      revision: 1,
    });
  });

  it.each([
    "default",
    "30000000-0000-4000-8000-00000000003A",
    `${OPERATION_ID},${OTHER_OPERATION_ID}`,
  ])(
    "rejects invalid profile operation id %j before database mutation",
    async (operationId) => {
      await expect(
        createAdminAgentProfileService(primaryPool).update(
          updateInput({ operationId }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_operation_id",
        message: "invalid_operation_id",
      });
      const stored = await primaryPool.query<{
        display_name: string;
        revision: number;
        audit_count: string;
      }>(
        `SELECT digital_agents.display_name,
                agent_settings.revision,
                (SELECT count(*) FROM admin_audit_logs) AS audit_count
         FROM digital_agents
         JOIN agent_settings
           ON agent_settings.user_id = digital_agents.user_id
          AND agent_settings.agent_id = digital_agents.id
         WHERE digital_agents.user_id = $1
           AND digital_agents.id = $2`,
        [USER_A, AGENT_A],
      );
      expect(stored.rows[0]).toEqual({
        display_name: "Agent A",
        revision: 1,
        audit_count: "0",
      });
    },
  );

  it("updates display name, persona, agent settings and safe audit atomically", async () => {
    const result = await createAdminAgentProfileService(
      primaryPool,
    ).update(updateInput());

    expect(result.revision).toBe(2);
    const stored = await primaryPool.query<{
      display_name: string;
      digital_persona: Record<string, unknown>;
      settings_persona: Record<string, unknown>;
      proactivity: Record<string, unknown>;
      cadence: Record<string, unknown>;
      search: Record<string, unknown>;
      revision: number;
    }>(
      `SELECT digital_agents.display_name,
              digital_agents.persona AS digital_persona,
              agent_settings.persona AS settings_persona,
              agent_settings.proactivity,
              agent_settings.cadence,
              agent_settings.search,
              agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2`,
      [USER_A, AGENT_A],
    );
    expect(stored.rows[0]).toMatchObject({
      display_name: "Mate",
      digital_persona: {
        name: "Mate",
        style: "自然温暖",
        emojiHabit: "少量",
      },
      settings_persona: {
        name: "Mate",
        style: "自然温暖",
        emojiHabit: "少量",
      },
      proactivity: {
        quietStart: "22:30",
        quietEnd: "08:30",
        minIntervalMinutes: 60,
        maxPerHour: 1,
        maxPerDay: 2,
      },
      cadence: {
        responseDelayMs: 600,
        segmentDelayMs: 300,
        maxSegments: 4,
      },
      search: { aggressiveness: "off" },
      revision: 2,
    });
    const audit = await primaryPool.query<{
      action: string;
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
      confirmation_source: Record<string, unknown>;
    }>(
      `SELECT action, before_summary, after_summary,
              confirmation_source
       FROM admin_audit_logs
       WHERE user_id = $1 AND agent_id = $2`,
      [USER_A, AGENT_A],
    );
    expect(audit.rows).toEqual([
      {
        action: "agent_profile.update",
        before_summary: {
          display_name: "Agent A",
          revision: 1,
        },
        after_summary: {
          display_name: "Mate",
          revision: 2,
          changed_fields: [
            "display_name",
            "persona",
            "proactivity",
            "cadence",
            "search",
          ],
        },
        confirmation_source: {
          type: "console",
          requestId: OPERATION_ID,
          inputFingerprint: expect.stringMatching(
            /^[0-9a-f]{64}$/u,
          ),
        },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("自然温暖");
  });

  it("allows only one writer for the same revision across pools", async () => {
    const first = createAdminAgentProfileService(primaryPool);
    const second = createAdminAgentProfileService(secondaryPool);
    const outcomes = await Promise.allSettled([
      first.update(updateInput({ displayName: "First" })),
      second.update(updateInput({ displayName: "Second" })),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
    const stored = await primaryPool.query<{
      display_name: string;
      revision: number;
    }>(
      `SELECT digital_agents.display_name, agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.id = $1`,
      [AGENT_A],
    );
    expect(["First", "Second"]).toContain(
      stored.rows[0].display_name,
    );
    expect(stored.rows[0].revision).toBe(2);
  });

  it.each([
    ["/agents", false],
    [`/agents/${AGENT_A}`, true],
  ])(
    "never returns an old name with new settings from GET %s",
    async (path, requiresHeader) => {
      const firstSnapshotRead = deferred<void>();
      const updateCommitted = deferred<void>();
      const profileService =
        createAdminAgentProfileService(primaryPool);
      const router = createCoreAdminCompatRouter(
        agentRouterDependencies({
          readAgentProfile: async (
            scope: { userId: string; agentId: string },
            signal?: AbortSignal,
          ) => {
            const snapshot = await profileService.read(
              scope,
              signal,
            );
            firstSnapshotRead.resolve();
            await updateCommitted.promise;
            return snapshot;
          },
        }),
      );
      const request = new Request(
        `http://localhost/api/admin/compat${path}`,
        requiresHeader
          ? {
              headers: {
                "x-digitalmate-agent-id": AGENT_A,
              },
            }
          : undefined,
      );
      const responsePromise = router.dispatch(
        request,
        agentRouterRuntime({
          agents: {
            listActive: async () => [{
              id: AGENT_A,
              userId: USER_A,
              slug: "default-a",
              displayName: "Agent A",
              persona: {},
              status: "active" as const,
              isDefault: true,
              inheritsUserResources: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }],
            getActive: async () => {
              const result = await primaryPool.query<{
                display_name: string;
              }>(
                `SELECT display_name
                 FROM digital_agents
                 WHERE user_id = $1 AND id = $2`,
                [USER_A, AGENT_A],
              );
              firstSnapshotRead.resolve();
              return {
                id: AGENT_A,
                userId: USER_A,
                slug: "default-a",
                displayName: result.rows[0]?.display_name ?? "",
                persona: {},
                status: "active",
                isDefault: true,
                inheritsUserResources: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            },
          },
          settings: {
            get: async () => {
              await firstSnapshotRead.promise;
              await updateCommitted.promise;
              const result = await primaryPool.query<{
                persona: Record<string, unknown>;
                proactivity: Record<string, unknown>;
                cadence: Record<string, unknown>;
                search: Record<string, unknown>;
                revision: number;
              }>(
                `SELECT persona, proactivity, cadence, search, revision
                 FROM agent_settings
                 WHERE user_id = $1 AND agent_id = $2`,
                [USER_A, AGENT_A],
              );
              const row = result.rows[0]!;
              return {
                ...row,
                modelRouting: { main: "main", light: "light" },
                modelRoutingOverride: {},
              };
            },
          },
        }),
      );

      await firstSnapshotRead.promise;
      await createAdminAgentProfileService(primaryPool).update(
        updateInput(),
      );
      updateCommitted.resolve();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agents?: Array<{
          name: string;
          persona?: { name?: string };
          revision: number;
        }>;
        name?: string;
        persona?: { name?: string };
        revision?: number;
      };
      const profile = body.agents?.[0] ?? body;

      if (requiresHeader) {
        expect(profile).not.toMatchObject({
          name: "Agent A",
          persona: { name: "Mate" },
          revision: 2,
        });
        expect([
          {
            name: "Agent A",
            persona: { name: "Agent A" },
            revision: 1,
          },
          {
            name: "Mate",
            persona: { name: "Mate" },
            revision: 2,
          },
        ]).toContainEqual(
          expect.objectContaining({
            name: profile.name,
            persona: { name: profile.persona?.name },
            revision: profile.revision,
          }),
        );
      } else {
        expect(profile).not.toMatchObject({
          name: "Agent A",
          revision: 2,
        });
        expect([
          { name: "Agent A", revision: 1 },
          { name: "Mate", revision: 2 },
        ]).toContainEqual({
          name: profile.name,
          revision: profile.revision,
        });
      }
    },
  );

  it("rolls back profile rows when the success audit cannot be inserted", async () => {
    await primaryPool.query(`
      CREATE FUNCTION fail_agent_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'agent_profile.update' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_agent_audit_insert
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_agent_audit_insert();
    `);

    await expect(
      createAdminAgentProfileService(primaryPool).update(updateInput()),
    ).rejects.toThrow();
    const stored = await primaryPool.query<{
      display_name: string;
      style: string;
      revision: number;
    }>(
      `SELECT digital_agents.display_name,
              agent_settings.persona->>'style' AS style,
              agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.id = $1`,
      [AGENT_A],
    );
    expect(stored.rows[0]).toEqual({
      display_name: "Agent A",
      style: "old-style",
      revision: 1,
    });
  });

  it("returns success when abort arrives after COMMIT has resolved", async () => {
    const controller = new AbortController();
    const wrapped = abortAfterCommitPool(primaryPool, controller);

    await expect(
      createAdminAgentProfileService(wrapped.pool).update(
        updateInput(),
        controller.signal,
      ),
    ).resolves.toEqual({ revision: 2 });

    expect(controller.signal.aborted).toBe(true);
    expect(wrapped.releaseCalls()).toBe(1);
    const committed = await primaryPool.query<{
      display_name: string;
      revision: number;
      audit_count: string;
    }>(
      `SELECT digital_agents.display_name,
              agent_settings.revision,
              (
                SELECT count(*)
                FROM admin_audit_logs
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action = 'agent_profile.update'
              ) AS audit_count
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2`,
      [USER_A, AGENT_A],
    );
    expect(committed.rows[0]).toEqual({
      display_name: "Mate",
      revision: 2,
      audit_count: "1",
    });
    await expect(primaryPool.query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it("recovers success when COMMIT commits and then loses confirmation", async () => {
    const wrapped = controlledCommitPool(
      primaryPool,
      "commit_then_throw",
    );

    await expect(
      createAdminAgentProfileService(wrapped.pool).update(
        updateInput(),
      ),
    ).resolves.toEqual({ revision: 2 });

    expect(wrapped.connectCalls()).toBe(2);
    expect(wrapped.originalReleaseArgs()).toEqual([true]);
    expect(wrapped.recoveryReleaseArgs()).toEqual([undefined]);
    const committed = await primaryPool.query<{
      display_name: string;
      digital_persona_name: string;
      settings_persona_name: string;
      revision: number;
      audit_count: string;
      request_id: string;
      audit_revision: string;
    }>(
      `SELECT digital_agents.display_name,
              digital_agents.persona->>'name' AS digital_persona_name,
              agent_settings.persona->>'name' AS settings_persona_name,
              agent_settings.revision,
              (
                SELECT count(*)
                FROM admin_audit_logs
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action = 'agent_profile.update'
              ) AS audit_count,
              (
                SELECT confirmation_source->>'requestId'
                FROM admin_audit_logs
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action = 'agent_profile.update'
              ) AS request_id,
              (
                SELECT after_summary->>'revision'
                FROM admin_audit_logs
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action = 'agent_profile.update'
              ) AS audit_revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2`,
      [USER_A, AGENT_A],
    );
    expect(committed.rows[0]).toEqual({
      display_name: "Mate",
      digital_persona_name: "Mate",
      settings_persona_name: "Mate",
      revision: 2,
      audit_count: "1",
      request_id: OPERATION_ID,
      audit_revision: "2",
    });
    await expect(primaryPool.query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it("uses recovery independent of an outer abort after COMMIT", async () => {
    const controller = new AbortController();
    const wrapped = controlledCommitPool(
      primaryPool,
      "commit_then_throw",
      () => controller.abort(),
    );

    await expect(
      createAdminAgentProfileService(wrapped.pool).update(
        updateInput(),
        controller.signal,
      ),
    ).resolves.toEqual({ revision: 2 });

    expect(controller.signal.aborted).toBe(true);
    expect(wrapped.connectCalls()).toBe(2);
    expect(wrapped.originalReleaseArgs()).toEqual([true]);
    expect(wrapped.recoveryReleaseArgs()).toEqual([undefined]);
  });

  it("returns safe failure when COMMIT was not executed and no audit committed", async () => {
    const wrapped = controlledCommitPool(
      primaryPool,
      "throw_before_commit",
    );

    await expect(
      createAdminAgentProfileService(wrapped.pool).update(
        updateInput(),
      ),
    ).rejects.toMatchObject({
      status: 500,
      code: "agent_profile_update_failed",
      message: "agent_profile_update_failed",
    });

    expect(wrapped.connectCalls()).toBe(2);
    expect(wrapped.originalReleaseArgs()).toEqual([true]);
    expect(wrapped.recoveryReleaseArgs()).toEqual([undefined]);
    const stored = await primaryPool.query<{
      display_name: string;
      revision: number;
      audit_count: string;
    }>(
      `SELECT digital_agents.display_name,
              agent_settings.revision,
              (SELECT count(*) FROM admin_audit_logs) AS audit_count
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2`,
      [USER_A, AGENT_A],
    );
    expect(stored.rows[0]).toEqual({
      display_name: "Agent A",
      revision: 1,
      audit_count: "0",
    });
  });

  it.each([
    ["wrong operation", USER_A, AGENT_A, OTHER_OPERATION_ID, 2],
    ["wrong revision", USER_A, AGENT_A, OPERATION_ID, 9],
    ["other user", USER_B, AGENT_B, OPERATION_ID, 2],
    ["other agent", USER_A, AGENT_A2, OPERATION_ID, 2],
  ])(
    "does not recover from a forged %s audit",
    async (
      _label,
      auditUserId,
      auditAgentId,
      operationId,
      revision,
    ) => {
      await insertForgedProfileAudit(primaryPool, {
        userId: auditUserId,
        agentId: auditAgentId,
        operationId,
        revision,
      });
      const wrapped = controlledCommitPool(
        primaryPool,
        "throw_before_commit",
      );

      await expect(
        createAdminAgentProfileService(wrapped.pool).update(
          updateInput(),
        ),
      ).rejects.toMatchObject({
        status: 500,
        code: "agent_profile_update_failed",
      });
      expect(wrapped.connectCalls()).toBe(2);
    },
  );

  it("does not open a recovery connection on a confirmed COMMIT", async () => {
    const wrapped = controlledCommitPool(primaryPool, "normal");

    await expect(
      createAdminAgentProfileService(wrapped.pool).update(
        updateInput(),
      ),
    ).resolves.toEqual({ revision: 2 });

    expect(wrapped.connectCalls()).toBe(1);
    expect(wrapped.originalReleaseArgs()).toEqual([undefined]);
    expect(wrapped.recoveryReleaseArgs()).toEqual([]);
  });

  it("aborts a held row lock with a stable error and leaves the pool reusable", async () => {
    const blocker = await secondaryPool.connect();
    const controller = new AbortController();
    let captured: unknown;
    let elapsedMs = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT digital_agents.id
         FROM digital_agents
         JOIN agent_settings
           ON agent_settings.user_id = digital_agents.user_id
          AND agent_settings.agent_id = digital_agents.id
         WHERE digital_agents.id = $1
         FOR UPDATE OF digital_agents, agent_settings`,
        [AGENT_A],
      );
      const startedAt = Date.now();
      const abortTimer = setTimeout(() => {
        controller.abort(new Error("sensitive abort reason"));
      }, 25);
      try {
        await createAdminAgentProfileService(primaryPool).update(
          updateInput(),
          controller.signal,
        );
      } catch (error) {
        captured = error;
      } finally {
        clearTimeout(abortTimer);
        elapsedMs = Date.now() - startedAt;
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    expect(captured).toMatchObject({
      status: 500,
      code: "agent_profile_update_failed",
      message: "agent_profile_update_failed",
    });
    expect(String(captured)).not.toContain("sensitive abort reason");
    expect(elapsedMs).toBeLessThan(1_000);
    await expect(primaryPool.query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });
});

function updateInput(
  overrides: {
    displayName?: string;
    operationId?: string;
  } = {},
) {
  return {
    scope: { userId: USER_A, agentId: AGENT_A },
    operationId: overrides.operationId ?? OPERATION_ID,
    expectedRevision: 1,
    displayName: overrides.displayName ?? "Mate",
    persona: {
      name: "Mate",
      style: "自然温暖",
      emojiHabit: "少量",
    },
    settings: {
      proactivity: {
        quietStart: "22:30",
        quietEnd: "08:30",
        minIntervalMinutes: 60,
        maxPerHour: 1,
        maxPerDay: 2,
      },
      cadence: {
        responseDelayMs: 600,
        segmentDelayMs: 300,
        maxSegments: 4,
      },
      search: { aggressiveness: "off" as const },
    },
  };
}

function agentRouterDependencies(
  overrides: Record<string, unknown> = {},
): CoreAdminCompatDependencies {
  return {
    createAuthStatusResponse: async () =>
      Response.json({ authenticated: true }),
    digitalMateVersion: "0.1.0",
    upstreamTag: "v2.0.0.post3",
    upstreamCommit:
      "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
    compatApiRevision: "test",
    ...overrides,
  } as CoreAdminCompatDependencies;
}

function agentRouterRuntime(
  resources: unknown,
): AdminCompatRuntime {
  return {
    security: {
      defaultUserId: USER_A,
      appSecret: "test-app-secret-for-agent-profile",
      appPasswordEnabled: false,
      production: false,
      trustProxyHeaders: false,
      loadSessionGeneration: async () => 0,
    },
    withUserDataLease: async (_userId, work) =>
      work(
        resources as AdminCompatResources,
        new AbortController().signal,
      ),
    resolveDefaultScope: async () => ({
      userId: USER_A,
      agentId: AGENT_A,
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function abortAfterCommitPool(
  pool: Pool,
  controller: AbortController,
): {
  pool: Pool;
  releaseCalls(): number;
} {
  let releases = 0;
  return {
    pool: {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(
                  target.query,
                  target,
                  args,
                );
                if (
                  typeof args[0] === "string" &&
                  args[0].trim().toUpperCase() === "COMMIT"
                ) {
                  controller.abort(
                    new Error("abort_after_commit_resolved"),
                  );
                }
                return result;
              };
            }
            if (property === "release") {
              return (...args: unknown[]) => {
                releases += 1;
                return Reflect.apply(target.release, target, args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        }) as PoolClient;
      },
    } as Pool,
    releaseCalls: () => releases,
  };
}

function controlledCommitPool(
  pool: Pool,
  mode: "normal" | "commit_then_throw" | "throw_before_commit",
  afterUnknownCommit: () => void = () => undefined,
): {
  pool: Pool;
  connectCalls(): number;
  originalReleaseArgs(): unknown[];
  recoveryReleaseArgs(): unknown[];
} {
  let connects = 0;
  const originalReleases: unknown[] = [];
  const recoveryReleases: unknown[] = [];
  return {
    pool: {
      async connect() {
        connects += 1;
        const connectionNumber = connects;
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const sql =
                  typeof args[0] === "string"
                    ? args[0].trim().toUpperCase()
                    : "";
                if (
                  connectionNumber === 1 &&
                  sql === "COMMIT" &&
                  mode !== "normal"
                ) {
                  if (mode === "commit_then_throw") {
                    await target.query("COMMIT");
                  }
                  afterUnknownCommit();
                  throw Object.assign(
                    new Error("sensitive socket reset"),
                    { code: "ECONNRESET" },
                  );
                }
                return Reflect.apply(target.query, target, args);
              };
            }
            if (property === "release") {
              return (...args: unknown[]) => {
                const releases =
                  connectionNumber === 1
                    ? originalReleases
                    : recoveryReleases;
                releases.push(args[0]);
                return Reflect.apply(target.release, target, args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        }) as PoolClient;
      },
    } as Pool,
    connectCalls: () => connects,
    originalReleaseArgs: () => [...originalReleases],
    recoveryReleaseArgs: () => [...recoveryReleases],
  };
}

async function insertForgedProfileAudit(
  pool: Pool,
  input: {
    userId: string;
    agentId: string;
    operationId: string;
    revision: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type, resource_id,
       before_summary, after_summary, confirmation_source,
       status, error_code
     )
     VALUES (
       $1, $2::uuid, 'agent_profile.update', 'digital_agent',
       ($2::uuid)::text,
       '{"display_name":"forged","revision":1}',
       jsonb_build_object(
         'display_name', 'forged',
         'revision', $4::integer,
         'changed_fields', '[]'::jsonb
       ),
       jsonb_build_object(
         'type', 'console',
         'requestId', $3::text
       ),
       'success', NULL
     )`,
    [
      input.userId,
      input.agentId,
      input.operationId,
      input.revision,
    ],
  );
}

function adaptSchemaForEmbeddedPostgres(source: string): string {
  return source
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(
      /^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m,
      "",
    );
}

async function installVectorCompatibility(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed_to_reserve_port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
