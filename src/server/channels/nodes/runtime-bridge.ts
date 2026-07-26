import path from "node:path";

import type { Pool } from "pg";

import { withUserDataLease } from "@/server/admin/user-data-lease";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";
import {
  createChannelAccessControl,
} from "@/server/channels/runtime/access";
import type {
  ChannelAdapter,
} from "@/server/channels/runtime/adapter";
import {
  downloadInboundAttachment,
} from "@/server/channels/runtime/attachment-ingress";
import {
  createPostgresChannelConnectionRuntimeStore,
  type RuntimeChannelConnection,
} from "@/server/channels/runtime/connection-manager";
import { acceptInbound } from "@/server/channels/runtime/ingress";
import type {
  ChannelDelivery,
  InboundContext,
  IngressResult,
  NormalizedChannelEvent,
  PlatformAcknowledgement,
} from "@/server/channels/runtime/types";
import {
  createChannelAttachmentLocatorRepository,
} from "@/server/channels/runtime/attachment-ingress";
import {
  createChannelReplyHandleRepository,
} from "@/server/channels/runtime/reply-handle";
import type { createRepositories } from "@/server/db/repositories";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

import {
  createChannelNodeAttachmentStore,
} from "./attachment-store";
import {
  NODE_PROTOCOL_VERSION,
  parseNodeFrame,
  type NodeFrame,
  type NodeInboundAckFrame,
  type NodeInboundFrame,
} from "./protocol";
import {
  createChannelNodeRepository,
} from "./repository";

type Repositories = ReturnType<typeof createRepositories>;
type NodeRecord = Readonly<{
  id: string;
  userId: string;
}>;
type NodeRepository = ReturnType<
  typeof createChannelNodeRepository
>;
type NodeSender = (
  nodeId: string,
  frame: NodeFrame,
) => Promise<boolean>;

