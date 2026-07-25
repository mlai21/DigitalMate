import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Routes,
  type Message,
} from "discord.js";
import {
  ProxyAgent,
} from "undici";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import type { DiscordConfig } from "./config";

export const DISCORD_GATEWAY_INTENTS = [
  "Guilds",
  "GuildMessages",
  "DirectMessages",
  "MessageContent",
] as const;

export type DiscordTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "rate_limited"
  | "network_unreachable"
  | "response_invalid";

export class DiscordTransportError extends Error {
  readonly code: DiscordTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: DiscordTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "DiscordTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type DiscordClientPort = Readonly<{
  start(input: Readonly<{
    token: string;
    signal: AbortSignal;
    onMessage(payload: unknown): Promise<void>;
    onError(error: Error): void;
  }>): Promise<Readonly<{ botUserId: string }>>;
  stop(): Promise<void>;
  sendMessage(input: Readonly<{
    channelId?: string;
    userId?: string;
    content: string;
    replyToMessageId?: string;
  }>): Promise<Readonly<{ messageId: string }>>;
  editMessage(input: Readonly<{
    channelId: string;
    messageId: string;
    content: string;
  }>): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
}>;

export type DiscordClientFactory = (
  config: DiscordConfig,
) => DiscordClientPort;

export function createDiscordJsClient(
  config: DiscordConfig,
): DiscordClientPort {
  const proxy = discordProxyOptions(config);
  const dispatcher = proxy
    ? new ProxyAgent(proxy)
    : null;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    failIfNotExists: false,
  });
  client.rest.setToken(config.bot_token);
  if (dispatcher) {
    client.rest.setAgent(
      dispatcher as unknown as Parameters<
        typeof client.rest.setAgent
      >[0],
    );
  }
  let detachAbort: (() => void) | null = null;
  let stopped = false;

  return {
    async start(input) {
      const onMessage = (message: Message) => {
        void input.onMessage(
          discordMessagePayload(message, client.user?.id ?? null),
        ).catch((error: unknown) => {
          input.onError(asError(error));
        });
      };
      const onError = (error: Error) => {
        input.onError(mapDiscordError(error));
      };
      const onShardDisconnect = (
        event: Readonly<{ code: number }>,
      ) => {
        if (event.code === 4013 || event.code === 4014) {
          input.onError(new DiscordTransportError({
            code: "permission_denied",
            retryable: false,
          }));
        }
      };
      client.on(Events.MessageCreate, onMessage);
      client.on(Events.Error, onError);
      client.on(Events.ShardError, onError);
      client.on(Events.ShardDisconnect, onShardDisconnect);
      const onAbort = () => {
        void stop();
      };
      input.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachAbort = () =>
        input.signal.removeEventListener("abort", onAbort);
      input.signal.throwIfAborted();

      try {
        await client.login(input.token);
      } catch (error) {
        await stop();
        throw mapDiscordError(error);
      }
      input.signal.throwIfAborted();
      const botUserId = client.user?.id;
      if (!botUserId) {
        await stop();
        throw new DiscordTransportError({
          code: "response_invalid",
          retryable: false,
        });
      }
      return { botUserId };
    },

    stop,

    async sendMessage(input) {
      try {
        const channelId = input.channelId
          ?? await createDirectMessageChannel(
            client,
            requireId(input.userId, "discord_user_id_missing"),
          );
        const response = asRecord(
          await client.rest.post(
            Routes.channelMessages(channelId),
            {
              body: {
                content: requireDiscordContent(input.content),
                ...(input.replyToMessageId
                  ? {
                      message_reference: {
                        message_id: input.replyToMessageId,
                        channel_id: channelId,
                        fail_if_not_exists: false,
                      },
                    }
                  : {}),
                allowed_mentions: {
                  parse: [],
                  replied_user: false,
                },
              },
            },
          ),
        );
        return {
          messageId: requireId(
            primitiveId(response.id),
            "discord_message_id_missing",
          ),
        };
      } catch (error) {
        throw mapDiscordError(error);
      }
    },

    async editMessage(input) {
      try {
        await client.rest.patch(
          Routes.channelMessage(
            input.channelId,
            input.messageId,
          ),
          {
            body: {
              content: requireDiscordContent(input.content),
              allowed_mentions: { parse: [] },
            },
          },
        );
      } catch (error) {
        throw mapDiscordError(error);
      }
    },

    async sendTyping(channelId) {
      try {
        await client.rest.post(Routes.channelTyping(channelId));
      } catch (error) {
        throw mapDiscordError(error);
      }
    },
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    detachAbort?.();
    detachAbort = null;
    client.destroy();
    if (dispatcher) {
      await dispatcher.close().catch(() => undefined);
    }
  }
}

export function discordProxyOptions(
  config: Pick<
    DiscordConfig,
    "http_proxy" | "http_proxy_auth"
  >,
): Readonly<{ uri: string; token?: string }> | null {
  if (!config.http_proxy) return null;
  const proxy: { uri: string; token?: string } = {
    uri: config.http_proxy,
  };
  if (config.http_proxy_auth) {
    proxy.token = `Basic ${
      Buffer.from(config.http_proxy_auth, "utf8").toString("base64")
    }`;
  }
  return proxy;
}

