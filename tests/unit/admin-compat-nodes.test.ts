import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import type { AdminCompatRuntime } from "@/server/admin/compat/router";
import { createAdminAuthStatusResponse } from "@/server/admin/compat/security";
import type { AdminCompatResources } from "@/server/admin/compat/types";
import type {
  AdminChannelNodeService,
} from "@/server/admin/compat/handlers/nodes";
import {
  createAdminChannelNodeService,
} from "@/server/admin/channel-nodes";
import {
  decryptChannelNodeBundle,
} from "@/server/admin/channel-node-certificates";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const NODE_ID = "20000000-0000-4000-8000-000000000021";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000022";

function nodeService(): AdminChannelNodeService {
  return {
    list: vi.fn<AdminChannelNodeService["list"]>(async () => [{
      id: NODE_ID,
      display_name: "客厅 Mac",
      status: "connected",
      supported_channel_types: ["imessage"],
      bound_connection_ids: [CONNECTION_ID],
      client_version: "0.1.0",
      certificate_expires_at: "2026-08-26T00:00:00.000Z",
      last_heartbeat_at: "2026-07-27T00:00:00.000Z",
      outbox: {
        pending_items: 2,
        pending_bytes: 512,
      },
    }]),
    createEnrollment: vi.fn<
      AdminChannelNodeService["createEnrollment"]
    >(async () => ({
      enrollment_id:
        "20000000-0000-4000-8000-000000000023",
      node_id: NODE_ID,
      token: "one-time-enrollment-token",
      expires_at: "2026-07-27T00:10:00.000Z",
      bundle: {
        format: "digitalmate-channel-node-v1",
        algorithm: "A256GCM",
        salt: "c2FsdA",
        iv: "aXY",
        ciphertext: "ZW5jcnlwdGVkLXByaXZhdGUtYnVuZGxl",
        auth_tag: "dGFn",
      },
    })),
    bind: vi.fn<AdminChannelNodeService["bind"]>(
      async () => undefined,
    ),
    unbind: vi.fn<AdminChannelNodeService["unbind"]>(
      async () => undefined,
    ),
    rotateCertificate: vi.fn<
      AdminChannelNodeService["rotateCertificate"]
    >(async () => ({
      enrollment_id:
        "20000000-0000-4000-8000-000000000024",
      node_id: NODE_ID,
      token: "one-time-rotation-token",
      expires_at: "2026-07-27T00:10:00.000Z",
      bundle: {
        format: "digitalmate-channel-node-v1",
        algorithm: "A256GCM",
        salt: "c2FsdA",
        iv: "aXY",
        ciphertext: "cm90YXRlZC1lbmNyeXB0ZWQtYnVuZGxl",
        auth_tag: "dGFn",
      },
    })),
    revoke: vi.fn<AdminChannelNodeService["revoke"]>(
      async () => undefined,
    ),
  };
}

function dependencies(
  service: AdminChannelNodeService,
): CoreAdminCompatDependencies {
  return {
    createAuthStatusResponse: async () =>
      Response.json({ authenticated: true }),
    digitalMateVersion: "0.1.0",
    upstreamTag: "v2.0.0.post3",
    upstreamCommit:
      "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
    compatApiRevision: "test",
    channelNodes: service,
  };
}

function runtime(): AdminCompatRuntime {
  return {
    security: {
      defaultUserId: USER_ID,
      appSecret: "test-app-secret-for-node-contract",
      appPasswordEnabled: false,
      production: false,
      trustProxyHeaders: false,
      loadSessionGeneration: async () => 0,
    },
    withUserDataLease: async (_userId, work) =>
      work(
        {} as AdminCompatResources,
        new AbortController().signal,
      ),
    resolveDefaultScope: async () => ({
      userId: USER_ID,
      agentId: AGENT_ID,
    }),
  };
}

async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    agent?: string | null;
  } = {},
): Promise<Request> {
  const headers = new Headers();
  if (options.agent !== null) {
    headers.set(
      "x-digitalmate-agent-id",
      options.agent ?? AGENT_ID,
    );
  }
  if (options.body !== undefined) {
    const status = await createAdminAuthStatusResponse(
      new Request(
        "http://localhost/api/admin/compat/auth/status",
      ),
      runtime().security,
    );
    const { csrf_token } = await status.json() as {
      csrf_token: string;
    };
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost");
    headers.set("x-csrf-token", csrf_token);
  }
  return new Request(
    `http://localhost/api/admin/compat${path}`,
    {
      method: options.method,
      headers,
      body:
        options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
    },
  );
}

