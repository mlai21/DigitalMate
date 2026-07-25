import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import {
  ClientEvent,
  SyncState,
  type ICreateClientOpts,
  type MatrixClient,
} from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createMatrixAdapter,
} from "@/server/channels/adapters/matrix";
import {
  createMatrixCryptoStore,
  deleteMatrixCryptoStoreDirectory,
} from "@/server/channels/adapters/matrix/crypto-store";
import {
  createMatrixAttachmentFetcher,
  createMatrixClient,
  mapMatrixError,
  type MatrixClientPort,
} from "@/server/channels/adapters/matrix/transport";
import {
  ChannelAdapterRegistry,
  registerMatrixChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  createChannelAccessControl,
} from "@/server/channels/runtime/access";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-matrix",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  require_mention: true,
  homeserver: "https://matrix.example.org",
  user_id: "@digitalmate:example.org",
  access_token: "matrix-access-secret",
  password: "",
  device_name: "digitalmate-worker",
  group_allow_from: ["!team-room:example.org"],
  groups: {
    "!team-room:example.org": {
      autoReply: true,
      requireMention: true,
    },
  },
  encryption: true,
  vision_enabled: true,
  history_limit: 50,
  sync_timeout_ms: 30_000,
  mention_pill_in_body: true,
  outbound_structured_mentions: true,
  streaming_enabled: true,
} as const;
const STORAGE_KEY = Buffer.alloc(32, 7);

defineChannelContract({
  type: "matrix",

  assertConfig() {
    const adapter = testAdapter(createFakeMatrixClient());
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      ...CONFIG,
      access_token: CONFIG.access_token,
      password: null,
    });
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        access_token: "",
        password: "",
      })
    ).toThrow("matrix_credentials_required");
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        homeserver: "file:///tmp/matrix",
      })
    ).toThrow("matrix_homeserver_invalid");
    expect(JSON.stringify(adapter.manifest)).not.toContain(
      CONFIG.access_token,
    );
  },

  async assertLifecycle() {
    const client = createFakeMatrixClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);

    await Promise.all([
      adapter.start(context),
      adapter.start(context),
    ]);
    expect(client.starts).toBe(1);
    expect(client.startOptions[0]).toMatchObject({
      initialSyncLimit: 50,
      syncTimeoutMs: 30_000,
    });
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });

    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(client.stops).toBe(1);
  },

  async assertInbound() {
    const adapter = testAdapter(createFakeMatrixClient());
    const direct = await adapter.normalizeInbound(
      await fixture("direct-encrypted.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("group-pill.json"),
      CONTEXT,
    );
    const edit = await adapter.normalizeInbound(
      await fixture("edit.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "$event-123:example.org",
      externalConversationId: "!dm-room:example.org",
      externalSenderId: "@alice:example.org",
      chatType: "direct",
      mentioned: true,
      text: "加密消息已解密",
      thread: { replyToEventId: "$parent:example.org" },
      attachments: [],
      rawSummary: {
        encrypted: true,
        eventType: "m.room.message",
      },
      replyHandle: {
        publicFields: {
          roomId: "!dm-room:example.org",
          senderId: "@alice:example.org",
          eventId: "$event-123:example.org",
        },
        secretFields: {},
      },
    });
    expect(group).toMatchObject({
      chatType: "group",
      mentioned: true,
      externalConversationId: "!team-room:example.org",
    });
    expect(edit).toBeNull();
  },

  async assertStableIds() {
    const adapter = testAdapter(createFakeMatrixClient());
    const payload = await fixture("direct-encrypted.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("$event-123:example.org");
  },

  async assertOutbound() {
    const client = createFakeMatrixClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const result = await adapter.send(delivery, {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });

    expect(result.externalMessageId).toBe(
      "$sent-event:example.org",
    );
    expect(client.sent[0]).toMatchObject({
      roomId: "!dm-room:example.org",
      txnId: "delivery-matrix-1",
      content: {
        msgtype: "m.text",
        body: "完整回复",
        "m.mentions": {
          user_ids: ["@alice:example.org"],
        },
        "m.relates_to": {
          "m.in_reply_to": {
            event_id: "$event-123:example.org",
          },
        },
      },
    });
    expect(client.sent[0]?.content.formatted_body).toContain(
      "https://matrix.to/#/@alice:example.org",
    );

    const edited = await adapter.streaming!(
      {
        ...delivery,
        body: "完整回复（更新）",
      },
      {
        sequence: 2,
        final: true,
        previousResult: result,
      },
    );
    expect(edited.externalMessageId).toBe(
      "$sent-event:example.org",
    );
    expect(client.sent[1]).toMatchObject({
      content: {
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: "$sent-event:example.org",
        },
        "m.new_content": {
          body: "完整回复（更新）",
          msgtype: "m.text",
        },
      },
    });
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const error = mapMatrixError({
      httpStatus: 429,
      errcode: "M_LIMIT_EXCEEDED",
      data: { retry_after_ms: 1_250 },
      message: CONFIG.access_token,
    });
    const adapter = testAdapter(
      createFakeMatrixClient({ startError: error }),
    );

    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const health = await adapter.health();
    expect(health).toMatchObject({
      status: "degraded",
      error: {
        code: "rate_limited",
        detail: "rate_limited",
      },
    });
    expect(health.nextAttemptAt?.getTime()).toBe(
      NOW.getTime() + 1_250,
    );
    expect(JSON.stringify(health)).not.toContain(
      CONFIG.access_token,
    );
  },

  async assertShutdown() {
    const client = createFakeMatrixClient();
    const adapter = testAdapter(client);
    const controller = new AbortController();
    await adapter.start(
      runtimeContext(adapter, controller.signal),
    );

    controller.abort();
    await vi.waitFor(async () => {
      expect(client.stops).toBe(1);
      expect(await adapter.health()).toMatchObject({
        status: "stopped",
      });
    });
  },
});