export function mapDiscordError(
  error: unknown,
): DiscordTransportError {
  if (error instanceof DiscordTransportError) return error;
  const record = asRecord(error);
  const status = numericValue(record.status)
    ?? numericValue(record.statusCode);
  const code = primitiveId(record.code);
  if (
    status === 401
    || code === "TokenInvalid"
    || code === "ClientInvalidToken"
  ) {
    return new DiscordTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (
    status === 403
    || code === "50001"
    || code === "50013"
  ) {
    return new DiscordTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (status === 429) {
    return new DiscordTransportError({
      code: "rate_limited",
      retryable: true,
      ...(retryAfterMs(record) !== undefined
        ? { retryAfterMs: retryAfterMs(record) }
        : {}),
    });
  }
  return new DiscordTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

export function createDiscordAttachmentFetcher(
  config: DiscordConfig,
  http?: NonNullable<AdapterDependencies["http"]>,
) {
  return {
    async inspect(descriptor: Readonly<{
      fileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
    }>) {
      if (
        !descriptor.fileName
        || descriptor.sizeBytes === null
      ) {
        throw new Error(
          "discord_attachment_metadata_incomplete",
        );
      }
      return {
        fileName: descriptor.fileName,
        mimeType:
          descriptor.mimeType
          ?? mimeFromName(descriptor.fileName)
          ?? "application/octet-stream",
        sizeBytes: descriptor.sizeBytes,
      };
    },

    async download(
      descriptor: Readonly<{
        source: Readonly<Record<string, string>>;
      }>,
      signal = new AbortController().signal,
    ): Promise<AsyncIterable<Uint8Array>> {
      const url = safeDiscordAttachmentUrl(descriptor.source.url);
      if (!url) {
        throw new Error("discord_attachment_url_invalid");
      }
      const response = http
        ? await http.request({
            method: "GET",
            url,
            headers: {},
            responseType: "bytes",
            signal,
          })
        : await fetchDiscordAttachment(config, url, signal);
      const bytes = toBytes(response.body);
      if (
        response.status < 200
        || response.status >= 300
        || !bytes
      ) {
        throw new Error("discord_attachment_download_failed");
      }
      return singleChunk(bytes);
    },
  };
}

async function fetchDiscordAttachment(
  config: DiscordConfig,
  url: string,
  signal: AbortSignal,
): Promise<Readonly<{
  status: number;
  body: Uint8Array;
}>> {
  const proxy = discordProxyOptions(config);
  const dispatcher = proxy
    ? new ProxyAgent(proxy)
    : null;
  try {
    const response = await fetch(url, {
      signal,
      redirect: "error",
      ...(dispatcher ? { dispatcher } : {}),
    });
    return {
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  } finally {
    if (dispatcher) {
      await dispatcher.close().catch(() => undefined);
    }
  }
}

function discordMessagePayload(
  message: Message,
  botUserId: string | null,
): Readonly<Record<string, unknown>> {
  const isThread = message.channel.isThread();
  const mentionedBotRoleIds = message.guild?.members.me
    ? [...message.mentions.roles.keys()].filter((roleId) =>
        message.guild!.members.me!.roles.cache.has(roleId)
      )
    : [];
  return {
    id: message.id,
    content: message.content,
    channel_id: message.channelId,
    guild_id: message.guildId,
    timestamp: message.createdAt.toISOString(),
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    mentions: [...message.mentions.users.keys()]
      .map((id) => ({ id })),
    mentions_bot:
      botUserId !== null
      && message.mentions.users.has(botUserId),
    mentioned_bot_role_ids: mentionedBotRoleIds,
    mention_everyone: message.mentions.everyone,
    channel: {
      id: message.channelId,
      type: isThread ? "thread" : "channel",
      parent_id: isThread ? message.channel.parentId : null,
    },
    message_reference: message.reference
      ? {
          message_id: message.reference.messageId,
          channel_id: message.reference.channelId,
          guild_id: message.reference.guildId,
        }
      : null,
    attachments: [...message.attachments.values()]
      .map((attachment) => ({
        id: attachment.id,
        filename: attachment.name,
        content_type: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
      })),
  };
}

async function createDirectMessageChannel(
  client: Client,
  userId: string,
): Promise<string> {
  const result = asRecord(
    await client.rest.post(Routes.userChannels(), {
      body: { recipient_id: userId },
    }),
  );
  return requireId(
    primitiveId(result.id),
    "discord_dm_channel_id_missing",
  );
}

function requireDiscordContent(value: string): string {
  const content = value.trim();
  if (content.length === 0 || content.length > 2_000) {
    throw new DiscordTransportError({
      code: "response_invalid",
      retryable: false,
    });
  }
  return content;
}

function safeDiscordAttachmentUrl(
  value: unknown,
): string | null {
  if (typeof value !== "string" || value.length > 8_192) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && [
        "cdn.discordapp.com",
        "media.discordapp.net",
      ].includes(url.hostname.toLowerCase())
      && url.username.length === 0
      && url.password.length === 0
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function retryAfterMs(
  record: Record<string, unknown>,
): number | undefined {
  const seconds = numericValue(record.retry_after)
    ?? numericValue(asRecord(record.data).retry_after);
  return seconds !== null && seconds >= 0
    ? Math.ceil(seconds * 1_000)
    : undefined;
}

function mimeFromName(fileName: string): string | null {
  switch (fileName.split(".").at(-1)?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    default:
      return null;
  }
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string"
    && value.trim().length > 0
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function primitiveId(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= 1_024
    ? normalized
    : null;
}

function requireId(
  value: string | undefined | null,
  code: string,
): string {
  if (!value) throw new Error(code);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("discord_ingress_failed");
}

function toBytes(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  );
}

async function* singleChunk(
  value: Uint8Array,
): AsyncIterable<Uint8Array> {
  yield value;
}