export function createChannelNodeRuntimeBridge(input: Readonly<{
  pool: Pool;
  repositories: Repositories;
  secretKey: ChannelSecretsKey | null;
  attachmentStorageDir: string;
  repository?: NodeRepository;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());
  const repository = input.repository
    ?? createChannelNodeRepository(input.pool);
  const connections =
    createPostgresChannelConnectionRuntimeStore(
      input.pool,
      input.secretKey,
    );
  const replyHandles = input.secretKey
    ? createChannelReplyHandleRepository(
        input.pool,
        input.secretKey,
      )
    : null;
  const attachmentLocators = input.secretKey
    ? createChannelAttachmentLocatorRepository(
        input.pool,
        input.secretKey,
      )
    : null;
  const attachmentStore = createChannelNodeAttachmentStore({
    rootDirectory: path.join(
      input.attachmentStorageDir,
      ".channel-node",
    ),
    now,
  });
  let sender: NodeSender | null = null;

  return {
    repository,

    setSender(next: NodeSender | null): void {
      sender = next;
    },

    async onRegistered(node: NodeRecord): Promise<void> {
      await attachmentStore.cleanupExpired(node);
      if (!sender) return;
      const pending = await repository.listPendingOutbox(
        node.userId,
        node.id,
        now(),
      );
      await repository.wakeWaitingDeliveries(
        node.userId,
        node.id,
        now(),
      );
      for (const item of pending) {
        if (!await sender(node.id, item.frame)) return;
      }
    },

    async onDisconnected(node: NodeRecord): Promise<void> {
      await attachmentStore.discardNode(node);
    },

    async onInbound(
      node: NodeRecord,
      frame: NodeInboundFrame,
    ): Promise<Readonly<{
      disposition: NodeInboundAckFrame["disposition"];
      eventId?: string;
    }>> {
      const connection = await requireNodeConnection(
        node,
        frame.connectionId,
      );
      const fetcher = attachmentStore.createFetcher({
        node,
        connectionId: frame.connectionId,
        externalEventId: frame.payload.externalEventId,
      });
      const result = await withUserDataLease(
        input.repositories,
        node.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          const adapter = createNodeProxyAdapter(connection);
          const context: InboundContext = {
            connectionId: connection.id,
            agentId: connection.scope.agentId,
            receivedAt: now(),
          };
          return acceptInbound({
            adapter,
            payload: frame,
            context,
            scope: connection.scope,
            access: createChannelAccessControl(input.pool),
            events: input.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) return;
              if (!attachmentLocators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const totalBytes = normalized.attachments.reduce(
                (sum, attachment) =>
                  sum + (attachment.sizeBytes ?? 0),
                0,
              );
              if (
                normalized.attachments.length
                  > ATTACHMENT_LIMITS.maxCount
                || totalBytes
                  > ATTACHMENT_LIMITS.maxMessageBytes
              ) {
                throw new Error(
                  "attachment_message_limit_exceeded",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await attachmentLocators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot: input.attachmentStorageDir,
                  repository:
                    input.repositories.messageAttachments,
                  bindPrivateAttachment: async (attachmentId) => {
                    const bound =
                      await attachmentLocators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        now(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
            onAttachmentPreparationFailure: async (event) => {
              const failed = await input.repositories
                .channelEvents.failPendingAttachments(
                  event.scope,
                  event.id,
                  "channel_attachment_prepare_failed",
                );
              if (!failed) {
                throw new Error(
                  "channel_attachment_failure_transition_failed",
                );
              }
            },
          });
        },
      );
      return ingressDisposition(result);
    },

    async onInboundCommitted(
      node: NodeRecord,
      frame: NodeInboundFrame,
    ): Promise<void> {
      const fetcher = attachmentStore.createFetcher({
        node,
        connectionId: frame.connectionId,
        externalEventId: frame.payload.externalEventId,
      });
      await Promise.allSettled(
        frame.payload.attachments.map((descriptor) =>
          fetcher.release(descriptor)
        ),
      );
    },

    async onFrame(
      node: NodeRecord,
      frame: NodeFrame,
    ): Promise<NodeFrame | void> {
      if (
        frame.type === "attachment_start"
        || frame.type === "attachment_chunk"
        || frame.type === "attachment_commit"
      ) {
        await requireNodeConnection(
          node,
          frame.connectionId,
        );
        const result = await attachmentStore.accept(node, frame);
        if (!result) return;
        const sequence =
          await repository.allocateServerSequence(
            node.userId,
            node.id,
          );
        return parseNodeFrame({
          type: "attachment_ack",
          protocolVersion: NODE_PROTOCOL_VERSION,
          nodeId: node.id,
          sequence,
          sentAt: now().toISOString(),
          connectionId: frame.connectionId,
          transferId: frame.transferId,
          ...result,
        });
      }
      if (frame.type === "send_result") {
        await repository.completeSendResult(
          {
            userId: node.userId,
            nodeId: node.id,
            frame,
          },
          now(),
        );
      }
    },

    async enqueueDelivery(inputDelivery: Readonly<{
      connection: RuntimeChannelConnection;
      delivery: ChannelDelivery;
      expiresAt: Date;
    }>): Promise<void> {
      const nodeId =
        inputDelivery.connection.runtimeNodeId;
      if (!nodeId) {
        throw new Error("channel_node_binding_missing");
      }
      if (
        inputDelivery.connection.channelType === "imessage"
        && inputDelivery.delivery.recipient.chatType !== "direct"
      ) {
        throw new Error("imessage_group_unsupported");
      }
      const result = await repository.enqueueSend(
        {
          scope: inputDelivery.connection.scope,
          nodeId,
          connectionId: inputDelivery.connection.id,
          deliveryId: inputDelivery.delivery.id,
          expiresAt: inputDelivery.expiresAt,
          payload: {
            body: inputDelivery.delivery.body,
            recipient: inputDelivery.delivery.recipient,
            ...(inputDelivery.delivery.replyHandle
              ? {
                  replyHandle:
                    serializeReplyHandle(
                      inputDelivery.delivery.replyHandle,
                    ),
                }
              : {}),
          },
        },
        now(),
      );
      if (result.action === "enqueued" && sender) {
        await sender(nodeId, result.outbox.frame);
      }
    },
  };

  async function requireNodeConnection(
    node: NodeRecord,
    connectionId: string,
  ): Promise<RuntimeChannelConnection> {
    const connection = await connections.get(connectionId);
    if (
      !connection
      || !connection.enabled
      || connection.scope.userId !== node.userId
      || connection.runtimeNodeId !== node.id
      || !["imessage", "sip"].includes(
        connection.channelType,
      )
    ) {
      throw new Error("node_connection_not_bound");
    }
    return connection;
  }
}

export function normalizeNodeInbound(
  connection: RuntimeChannelConnection,
  frame: NodeInboundFrame,
  receivedAt: Date,
): NormalizedChannelEvent {
  return {
    connectionId: connection.id,
    agentId: connection.scope.agentId,
    channelType: connection.channelType,
    externalEventId: frame.payload.externalEventId,
    externalConversationId:
      frame.payload.externalConversationId,
    externalSenderId: frame.payload.externalSenderId,
    chatType: frame.payload.chatType,
    mentioned: frame.payload.mentioned,
    text: frame.payload.text,
    thread: frame.payload.thread,
    attachments: frame.payload.attachments,
    occurredAt: new Date(frame.payload.occurredAt),
    receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent:
        frame.payload.attachments.length > 0,
    },
    rawSummary: frame.payload.rawSummary,
    ...(frame.payload.replyHandle
      ? {
          replyHandle: {
            publicFields:
              frame.payload.replyHandle.publicFields,
            secretFields:
              frame.payload.replyHandle.secretFields,
            expiresAt: frame.payload.replyHandle.expiresAt
              ? new Date(
                  frame.payload.replyHandle.expiresAt,
                )
              : null,
          },
        }
      : {}),
  };
}

function createNodeProxyAdapter(
  connection: RuntimeChannelConnection,
): ChannelAdapter<Record<string, unknown>> {
  return {
    manifest: getChannelManifest(connection.channelType),
    validateConfig(value) {
      return value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
    },
    async start() {},
    async stop() {},
    async health() {
      return {
        status: "healthy",
        checkedAt: new Date(),
        reconnectAttempts: 0,
      };
    },
    async normalizeInbound(payload, context) {
      if (
        !payload
        || typeof payload !== "object"
        || !("type" in payload)
        || payload.type !== "inbound"
      ) {
        return null;
      }
      return normalizeNodeInbound(
        connection,
        payload as NodeInboundFrame,
        context.receivedAt,
      );
    },
    async acknowledge(): Promise<PlatformAcknowledgement> {
      return { status: 200 };
    },
    async send() {
      throw new Error("channel_node_send_via_bridge");
    },
    async resolveRecipient() {
      throw new Error("channel_node_recipient_via_bridge");
    },
  };
}

function ingressDisposition(
  result: IngressResult,
): Readonly<{
  disposition: NodeInboundAckFrame["disposition"];
  eventId?: string;
}> {
  return result.kind === "ignored"
    ? { disposition: "ignored" }
    : {
        disposition: result.kind,
        eventId: result.eventId,
      };
}

function serializeReplyHandle(
  replyHandle: NonNullable<ChannelDelivery["replyHandle"]>,
) {
  return {
    publicFields: replyHandle.publicFields,
    secretFields: replyHandle.secretFields,
    expiresAt: replyHandle.expiresAt?.toISOString() ?? null,
  };
}
