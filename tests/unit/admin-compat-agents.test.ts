import { describe, expect, it, vi } from "vitest";

import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import type { AdminCompatRuntime } from "@/server/admin/compat/router";
import type { AdminCompatResources } from "@/server/admin/compat/types";
import { createAdminAuthStatusResponse } from "@/server/admin/compat/security";
import { AdminAgentProfileError } from "@/server/admin/agent-profile";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const DEFAULT_AGENT_ID = "10000000-0000-4000-8000-000000000011";

function dependencies(
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

function resources(): AdminCompatResources {
  return {
    agents: {
      getActive: async () => ({
        id: DEFAULT_AGENT_ID,
        userId: USER_ID,
        slug: "digitalmate",
        displayName: "DigitalMate",
        persona: {},
        status: "active",
        isDefault: true,
        inheritsUserResources: true,
        createdAt: new Date("2026-07-24T00:00:00.000Z"),
        updatedAt: new Date("2026-07-24T00:00:00.000Z"),
      }),
    },
    settings: {
      get: async () => ({
        persona: {
          name: "DigitalMate",
          style: "温暖自然",
          emojiHabit: "少量使用",
        },
        proactivity: {
          quietStart: "23:00",
          quietEnd: "08:00",
          minIntervalMinutes: 30,
          maxPerHour: 2,
          maxPerDay: 3,
        },
        cadence: {
          responseDelayMs: 480,
          segmentDelayMs: 240,
          maxSegments: 5,
        },
        search: { aggressiveness: "conservative" },
        modelRouting: { main: "main-model", light: "light-model" },
        modelRoutingOverride: {},
        revision: 1,
      }),
    },
  } as unknown as AdminCompatResources;
}

function runtime(): AdminCompatRuntime {
  return {
    security: {
      defaultUserId: USER_ID,
      appSecret: "test-app-secret-for-agent-contract",
      appPasswordEnabled: false,
      production: false,
      trustProxyHeaders: false,
      loadSessionGeneration: async () => 0,
    },
    withUserDataLease: async (_userId, work) =>
      work(resources(), new AbortController().signal),
    resolveDefaultScope: async () => ({
      userId: USER_ID,
      agentId: DEFAULT_AGENT_ID,
    }),
  };
}

async function mutationRequest(
  method: string,
  path: string,
  body: unknown,
  options: {
    agentId?: string | null;
    contentLength?: string;
  } = {},
): Promise<Request> {
  const selectedRuntime = runtime();
  const statusResponse = await createAdminAuthStatusResponse(
    new Request("http://localhost/api/admin/compat/auth/status"),
    selectedRuntime.security,
  );
  const status = (await statusResponse.json()) as {
    csrf_token: string;
  };
  const headers = new Headers({
    origin: "http://localhost",
    "content-type": "application/json",
    "x-csrf-token": status.csrf_token,
  });
  if (options.agentId !== null) {
    headers.set(
      "x-digitalmate-agent-id",
      options.agentId ?? DEFAULT_AGENT_ID,
    );
  }
  if (options.contentLength) {
    headers.set("content-length", options.contentLength);
  }
  return new Request(
    `http://localhost/api/admin/compat${path}`,
    {
      method,
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe("admin compatibility agents contract", () => {
  it("lists the real default DigitalMate agent with the upstream envelope", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      new Request("http://localhost/api/admin/compat/agents"),
      runtime(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agents: [
        expect.objectContaining({
          id: DEFAULT_AGENT_ID,
          name: "DigitalMate",
          enabled: true,
          pinned: true,
          revision: 1,
        }),
      ],
    });
  });

  it("allows the bootstrap list without a header but validates a supplied header", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const malformed = await router.dispatch(
      new Request("http://localhost/api/admin/compat/agents", {
        headers: {
          "x-digitalmate-agent-id": "default",
        },
      }),
      runtime(),
    );

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "invalid_agent_header",
      },
    });
  });

  it.each(["/auth/status", "/auth/verify"])(
    "allows %s without an agent header but validates a supplied header",
    async (path) => {
      const router = createCoreAdminCompatRouter(dependencies());
      const headerless = await router.dispatch(
        new Request(`http://localhost/api/admin/compat${path}`),
        runtime(),
      );
      const malformed = await router.dispatch(
        new Request(`http://localhost/api/admin/compat${path}`, {
          headers: {
            "x-digitalmate-agent-id": "default",
          },
        }),
        runtime(),
      );

      expect(headerless.status).toBe(200);
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toEqual({
        error: {
          code: "invalid_request",
          message: "invalid_agent_header",
        },
      });
    },
  );

  it("requires the canonical default-agent header for an agent profile", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const missing = await router.dispatch(
      new Request(
        `http://localhost/api/admin/compat/agents/${DEFAULT_AGENT_ID}`,
      ),
      runtime(),
    );
    const valid = await router.dispatch(
      new Request(
        `http://localhost/api/admin/compat/agents/${DEFAULT_AGENT_ID}`,
        {
          headers: {
            "x-digitalmate-agent-id": DEFAULT_AGENT_ID,
          },
        },
      ),
      runtime(),
    );

    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "agent_header_required",
      },
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual(
      expect.objectContaining({
        id: DEFAULT_AGENT_ID,
        name: "DigitalMate",
        revision: 1,
      }),
    );
  });

  it.each([
    "default",
    "",
    " ",
    "A0000000-0000-4000-8000-000000000011",
    `${DEFAULT_AGENT_ID},${DEFAULT_AGENT_ID}`,
    `${DEFAULT_AGENT_ID} ${DEFAULT_AGENT_ID}`,
  ])("fails closed for malformed or ambiguous agent header %j", async (agentId) => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      new Request("http://localhost/api/admin/compat/agents", {
        headers: {
          "x-digitalmate-agent-id": agentId,
        },
      }),
      runtime(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "invalid_agent_header",
      },
    });
  });

  it("does not enumerate another, non-default or missing UUID", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const candidates = [
      "10000000-0000-4000-8000-000000000012",
      "20000000-0000-4000-8000-000000000011",
      "30000000-0000-4000-8000-000000000011",
    ];

    for (const candidate of candidates) {
      const response = await router.dispatch(
        new Request(
          `http://localhost/api/admin/compat/agents/${candidate}`,
          {
            headers: {
              "x-digitalmate-agent-id": candidate,
            },
          },
        ),
        runtime(),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "not_found",
          message: "agent_not_found",
        },
      });
    }
  });

  it("rejects a path/header disagreement without revealing either agent", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      new Request(
        "http://localhost/api/admin/compat/agents/10000000-0000-4000-8000-000000000012",
        {
          headers: {
            "x-digitalmate-agent-id": DEFAULT_AGENT_ID,
          },
        },
      ),
      runtime(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "agent_not_found",
      },
    });
  });

  it.each([
    ["POST", "/agents", "multi_agent_create"],
    ["POST", "/agents/import", "multi_agent_import"],
    [
      "POST",
      `/agents/${DEFAULT_AGENT_ID}/clone`,
      "multi_agent_clone",
    ],
    [
      "DELETE",
      `/agents/${DEFAULT_AGENT_ID}`,
      "multi_agent_delete",
    ],
  ])("%s %s returns the approved stable disabled capability", async (
    method,
    path,
    capability,
  ) => {
    const router = createCoreAdminCompatRouter(dependencies());
    const request = await mutationRequest(method, path, {});
    const response = await router.dispatch(request, runtime());

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "capability_disabled",
        message: "capability_disabled",
        details: { capability },
      },
    });
  });

  it("keeps default toggle, pin and one-element ordering idempotent", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const operations = [
      [
        "PATCH",
        `/agents/${DEFAULT_AGENT_ID}/toggle`,
        { enabled: true },
        {
          success: true,
          agent_id: DEFAULT_AGENT_ID,
          enabled: true,
        },
      ],
      [
        "PATCH",
        `/agents/${DEFAULT_AGENT_ID}/pin`,
        { pinned: true },
        {
          success: true,
          agent_id: DEFAULT_AGENT_ID,
          pinned: true,
        },
      ],
      [
        "PUT",
        "/agents/order",
        { agent_ids: [DEFAULT_AGENT_ID] },
        {
          success: true,
          agent_ids: [DEFAULT_AGENT_ID],
        },
      ],
    ] as const;

    for (const [method, path, body, expected] of operations) {
      const response = await router.dispatch(
        await mutationRequest(method, path, body),
        runtime(),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expected);
    }
  });

  it.each([
    [
      "PATCH",
      `/agents/${DEFAULT_AGENT_ID}/toggle`,
      { enabled: false },
    ],
    [
      "PATCH",
      `/agents/${DEFAULT_AGENT_ID}/pin`,
      { pinned: false },
    ],
    [
      "PUT",
      "/agents/order",
      {
        agent_ids: [
          DEFAULT_AGENT_ID,
          "10000000-0000-4000-8000-000000000012",
        ],
      },
    ],
  ])("%s %s rejects topology changes with central multi_agent", async (
    method,
    path,
    body,
  ) => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      await mutationRequest(method, path, body),
      runtime(),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "capability_disabled",
        message: "capability_disabled",
        details: { capability: "multi_agent" },
      },
    });
  });

  it("updates only the approved default-agent profile fields with revision CAS", async () => {
    const updateAgentProfile = vi.fn(async () => ({
      revision: 2,
    }));
    const router = createCoreAdminCompatRouter(
      dependencies({ updateAgentProfile }),
    );
    const body = {
      id: DEFAULT_AGENT_ID,
      name: "Mate",
      persona: {
        name: "Mate",
        style: "温暖自然",
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
        search: { aggressiveness: "off" },
      },
      revision: 1,
    };
    const response = await router.dispatch(
      await mutationRequest(
        "PUT",
        `/agents/${DEFAULT_AGENT_ID}`,
        body,
      ),
      runtime(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: DEFAULT_AGENT_ID,
      name: "Mate",
      display_name: "Mate",
      persona: body.persona,
      settings: body.settings,
      revision: 2,
    });
    expect(updateAgentProfile).toHaveBeenCalledOnce();
    expect(updateAgentProfile).toHaveBeenCalledWith(
      {
        scope: {
          userId: USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        expectedRevision: 1,
        displayName: "Mate",
        persona: body.persona,
        settings: body.settings,
      },
      expect.any(AbortSignal),
    );
  });

  const invalidProfileBodies: Array<{
    name: string;
    body: unknown;
  }> = [
    {
      name: "extra model field",
      body: {
        id: DEFAULT_AGENT_ID,
        name: "Mate",
        persona: {
          name: "Mate",
          style: "温暖自然",
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
          search: { aggressiveness: "off" },
        },
        revision: 1,
        active_model: {
          provider_id: "secret-provider",
          model: "secret-model",
        },
      },
    },
    {
      name: "oversized persona",
      body: {
        id: DEFAULT_AGENT_ID,
        name: "Mate",
        persona: {
          name: "Mate",
          style: "x".repeat(4_001),
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
          search: { aggressiveness: "off" },
        },
        revision: 1,
      },
    },
    {
      name: "prototype-shaped persona",
      body: {
        id: DEFAULT_AGENT_ID,
        name: "Mate",
        persona: {
          name: "Mate",
          style: "温暖自然",
          emojiHabit: "少量",
          constructor: { prototype: { polluted: true } },
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
          search: { aggressiveness: "off" },
        },
        revision: 1,
      },
    },
  ];

  it.each(invalidProfileBodies)(
    "rejects $name without entering the profile transaction",
    async ({ body }) => {
      const updateAgentProfile = vi.fn();
      const router = createCoreAdminCompatRouter(
        dependencies({ updateAgentProfile }),
      );
      const response = await router.dispatch(
        await mutationRequest(
          "PUT",
          `/agents/${DEFAULT_AGENT_ID}`,
          body,
        ),
        runtime(),
      );

      expect(response.status).toBe(400);
      expect(updateAgentProfile).not.toHaveBeenCalled();
      expect(JSON.stringify(await response.json())).not.toContain(
        "secret-model",
      );
    },
  );

  it("maps only the exact profile revision domain error to stable 409", async () => {
    const updateAgentProfile = vi.fn(async () => {
      throw new AdminAgentProfileError(409, "revision_conflict");
    });
    const router = createCoreAdminCompatRouter(
      dependencies({ updateAgentProfile }),
    );
    const response = await router.dispatch(
      await mutationRequest(
        "PUT",
        `/agents/${DEFAULT_AGENT_ID}`,
        {
          id: DEFAULT_AGENT_ID,
          name: "Mate",
          persona: {
            name: "Mate",
            style: "温暖自然",
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
            search: { aggressiveness: "off" },
          },
          revision: 1,
        },
      ),
      runtime(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "config_revision_conflict",
        message: "revision_conflict",
      },
    });
  });

  it("enforces the shared 16 KiB body limit before profile parsing", async () => {
    const updateAgentProfile = vi.fn();
    const router = createCoreAdminCompatRouter(
      dependencies({ updateAgentProfile }),
    );
    const response = await router.dispatch(
      await mutationRequest(
        "PUT",
        `/agents/${DEFAULT_AGENT_ID}`,
        {},
        { contentLength: String(16 * 1024 + 1) },
      ),
      runtime(),
    );

    expect(response.status).toBe(413);
    expect(updateAgentProfile).not.toHaveBeenCalled();
  });
});
