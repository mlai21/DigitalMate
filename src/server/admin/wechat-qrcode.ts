import {
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { AgentScope } from "@/server/agents/types";
import type {
  AdminChannelConfigReader,
  AdminChannelConfigWriter,
} from "@/server/admin/compat/handlers/channels";
import {
  createWechatIlinkClient,
  type WechatIlinkClientPort,
} from "@/server/channels/adapters/wechat/client";
import {
  normalizeWechatBaseUrl,
  WECHAT_DEFAULT_BASE_URL,
} from "@/server/channels/adapters/wechat/config";

const SESSION_TTL_MS = 5 * 60 * 1_000;
const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;
const POLL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const STATUS_VALUES = new Set([
  "waiting",
  "scanned",
  "confirmed",
  "expired",
]);

type QrSession = {
  scope: AgentScope;
  qrcode: string;
  baseUrl: string;
  expiresAt: number;
  polling: boolean;
  pendingCredentials?: Readonly<{
    botToken: string;
    baseUrl: string;
    operationId: string;
  }>;
};

export type WechatQrAuthService = Readonly<{
  create(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    qrcode_img: string;
    poll_token: string;
    expires_at: string;
  }>>;
  poll(
    scope: AgentScope,
    pollToken: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    status:
      | "waiting"
      | "scanned"
      | "confirmed"
      | "expired";
    credentials?: Readonly<{
      bot_token: "configured";
      base_url: string;
    }>;
  }>>;
}>;

export function createWechatQrAuthService(
  input: Readonly<{
    hmacKey: string;
    readChannels: AdminChannelConfigReader;
    updateChannel: AdminChannelConfigWriter;
    clientFactory?: (
      baseUrl: string,
    ) => WechatIlinkClientPort;
    now?: () => Date;
    randomToken?: () => string;
  }>,
): WechatQrAuthService {
  if (Buffer.byteLength(input.hmacKey, "utf8") < 16) {
    throw new Error("wechat_qr_hmac_key_invalid");
  }
  const sessions = new Map<string, QrSession>();
  const now = input.now ?? (() => new Date());
  const randomToken = input.randomToken ?? (() =>
    randomBytes(32).toString("base64url"));
  const clientFactory = input.clientFactory
    ?? ((baseUrl) =>
      createWechatIlinkClient({ baseUrl }));

  return {
    async create(scope, signal) {
      cleanup();
      signal?.throwIfAborted();
      const channels = await input.readChannels(
        scope,
        signal,
      );
      const snapshot = channels.wechat;
      const baseUrl = normalizeWechatBaseUrl(
        typeof snapshot.config.base_url === "string"
          ? snapshot.config.base_url
          : WECHAT_DEFAULT_BASE_URL,
      );
      const client = clientFactory(baseUrl);
      await client.start();
      let response: Readonly<Record<string, unknown>>;
      try {
        response = await client.getQrCode(signal);
      } finally {
        await client.stop().catch(() => undefined);
      }
      const qrcode = safeSecret(response.qrcode);
      const image = safeQrImage(
        response.qrcode_img_content,
      );
      if (!qrcode || !image) {
        throw new Error("wechat_qrcode_response_invalid");
      }
      const pollToken = randomToken();
      if (!POLL_TOKEN_PATTERN.test(pollToken)) {
        throw new Error("wechat_qr_poll_token_invalid");
      }
      const expiresAt =
        now().getTime() + SESSION_TTL_MS;
      deleteSessionsForScope(scope);
      sessions.set(digest(pollToken), {
        scope,
        qrcode,
        baseUrl,
        expiresAt,
        polling: false,
      });
      return {
        qrcode_img: image,
        poll_token: pollToken,
        expires_at: new Date(expiresAt).toISOString(),
      };
    },

    async poll(scope, pollToken, signal) {
      cleanup();
      if (!POLL_TOKEN_PATTERN.test(pollToken)) {
        return { status: "expired" };
      }
      const key = digest(pollToken);
      const session = sessions.get(key);
      if (
        !session
        || !sameScope(session.scope, scope)
        || session.expiresAt <= now().getTime()
      ) {
        sessions.delete(key);
        return { status: "expired" };
      }
      if (session.polling) {
        return { status: "waiting" };
      }
      session.polling = true;
      try {
        if (!session.pendingCredentials) {
          const client = clientFactory(session.baseUrl);
          await client.start();
          let response: Readonly<Record<string, unknown>>;
          try {
            response = await client.getQrCodeStatus(
              session.qrcode,
              signal,
            );
          } finally {
            await client.stop().catch(() => undefined);
          }
          if (session.expiresAt <= now().getTime()) {
            sessions.delete(key);
            return { status: "expired" };
          }
          const status = safeStatus(response.status);
          if (status === "expired") {
            sessions.delete(key);
            return { status };
          }
          if (status !== "confirmed") {
            return { status };
          }
          const botToken = safeSecret(response.bot_token);
          const baseUrl = normalizeWechatBaseUrl(
            safeSecret(response.baseurl)
            || session.baseUrl,
          );
          if (!botToken) {
            throw new Error(
              "wechat_qrcode_credentials_invalid",
            );
          }
          session.pendingCredentials = {
            botToken,
            baseUrl,
            operationId: randomUUID(),
          };
        }
        const credentials = session.pendingCredentials;
        const channels = await input.readChannels(
          scope,
          signal,
        );
        const snapshot = channels.wechat;
        await input.updateChannel({
          scope,
          type: "wechat",
          operationId: credentials.operationId,
          expectedRevision: snapshot.revision,
          enabled: snapshot.enabled,
          config: {
            ...snapshot.config,
            base_url: credentials.baseUrl,
          },
          secretChanges: [{
            fieldName: "bot_token",
            operation: "set",
            value: credentials.botToken,
          }],
          confirmationSource: "console",
        }, signal);
        sessions.delete(key);
        return {
          status: "confirmed",
          credentials: {
            bot_token: "configured",
            base_url: credentials.baseUrl,
          },
        };
      } finally {
        session.polling = false;
      }
    },
  };

  function digest(pollToken: string): string {
    return createHmac("sha256", input.hmacKey)
      .update(pollToken, "utf8")
      .digest("hex");
  }

  function cleanup(): void {
    const current = now().getTime();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= current) {
        sessions.delete(key);
      }
    }
  }

  function deleteSessionsForScope(
    scope: AgentScope,
  ): void {
    for (const [key, session] of sessions) {
      if (sameScope(session.scope, scope)) {
        sessions.delete(key);
      }
    }
  }
}

function safeStatus(
  value: unknown,
): "waiting" | "scanned" | "confirmed" | "expired" {
  return typeof value === "string"
    && STATUS_VALUES.has(value)
    ? value as ReturnType<typeof safeStatus>
    : "waiting";
}

function safeSecret(value: unknown): string {
  const normalized =
    typeof value === "string" ? value.trim() : "";
  return normalized.length > 0
    && normalized.length <= 128 * 1024
    && !normalized.includes("\u0000")
    ? normalized
    : "";
}

function safeQrImage(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_QR_IMAGE_BYTES * 2
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return "";
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength > 0
    && bytes.byteLength <= MAX_QR_IMAGE_BYTES
    ? value
    : "";
}

function sameScope(
  left: AgentScope,
  right: AgentScope,
): boolean {
  return left.userId === right.userId
    && left.agentId === right.agentId;
}