describe("admin compatibility channel-node contract", () => {
  it("persists only the enrollment-token digest and returns the private key only inside ciphertext", async () => {
    const enrollmentToken =
      "test-enrollment-token-that-is-longer-than-thirty-two-bytes";
    let enrollmentParameters: readonly unknown[] | undefined;
    const query = vi.fn(
      async (sql: string, parameters?: readonly unknown[]) => {
        if (
          sql.includes("SELECT id, channel_type")
          && sql.includes("FROM channel_connections")
        ) {
          return {
            rows: [{
              id: CONNECTION_ID,
              channel_type: "imessage",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO channel_node_enrollments")) {
          enrollmentParameters = parameters;
        }
        return { rows: [], rowCount: 1 };
      },
    );
    const client = {
      query,
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as unknown as Pool;
    const service = createAdminChannelNodeService(pool, {
      issueCertificate: vi.fn(async () => ({
        certificate:
          "-----BEGIN CERTIFICATE-----\nNODE\n-----END CERTIFICATE-----",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----",
        fingerprint: Buffer.alloc(32, 7),
        expiresAt: new Date("2026-08-26T00:00:00.000Z"),
      })),
      serverCertificateAuthority:
        "-----BEGIN CERTIFICATE-----\nSERVER CA\n-----END CERTIFICATE-----",
      serverUrl: "wss://mate.example.com:9443/channel-node",
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      randomToken: () => enrollmentToken,
    });

    const enrollment = await service.createEnrollment({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      displayName: "客厅 Mac",
      supportedChannelTypes: ["imessage"],
      connectionIds: [CONNECTION_ID],
    });
    const serialized = JSON.stringify(enrollment);

    expect(enrollment.expires_at).toBe(
      "2026-07-27T00:10:00.000Z",
    );
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(enrollmentParameters?.[3]).toEqual(
      createHash("sha256")
        .update(enrollmentToken)
        .digest(),
    );
    expect(enrollmentParameters?.[3]).not.toEqual(
      Buffer.from(enrollmentToken),
    );
    await expect(
      decryptChannelNodeBundle(
        enrollment.bundle,
        enrollment.token,
      ),
    ).resolves.toMatchObject({
      node: {
        server_url:
          "wss://mate.example.com:9443/channel-node",
        connection_ids: [CONNECTION_ID],
      },
      files: {
        certificate_authority:
          expect.stringContaining("SERVER CA"),
        private_key: expect.stringContaining("SECRET"),
      },
    });
  });

  it("scopes node listing and revocation by both user and agent", async () => {
    const calls: Array<{
      sql: string;
      parameters?: readonly unknown[];
    }> = [];
    const query = vi.fn(
      async (sql: string, parameters?: readonly unknown[]) => {
        calls.push({ sql, parameters });
        if (sql.includes("FROM channel_runtime_nodes AS node")) {
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("UPDATE channel_runtime_nodes")
          && sql.includes("SET status = 'revoked'")
        ) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    const client = { query, release: vi.fn() };
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const service = createAdminChannelNodeService(pool, {
      issueCertificate: null,
      serverCertificateAuthority: null,
      serverUrl: "wss://mate.example.com:9443/channel-node",
    });

    await service.list({
      userId: USER_ID,
      agentId: AGENT_ID,
    });
    await service.revoke({
      scope: {
        userId: USER_ID,
        agentId: AGENT_ID,
      },
      nodeId: NODE_ID,
    });

    const list = calls.find(({ sql }) =>
      sql.includes("FROM channel_runtime_nodes AS node")
    );
    const revoke = calls.find(({ sql }) =>
      sql.includes("SET status = 'revoked'")
    );
    expect(list?.sql).toContain("node.agent_id = $2");
    expect(list?.parameters).toEqual([USER_ID, AGENT_ID]);
    expect(revoke?.sql).toContain("agent_id = $4");
    expect(revoke?.parameters).toEqual([
      NODE_ID,
      USER_ID,
      expect.any(Date),
      AGENT_ID,
    ]);
  });

  it("lists only operational metadata without certificate fingerprints or secrets", async () => {
    const service = nodeService();
    const router = createCoreAdminCompatRouter(
      dependencies(service),
    );
    const response = await router.dispatch(
      await request("/channel-nodes"),
      runtime(),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(JSON.parse(serialized)).toEqual([
      expect.objectContaining({
        id: NODE_ID,
        status: "connected",
        client_version: "0.1.0",
        supported_channel_types: ["imessage"],
        bound_connection_ids: [CONNECTION_ID],
        outbox: {
          pending_items: 2,
          pending_bytes: 512,
        },
      }),
    ]);
    expect(serialized).not.toMatch(
      /fingerprint|private[_-]?key|certificate_pem/i,
    );
  });

  it("creates a ten-minute one-time enrollment with only an encrypted bundle", async () => {
    const service = nodeService();
    const router = createCoreAdminCompatRouter(
      dependencies(service),
    );
    const response = await router.dispatch(
      await request("/channel-nodes/enrollments", {
        method: "POST",
        body: {
          display_name: "客厅 Mac",
          supported_channel_types: ["imessage"],
          connection_ids: [CONNECTION_ID],
        },
      }),
      runtime(),
    );
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      node_id: NODE_ID,
      token: "one-time-enrollment-token",
      bundle: {
        format: "digitalmate-channel-node-v1",
        algorithm: "A256GCM",
      },
    });
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toMatch(
      /private_key|certificate_fingerprint|token_hash/i,
    );
    expect(service.createEnrollment).toHaveBeenCalledWith(
      {
        scope: { userId: USER_ID, agentId: AGENT_ID },
        displayName: "客厅 Mac",
        supportedChannelTypes: ["imessage"],
        connectionIds: [CONNECTION_ID],
      },
      expect.any(AbortSignal),
    );
  });

  it("binds, unbinds, rotates and revokes a node with scoped mutations", async () => {
    const service = nodeService();
    const router = createCoreAdminCompatRouter(
      dependencies(service),
    );

    const bind = await router.dispatch(
      await request(`/channel-nodes/${NODE_ID}/bindings`, {
        method: "POST",
        body: { connection_id: CONNECTION_ID },
      }),
      runtime(),
    );
    const unbind = await router.dispatch(
      await request(
        `/channel-nodes/${NODE_ID}/bindings/${CONNECTION_ID}`,
        { method: "DELETE", body: {} },
      ),
      runtime(),
    );
    const rotate = await router.dispatch(
      await request(
        `/channel-nodes/${NODE_ID}/certificate/rotate`,
        { method: "POST", body: {} },
      ),
      runtime(),
    );
    const revoke = await router.dispatch(
      await request(`/channel-nodes/${NODE_ID}/revoke`, {
        method: "POST",
        body: {},
      }),
      runtime(),
    );

    expect([
      bind.status,
      unbind.status,
      rotate.status,
      revoke.status,
    ]).toEqual([200, 200, 200, 200]);
    expect(service.bind).toHaveBeenCalledWith(
      {
        scope: { userId: USER_ID, agentId: AGENT_ID },
        nodeId: NODE_ID,
        connectionId: CONNECTION_ID,
      },
      expect.any(AbortSignal),
    );
    expect(service.unbind).toHaveBeenCalledWith(
      {
        scope: { userId: USER_ID, agentId: AGENT_ID },
        nodeId: NODE_ID,
        connectionId: CONNECTION_ID,
      },
      expect.any(AbortSignal),
    );
    expect(service.rotateCertificate).toHaveBeenCalledWith(
      {
        scope: { userId: USER_ID, agentId: AGENT_ID },
        nodeId: NODE_ID,
      },
      expect.any(AbortSignal),
    );
    expect(service.revoke).toHaveBeenCalledWith(
      {
        scope: { userId: USER_ID, agentId: AGENT_ID },
        nodeId: NODE_ID,
      },
      expect.any(AbortSignal),
    );
  });

  it("requires the canonical agent header and CSRF boundary", async () => {
    const service = nodeService();
    const router = createCoreAdminCompatRouter(
      dependencies(service),
    );
    const missingAgent = await router.dispatch(
      await request("/channel-nodes", { agent: null }),
      runtime(),
    );
    const missingCsrf = await router.dispatch(
      new Request(
        "http://localhost/api/admin/compat/channel-nodes/enrollments",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-digitalmate-agent-id": AGENT_ID,
          },
          body: JSON.stringify({
            display_name: "客厅 Mac",
            supported_channel_types: ["imessage"],
          }),
        },
      ),
      runtime(),
    );

    expect(missingAgent.status).toBe(400);
    expect(missingCsrf.status).toBe(403);
    expect(service.createEnrollment).not.toHaveBeenCalled();
  });
});
