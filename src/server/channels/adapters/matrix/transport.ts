import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";

import {
  ClientEvent,
  EventType,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
} from "matrix-js-sdk";

import type {
  AdapterDependencies,
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";

import type { MatrixConfig } from "./config";
import {
  createMatrixCryptoStore,
  defaultMatrixCryptoStorageRoot,
  type MatrixCryptoStoreIdentity,
} from "./crypto-store";
import type {
  MatrixInboundFrame,
} from "./normalize";

export type MatrixTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "network_unreachable"
  | "rate_limited"
  | "runtime_prerequisite_missing"
  | "unknown";

export class MatrixTransportError extends Error {
  readonly code: MatrixTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: MatrixTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "MatrixTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type MatrixClientStartInput = Readonly<{
  signal: AbortSignal;
  initialSyncLimit: number;
  syncTimeoutMs: number;
  onEvent(payload: MatrixInboundFrame): Promise<void>;
  onError(error: Error): void;
}>;

export type MatrixClientPort = Readonly<{
  start(input: MatrixClientStartInput): Promise<Readonly<{
    botUserId: string;
    deviceId: string;
    syncToken: string | null;
  }>>;
  stop(): Promise<void>;
  sendMessage(input: Readonly<{
    roomId: string;
    content: Record<string, unknown>;
    txnId: string;
  }>): Promise<Readonly<{ eventId: string }>>;
  sendTyping(input: Readonly<{
    roomId: string;
    active: boolean;
    timeoutMs: number;
  }>): Promise<void>;
}>;

export type MatrixClientFactory = (
  config: MatrixConfig,
  options: Readonly<{
    identity: MatrixCryptoStoreIdentity;
    cryptoStorageKey: Uint8Array | null;
    cryptoStorageRoot?: string;
  }>,
) => MatrixClientPort;

export type MatrixSdkClientFactory = typeof createClient;

export function createMatrixClient(
  config: MatrixConfig,
  options: Readonly<{
    identity: MatrixCryptoStoreIdentity;
    cryptoStorageKey: Uint8Array | null;
    cryptoStorageRoot?: string;
  }>,
  createSdkClient: MatrixSdkClientFactory = createClient,
): MatrixClientPort {
  let client: MatrixClient | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let flushTail: Promise<void> = Promise.resolve();
  const store = config.encryption
    ? createRequiredCryptoStore(config, options)
    : null;

  return {
    async start(input) {
      input.signal.throwIfAborted();
      stopped = false;
      const deviceId = stableDeviceId(
        options.identity.connectionId,
      );
      let accessToken = config.access_token;
      let authenticatedUserId = config.user_id;
      let authenticatedDeviceId = deviceId;

      try {
        if (config.password) {
          const loginClient = createSdkClient({
            baseUrl: config.homeserver,
            localTimeoutMs:
              config.sync_timeout_ms + 10_000,
          });
          const login = await loginClient.loginRequest({
            type: "m.login.password",
            identifier: {
              type: "m.id.user",
              user: config.user_id,
            },
            password: config.password,
            device_id: deviceId,
            initial_device_display_name: config.device_name,
          });
          accessToken = login.access_token;
          authenticatedUserId = login.user_id;
          authenticatedDeviceId = login.device_id;
        }
        if (!accessToken) {
          throw new MatrixTransportError({
            code: "credential_invalid",
            retryable: false,
          });
        }

        const restoredSyncToken = await store?.prepare() ?? null;
        const activeClient = createSdkClient({
          baseUrl: config.homeserver,
          userId: authenticatedUserId,
          accessToken,
          deviceId: authenticatedDeviceId,
          timelineSupport: true,
          localTimeoutMs: config.sync_timeout_ms + 10_000,
        });
        client = activeClient;
        if (!config.password) {
          const whoami = await activeClient.whoami();
          if (whoami.user_id !== config.user_id) {
            throw new MatrixTransportError({
              code: "credential_invalid",
              retryable: false,
            });
          }
          authenticatedUserId = whoami.user_id;
          authenticatedDeviceId =
            whoami.device_id ?? authenticatedDeviceId;
        }
        if (restoredSyncToken) {
          activeClient.store.setSyncToken(restoredSyncToken);
        }
        if (config.encryption) {
          await activeClient.initRustCrypto({
            useIndexedDB: true,
            cryptoDatabasePrefix: store!.databasePrefix,
            storageKey: options.cryptoStorageKey!,
          });
        }

        await startAndWaitForPrepared(
          activeClient,
          input,
          {
            homeserver: config.homeserver,
            accessToken,
            visionEnabled: config.vision_enabled,
          },
          store
            ? (syncToken) => {
                flushTail = flushTail
                  .then(() => store.flush(syncToken))
                  .catch((error: unknown) => {
                    input.onError(mapMatrixError(error));
                  });
              }
            : undefined,
        );
        return {
          botUserId: authenticatedUserId,
          deviceId: authenticatedDeviceId,
          syncToken: activeClient.store.getSyncToken(),
        };
      } catch (error) {
        await stopInternal();
        throw mapMatrixError(error);
      }
    },

    stop() {
      return stopInternal();
    },

    async sendMessage(input) {
      const activeClient = requireClient(client);
      const response = await activeClient.sendEvent(
        input.roomId,
        EventType.RoomMessage,
        input.content as never,
        input.txnId,
      );
      if (!response.event_id) {
        throw new MatrixTransportError({
          code: "unknown",
          retryable: true,
        });
      }
      return { eventId: response.event_id };
    },

    async sendTyping(input) {
      await requireClient(client).sendTyping(
        input.roomId,
        input.active,
        input.timeoutMs,
      );
    },
  };

  async function stopInternal(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (stopped) return;
      stopped = true;
      const activeClient = client;
      client = null;
      activeClient?.stopClient();
      await flushTail;
      if (activeClient && store) {
        await store.flush(activeClient.store.getSyncToken());
      }
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }
}

async function startAndWaitForPrepared(
  client: MatrixClient,
  input: MatrixClientStartInput,
  media: Readonly<{
    homeserver: string;
    accessToken: string;
    visionEnabled: boolean;
  }>,
  scheduleFlush?: (syncToken: string | null) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome: "resolve" | "reject",
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      if (outcome === "resolve") {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = () =>
      finish(
        "reject",
        new MatrixTransportError({
          code: "network_unreachable",
          retryable: true,
        }),
      );
    const onSync = (
      state: SyncState,
      _previous: SyncState | null,
      data?: Readonly<{
        nextSyncToken?: string;
        error?: Error;
      }>,
    ) => {
      if (
        state === SyncState.Prepared
        || state === SyncState.Syncing
      ) {
        scheduleFlush?.(
          data?.nextSyncToken
          ?? client.store.getSyncToken(),
        );
      }
      if (state === SyncState.Prepared) {
        finish("resolve");
      } else if (state === SyncState.Error) {
        const mapped = mapMatrixError(data?.error);
        input.onError(mapped);
        if (!settled) finish("reject", mapped);
      }
    };
    client.on(ClientEvent.Sync, onSync);
    client.on(ClientEvent.Event, (event) => {
      void handleMatrixEvent(client, event, input, media)
        .catch((error: unknown) => {
          input.onError(mapMatrixError(error));
        });
    });
    input.signal.addEventListener("abort", onAbort, {
      once: true,
    });
    void client.startClient({
      initialSyncLimit: input.initialSyncLimit,
      pollTimeout: input.syncTimeoutMs,
      disablePresence: true,
      lazyLoadMembers: false,
    }).catch((error: unknown) => {
      finish("reject", mapMatrixError(error));
    });
  });
}