describe("Matrix protocol and privacy boundaries", () => {
  it("registers the production adapter", () => {
    const registry = new ChannelAdapterRegistry();
    registerMatrixChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["matrix"]);
    expect(
      registry.create("matrix", { now: () => NOW }).manifest.type,
    ).toBe("matrix");
  });

  it("passes decrypted encrypted-room events into durable ingress", async () => {
    const client = createFakeMatrixClient();
    const acceptInbound = vi.fn(async () => ({
      kind: "accepted" as const,
      eventId: "stored-event-1",
    }));
    const adapter = createMatrixAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
      cryptoStorageKey: STORAGE_KEY,
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));

    await client.emitEvent(
      await fixture("direct-encrypted.json"),
    );

    expect(acceptInbound).toHaveBeenCalledTimes(1);
    expect(acceptInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "$event-123:example.org",
        encrypted: true,
        content: expect.objectContaining({
          body: "加密消息已解密",
        }),
      }),
      expect.objectContaining({
        connectionId: CONTEXT.connectionId,
      }),
      {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
    );
    await adapter.stop("shutdown");
  });

  it("maps Matrix errors and preserves retry_after_ms", async () => {
    const errors = await fixture<Array<{
      status: number;
      errcode: string;
      retry_after_ms?: number;
      expectedCode: string;
      retryable: boolean;
    }>>("errors.json");
    for (const item of errors) {
      const error = mapMatrixError({
        httpStatus: item.status,
        errcode: item.errcode,
        data: {
          retry_after_ms: item.retry_after_ms,
        },
        message: `server leaked ${CONFIG.password}`,
      });
      expect(error).toMatchObject({
        code: item.expectedCode,
        retryable: item.retryable,
        message: item.expectedCode,
      });
      expect(error.retryAfterMs ?? null).toBe(
        item.retry_after_ms ?? null,
      );
    }
  });

  it("supports access-token ownership checks and password device login", async () => {
    const tokenSdk = createFakeMatrixSdkFactory({
      userId: CONFIG.user_id,
    });
    const tokenPort = createMatrixClient(
      testAdapter(createFakeMatrixClient())
        .validateConfig({ ...CONFIG, encryption: false }),
      {
        identity: {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
          connectionId: CONTEXT.connectionId,
        },
        cryptoStorageKey: null,
      },
      tokenSdk.factory,
    );
    await expect(tokenPort.start(matrixStartInput()))
      .resolves.toMatchObject({
        botUserId: CONFIG.user_id,
        deviceId: "FAKE_DEVICE",
        syncToken: "sync-token-prepared",
      });
    expect(tokenSdk.created).toHaveLength(1);
    expect(tokenSdk.created[0]).toMatchObject({
      baseUrl: CONFIG.homeserver,
      userId: CONFIG.user_id,
      accessToken: CONFIG.access_token,
    });
    expect(tokenSdk.auth.whoami).toHaveBeenCalledOnce();
    expect(tokenSdk.auth.startClient).toHaveBeenCalledWith({
      initialSyncLimit: 50,
      pollTimeout: 30_000,
      disablePresence: true,
      lazyLoadMembers: false,
    });
    await tokenPort.stop();

    const passwordSdk = createFakeMatrixSdkFactory({
      userId: CONFIG.user_id,
    });
    const passwordPort = createMatrixClient(
      testAdapter(createFakeMatrixClient()).validateConfig({
        ...CONFIG,
        access_token: "",
        password: "matrix-password-secret",
        encryption: false,
      }),
      {
        identity: {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
          connectionId: CONTEXT.connectionId,
        },
        cryptoStorageKey: null,
      },
      passwordSdk.factory,
    );
    await passwordPort.start(matrixStartInput());
    expect(passwordSdk.created).toHaveLength(2);
    expect(passwordSdk.login.loginRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "m.login.password",
        password: "matrix-password-secret",
        initial_device_display_name: "digitalmate-worker",
        device_id: expect.stringMatching(/^DIGITALMATE_[A-F0-9]{24}$/),
      }),
    );
    expect(passwordSdk.created[1]).toMatchObject({
      accessToken: "logged-in-access-token",
      userId: CONFIG.user_id,
      deviceId: "FAKE_DEVICE",
    });
    expect(passwordSdk.auth.whoami).not.toHaveBeenCalled();
    await passwordPort.stop();
  });

  it("initializes Rust Crypto with a private persistent key and stable device", async () => {
    const rootDir = await mkdtemp(
      path.join(
        os.tmpdir(),
        "digitalmate-matrix-sdk-",
      ),
    );
    const sdk = createFakeMatrixSdkFactory({
      userId: CONFIG.user_id,
    });
    const port = createMatrixClient(
      testAdapter(createFakeMatrixClient())
        .validateConfig(CONFIG),
      {
        identity: {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
          connectionId: CONTEXT.connectionId,
        },
        cryptoStorageKey: STORAGE_KEY,
        cryptoStorageRoot: rootDir,
      },
      sdk.factory,
    );

    await port.start(matrixStartInput());
    expect(sdk.auth.initRustCrypto).toHaveBeenCalledWith({
      useIndexedDB: true,
      cryptoDatabasePrefix:
        expect.stringMatching(/^digitalmate-matrix-[a-f0-9]{32}$/),
      storageKey: STORAGE_KEY,
    });
    await port.stop();
    const encryptedStore = await readFile(
      path.join(
        rootDir,
        CONTEXT.connectionId,
        "crypto-store.bin",
      ),
    );
    expect(encryptedStore.subarray(0, 8).toString("ascii"))
      .toBe("DMATRIX1");
    await rm(rootDir, { recursive: true, force: true });
  });

  it("accepts an allowlisted Matrix room through the shared group policy", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            enabled: true,
            deleted_at: null,
            config: {
              group_policy: "allowlist",
              require_mention: true,
              group_allow_from: [
                "!team-room:example.org",
              ],
            },
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Pool;
    const event = await testAdapter(
      createFakeMatrixClient(),
    ).normalizeInbound(
      await fixture("group-pill.json"),
      CONTEXT,
    );
    expect(event).not.toBeNull();

    await expect(
      createChannelAccessControl(pool).evaluate(
        {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
        },
        event!,
      ),
    ).resolves.toEqual({ kind: "allowed", allowed: true });
  });

  it("normalizes and decrypts Matrix encrypted image attachments without exposing the token", async () => {
    const adapter = testAdapter(createFakeMatrixClient());
    const event = await adapter.normalizeInbound(
      await fixture("encrypted-image.json"),
      CONTEXT,
    );
    expect(event).toMatchObject({
      attachments: [{
        externalAttachmentId:
          "$image-event:example.org:0",
        fileName: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 8,
      }],
      permission: {
        attachmentsPresent: true,
        skills: "none",
        tools: false,
        webSearch: false,
      },
      rawSummary: {
        encrypted: true,
      },
    });
    expect(JSON.stringify(event?.rawSummary)).not.toContain(
      "fixture-media-token",
    );

    const request = vi.fn(async () => ({
      status: 200,
      body: Buffer.from("5uxqCJxQZ50=", "base64"),
    }));
    const fetcher = createMatrixAttachmentFetcher({
      request,
    });
    const descriptor = event!.attachments[0]!;
    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "pixel.png",
      mimeType: "image/png",
      sizeBytes: 8,
    });
    const stream = await fetcher.download(descriptor);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url:
          "https://matrix.example.org/_matrix/client/v1/media/download/example.org/media-123",
        headers: {
          authorization: "Bearer fixture-media-token",
        },
        responseType: "bytes",
      }),
    );
  });

  it("encrypts the file-backed crypto database and binds its identity", async () => {
    const rootDir = await mkdtemp(
      path.join(
        os.tmpdir(),
        "digitalmate-matrix-store-",
      ),
    );
    const store = createMatrixCryptoStore({
      rootDir,
      identity: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
        connectionId: CONTEXT.connectionId,
      },
      encryptionKey: STORAGE_KEY,
    });
    const databaseName = `${store.databasePrefix}-crypto`;
    const database = await openFixtureDatabase(databaseName);
    const transaction = database.transaction(
      "sessions",
      "readwrite",
    );
    transaction.objectStore("sessions").put(
      "megolm-session-secret",
      "session-1",
    );
    await fixtureTransactionDone(transaction);
    database.close();
    await store.flush("sync-token-secret");
    const bytes = await readFile(store.filePath);

    expect(store.filePath).toBe(
      path.join(
        rootDir,
        CONTEXT.connectionId,
        "crypto-store.bin",
      ),
    );
    expect(bytes.toString("utf8")).not.toContain(
      "megolm-session-secret",
    );
    expect(bytes.toString("utf8")).not.toContain(
      "sync-token-secret",
    );
    await deleteFixtureDatabase(databaseName);
    await expect(store.prepare()).resolves.toBe(
      "sync-token-secret",
    );
    const restored = await openFixtureDatabase(
      databaseName,
      false,
    );
    const restoredTransaction = restored.transaction(
      "sessions",
      "readonly",
    );
    await expect(fixtureRequestResult(
      restoredTransaction
        .objectStore("sessions")
        .get("session-1"),
    )).resolves.toBe("megolm-session-secret");
    await fixtureTransactionDone(restoredTransaction);
    restored.close();
    const otherIdentityStore = createMatrixCryptoStore({
      rootDir,
      identity: {
        userId: CONTEXT.userId,
        agentId: "other-agent",
        connectionId: CONTEXT.connectionId,
      },
      encryptionKey: STORAGE_KEY,
    });
    await expect(
      otherIdentityStore.prepare(),
    ).rejects.toThrow("matrix_crypto_store_identity_mismatch");
    await deleteFixtureDatabase(databaseName);
    await rm(rootDir, { recursive: true, force: true });
    await expect(
      deleteMatrixCryptoStoreDirectory(
        rootDir,
        "../other-user",
      ),
    ).rejects.toThrow(
      "matrix_crypto_store_identity_invalid",
    );
  });
});

