import { withUserDataFence } from "@/server/admin/user-data-lease";
import type { ChannelType } from "@/server/channels/manifests/catalog";
import { createChannelAccessControl } from "@/server/channels/runtime/access";
import {
  createPostgresChannelConnectionRuntimeStore,
} from "@/server/channels/runtime/connection-manager";
import {
  acceptInboundWithAcknowledgement,
} from "@/server/channels/runtime/ingress";
import {
  createChannelReplyHandleRepository,
} from "@/server/channels/runtime/reply-handle";
import type {
  PlatformAcknowledgement,
} from "@/server/channels/runtime/types";
import { readEnv } from "@/server/config/env";
import { getPool } from "@/server/db/client";
import { createRepositories } from "@/server/db/repositories";

import { createDingTalkWebhookAdapter } from "./dingtalk";
import { createFeishuWebhookAdapter } from "./feishu";
import { createSlackWebhookAdapter } from "./slack";
import { createTelegramWebhookAdapter } from "./telegram";

const ADMISSION_TIMEOUT_MS = 750;
type WebhookChannelType = Extract<
  ChannelType,
  "telegram" | "slack" | "feishu" | "dingtalk"
>;

export async function loadWebhookAuthConfig(
  channelType: WebhookChannelType,
): Promise<Readonly<Record<string, unknown>> | null> {
  const pool = getPool();
  const selected = await pool.query<{ id: string }>(
    `SELECT connection.id
     FROM channel_connections AS connection
     JOIN digital_agents AS agent
       ON agent.id = connection.agent_id
      AND agent.user_id = connection.user_id
     JOIN users AS app_user
       ON app_user.id = connection.user_id
     WHERE connection.channel_type = $1
       AND connection.deleted_at IS NULL
       AND agent.is_default = true
     ORDER BY app_user.created_at, connection.created_at
     LIMIT 1`,
    [channelType],
  );
  const connectionId = selected.rows[0]?.id;
  if (!connectionId) return null;
  const env = readEnv();
  const key = env.channelSecretsKey.status === "ready"
    ? env.channelSecretsKey.key
    : null;
  const connection =
    await createPostgresChannelConnectionRuntimeStore(
      pool,
      key,
    ).get(connectionId);
  return connection?.config ?? null;
}

export async function acceptWebhookEvent(input: Readonly<{
  channelType: WebhookChannelType;
  payload: unknown;
  receivedAt: Date;
}>): Promise<PlatformAcknowledgement> {
  assertDate(input.receivedAt);
  const adapter = createAdapter(input.channelType);
  const repositories = createRepositories();
  const lifecycle = admissionLifecycle();
  try {
    const fence = await repositories.userDataMutations
      .tryAdmitDefaultUserRequest({
        signal: lifecycle.signal,
      });
    if (fence === null) {
      return adapter.acknowledge(input.payload, {
        kind: "ignored",
      });
    }

    return await withUserDataFence(
      repositories,
      fence,
      async () => {
        const agent = await repositories.agents.getDefault(
          fence.userId,
        );
        if (!agent || agent.status !== "active") {
          return adapter.acknowledge(input.payload, {
            kind: "ignored",
          });
        }
        const env = readEnv();
        const key = env.channelSecretsKey.status === "ready"
          ? env.channelSecretsKey.key
          : null;
        const connections =
          await createPostgresChannelConnectionRuntimeStore(
            getPool(),
            key,
          ).listEnabled();
        const connection = connections.find((candidate) =>
          candidate.channelType === input.channelType
          && candidate.scope.userId === fence.userId
          && candidate.scope.agentId === agent.id
          && input.channelType !== "feishu"
          && input.channelType !== "dingtalk"
          && (
            input.channelType !== "telegram"
            || hasConfiguredString(
              candidate.config.webhook_secret,
            )
          )
          && (
            input.channelType !== "slack"
            || !hasConfiguredString(
              candidate.config.app_token,
            )
          )
        );
        if (!connection || connection.runtimeError) {
          return adapter.acknowledge(input.payload, {
            kind: "ignored",
          });
        }

        const accepted = await acceptInboundWithAcknowledgement({
          adapter,
          payload: input.payload,
          context: {
            connectionId: connection.id,
            agentId: agent.id,
            receivedAt: input.receivedAt,
          },
          scope: {
            userId: fence.userId,
            agentId: agent.id,
          },
          access: createChannelAccessControl(getPool()),
          events: repositories.channelEvents,
          afterPersist: async (event, normalized) => {
            if (!normalized.replyHandle) return;
            if (!key) {
              throw new Error("channel_secret_storage_blocked");
            }
            await createChannelReplyHandleRepository(
              getPool(),
              key,
            ).persist(
              event.scope,
              event.id,
              event.connectionId,
              normalized.replyHandle,
              input.receivedAt,
            );
          },
        });
        return accepted.acknowledgement;
      },
      {
        signal: lifecycle.signal,
        timeoutMs: ADMISSION_TIMEOUT_MS,
        timeoutCode: "channel_webhook_admission_timeout",
      },
    );
  } finally {
    lifecycle.dispose();
  }
}

function createAdapter(type: WebhookChannelType) {
  switch (type) {
    case "telegram":
      return createTelegramWebhookAdapter();
    case "slack":
      return createSlackWebhookAdapter();
    case "feishu":
      return createFeishuWebhookAdapter();
    case "dingtalk":
      return createDingTalkWebhookAdapter();
  }
}

function admissionLifecycle() {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error("channel_webhook_admission_timeout"),
    );
  }, ADMISSION_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function assertDate(value: Date): void {
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.getTime())
  ) {
    throw new Error("channel_webhook_received_at_invalid");
  }
}

function hasConfiguredString(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0;
}