async function handleMatrixEvent(
  client: MatrixClient,
  event: MatrixEvent,
  input: MatrixClientStartInput,
  media: Readonly<{
    homeserver: string;
    accessToken: string;
    visionEnabled: boolean;
  }>,
): Promise<void> {
  const eventId = event.getId();
  const roomId = event.getRoomId();
  const senderId = event.getSender();
  const botUserId = client.getUserId();
  if (!eventId || !roomId || !senderId || !botUserId) return;
  if (event.isEncrypted() && !event.getClearContent()) {
    await client.decryptEventIfNeeded(event);
  }
  if (event.isDecryptionFailure()) return;
  const room = client.getRoom(roomId);
  const content =
    event.getClearContent() ?? event.getContent();
  await input.onEvent({
    eventId,
    roomId,
    senderId,
    botUserId,
    eventType: event.getType(),
    timestamp: event.getTs(),
    isDirect: isDirectRoom(client, roomId),
    encrypted:
      event.isEncrypted()
      || room?.hasEncryptionStateEvent() === true,
    visionEnabled: media.visionEnabled,
    mediaHomeserver: media.homeserver,
    mediaAccessToken: media.accessToken,
    content,
  });
}

function isDirectRoom(
  client: MatrixClient,
  roomId: string,
): boolean {
  const directContent = (
    client.getAccountData as unknown as (
      eventType: string,
    ) => MatrixEvent | undefined
  )("m.direct")
    ?.getContent() as Record<string, unknown> | undefined;
  if (directContent) {
    for (const roomIds of Object.values(directContent)) {
      if (Array.isArray(roomIds) && roomIds.includes(roomId)) {
        return true;
      }
    }
  }
  const room = client.getRoom(roomId);
  return Boolean(
    room && room.getJoinedMembers().length <= 2,
  );
}