function testAdapter(client: FakeMatrixClient) {
  return createMatrixAdapter({
    clientFactory: () => client,
    autoListen: false,
    cryptoStorageKey: STORAGE_KEY,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createMatrixAdapter>,
  signal = new AbortController().signal,
) {
  return {
    connectionId: CONTEXT.connectionId,
    agentId: CONTEXT.agentId,
    config: adapter.validateConfig(CONFIG),
    signal,
    now: () => NOW,
  };
}

function outboundDelivery() {
  return {
    id: "delivery-matrix-1",
    eventId: "$event-123:example.org",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-1",
    body: "完整回复",
    recipient: {
      externalConversationId: "!dm-room:example.org",
      externalUserId: "@alice:example.org",
      chatType: "direct" as const,
    },
    replyHandle: {
      publicFields: {
        roomId: "!dm-room:example.org",
        senderId: "@alice:example.org",
        eventId: "$event-123:example.org",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeMatrixClient = MatrixClientPort & {
  starts: number;
  stops: number;
  startOptions: Array<{
    initialSyncLimit: number;
    syncTimeoutMs: number;
  }>;
  sent: Array<{
    roomId: string;
    content: Record<string, unknown>;
    txnId: string;
  }>;
  emitEvent(payload: unknown): Promise<void>;
};

function createFakeMatrixClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeMatrixClient {
  let onEvent: ((payload: unknown) => Promise<void>) | null = null;
  return {
    starts: 0,
    stops: 0,
    startOptions: [],
    sent: [],
    async start(input) {
      this.starts += 1;
      this.startOptions.push({
        initialSyncLimit: input.initialSyncLimit,
        syncTimeoutMs: input.syncTimeoutMs,
      });
      onEvent = (payload) =>
        input.onEvent(payload as Parameters<
          typeof input.onEvent
        >[0]);
      if (options.startError) throw options.startError;
      return {
        botUserId: CONFIG.user_id,
        deviceId: "DIGITALMATE_DEVICE",
        syncToken: "sync-token-1",
      };
    },
    async stop() {
      this.stops += 1;
    },
    async sendMessage(input) {
      this.sent.push(input);
      return { eventId: "$sent-event:example.org" };
    },
    async sendTyping() {
      return undefined;
    },
    async emitEvent(payload) {
      if (!onEvent) throw new Error("matrix_listener_missing");
      await onEvent(payload);
    },
  };
}

async function fixture<T = Record<string, unknown>>(
  name: string,
): Promise<T> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/matrix",
        name,
      ),
      "utf8",
    ),
  ) as T;
}

function matrixStartInput() {
  return {
    signal: new AbortController().signal,
    initialSyncLimit: 50,
    syncTimeoutMs: 30_000,
    onEvent: vi.fn(async () => undefined),
    onError: vi.fn(),
  };
}

function createFakeMatrixSdkFactory(input: Readonly<{
  userId: string;
}>) {
  const created: ICreateClientOpts[] = [];
  const syncListeners: Array<(
    state: SyncState,
    previous: SyncState | null,
    data?: { nextSyncToken?: string },
  ) => void> = [];
  const store = {
    token: null as string | null,
    getSyncToken() {
      return this.token;
    },
    setSyncToken(token: string) {
      this.token = token;
    },
  };
  const login = {
    loginRequest: vi.fn(async () => ({
      access_token: "logged-in-access-token",
      user_id: input.userId,
      device_id: "FAKE_DEVICE",
    })),
  };
  const auth = {
    whoami: vi.fn(async () => ({
      user_id: input.userId,
      device_id: "FAKE_DEVICE",
    })),
    startClient: vi.fn(async () => {
      store.token = "sync-token-prepared";
      for (const listener of syncListeners) {
        listener(SyncState.Prepared, null, {
          nextSyncToken: store.token,
        });
      }
    }),
    stopClient: vi.fn(),
    initRustCrypto: vi.fn(async () => undefined),
  };
  const factory = vi.fn((options: ICreateClientOpts) => {
    created.push(options);
    if (!options.accessToken) {
      return login as unknown as MatrixClient;
    }
    return {
      ...auth,
      store,
      on(event: ClientEvent, listener: unknown) {
        if (event === ClientEvent.Sync) {
          syncListeners.push(listener as (
            state: SyncState,
            previous: SyncState | null,
            data?: { nextSyncToken?: string },
          ) => void);
        }
        return this;
      },
    } as unknown as MatrixClient;
  });
  return { factory, created, login, auth };
}

function openFixtureDatabase(
  name: string,
  createStore = true,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (createStore) {
        request.result.createObjectStore("sessions");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function deleteFixtureDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

function fixtureRequestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function fixtureTransactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