function createRequiredCryptoStore(
  config: MatrixConfig,
  options: Readonly<{
    identity: MatrixCryptoStoreIdentity;
    cryptoStorageKey: Uint8Array | null;
    cryptoStorageRoot?: string;
  }>,
) {
  if (!options.cryptoStorageKey) {
    throw new MatrixTransportError({
      code: "runtime_prerequisite_missing",
      retryable: false,
    });
  }
  return createMatrixCryptoStore({
    rootDir: options.cryptoStorageRoot
      ?? defaultMatrixCryptoStorageRoot(),
    identity: options.identity,
    encryptionKey: options.cryptoStorageKey,
  });
}

function stableDeviceId(connectionId: string): string {
  return `DIGITALMATE_${
    createHash("sha256")
      .update(connectionId)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase()
  }`;
}

function requireClient(
  client: MatrixClient | null,
): MatrixClient {
  if (!client) {
    throw new MatrixTransportError({
      code: "network_unreachable",
      retryable: true,
    });
  }
  return client;
}

export function mapMatrixError(
  error: unknown,
): MatrixTransportError {
  if (error instanceof MatrixTransportError) return error;
  const record = asRecord(error);
  const data = asRecord(record.data);
  const status = numberValue(record.httpStatus)
    ?? numberValue(record.statusCode)
    ?? numberValue(record.status);
  const errcode = stringValue(record.errcode)
    ?? stringValue(data.errcode);
  const retryAfterMs = nonNegativeInteger(
    data.retry_after_ms,
  ) ?? nonNegativeInteger(record.retry_after_ms);

  if (
    status === 401
    || errcode === "M_UNKNOWN_TOKEN"
    || errcode === "M_MISSING_TOKEN"
    || errcode === "M_UNAUTHORIZED"
  ) {
    return new MatrixTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (status === 403 || errcode === "M_FORBIDDEN") {
    return new MatrixTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (
    status === 429
    || errcode === "M_LIMIT_EXCEEDED"
  ) {
    return new MatrixTransportError({
      code: "rate_limited",
      retryable: true,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
  }
  return new MatrixTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

export function createMatrixAttachmentFetcher(
  http?: NonNullable<AdapterDependencies["http"]>,
) {
  const client = http ?? matrixHttpClient();
  return {
    async inspect(
      descriptor: InboundAttachmentDescriptor,
    ) {
      if (
        !descriptor.fileName
        || !descriptor.mimeType
        || descriptor.sizeBytes === null
      ) {
        throw new Error(
          "matrix_attachment_metadata_incomplete",
        );
      }
      return {
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
      };
    },

    async download(
      descriptor: InboundAttachmentDescriptor,
      signal = new AbortController().signal,
    ): Promise<AsyncIterable<Uint8Array>> {
      const source = descriptor.source;
      const url = matrixMediaDownloadUrl(
        requiredSource(source, "homeserver"),
        requiredSource(source, "mxcUrl"),
      );
      const response = await client.request({
        method: "GET",
        url,
        headers: {
          authorization:
            `Bearer ${requiredSource(source, "accessToken")}`,
        },
        responseType: "bytes",
        signal,
      });
      const bytes = toBytes(response.body);
      if (
        response.status < 200
        || response.status >= 300
        || !bytes
      ) {
        throw new Error("matrix_attachment_download_failed");
      }
      const plaintext = source.encryptedFile
        ? decryptMatrixAttachment(
            bytes,
            source.encryptedFile,
          )
        : bytes;
      return singleChunk(plaintext);
    },
  };
}

function matrixMediaDownloadUrl(
  homeserver: string,
  mxcUrl: string,
): string {
  const normalizedHomeserver = new URL(homeserver);
  if (
    !["http:", "https:"].includes(
      normalizedHomeserver.protocol,
    )
    || !mxcUrl.startsWith("mxc://")
  ) {
    throw new Error("matrix_attachment_url_invalid");
  }
  const resource = mxcUrl.slice("mxc://".length);
  const separator = resource.indexOf("/");
  if (separator <= 0 || separator === resource.length - 1) {
    throw new Error("matrix_attachment_url_invalid");
  }
  const serverName = resource.slice(0, separator);
  const mediaId = resource.slice(separator + 1);
  normalizedHomeserver.pathname =
    `/_matrix/client/v1/media/download/${
      encodeURIComponent(serverName)
    }/${encodeURIComponent(mediaId)}`;
  normalizedHomeserver.search = "";
  normalizedHomeserver.hash = "";
  return normalizedHomeserver.toString();
}

function decryptMatrixAttachment(
  ciphertext: Buffer,
  serializedFile: string,
): Buffer {
  let file: Record<string, unknown>;
  try {
    file = asRecord(JSON.parse(serializedFile));
  } catch {
    throw new Error("matrix_attachment_crypto_invalid");
  }
  const key = asRecord(file.key);
  const hashes = asRecord(file.hashes);
  const keyBytes = decodeBase64(
    stringValue(key.k),
    "base64url",
  );
  const iv = decodeBase64(stringValue(file.iv), "base64");
  const expectedHash = decodeBase64(
    stringValue(hashes.sha256),
    "base64",
  );
  if (
    file.v !== "v2"
    || key.kty !== "oct"
    || key.alg !== "A256CTR"
    || keyBytes.length !== 32
    || iv.length !== 16
    || expectedHash.length !== 32
  ) {
    throw new Error("matrix_attachment_crypto_invalid");
  }
  const actualHash = createHash("sha256")
    .update(ciphertext)
    .digest();
  if (!timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("matrix_attachment_hash_mismatch");
  }
  const decipher = createDecipheriv(
    "aes-256-ctr",
    keyBytes,
    iv,
  );
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
}

function decodeBase64(
  value: string | null,
  encoding: "base64" | "base64url",
): Buffer {
  if (!value || value.length > 512) {
    throw new Error("matrix_attachment_crypto_invalid");
  }
  try {
    return Buffer.from(value, encoding);
  } catch {
    throw new Error("matrix_attachment_crypto_invalid");
  }
}

type MatrixHttp = NonNullable<AdapterDependencies["http"]>;

function matrixHttpClient(): MatrixHttp {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

function requiredSource(
  source: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = source[key]?.trim();
  if (!value) {
    throw new Error("matrix_attachment_locator_invalid");
  }
  return value;
}

function toBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }
  return null;
}

async function* singleChunk(
  bytes: Buffer,
): AsyncIterable<Uint8Array> {
  yield bytes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}
