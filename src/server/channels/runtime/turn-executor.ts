import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type {
  DbMessage,
  DbMessageAttachment,
} from "@/server/db/repositories";

import type { ChannelDeliveryReactionPlan } from "./delivery-repository";
import type {
  ClaimedChannelEvent,
} from "./event-repository";
import type { ExecutionJournal } from "./execution-journal";
import type { ChannelReaction, ChannelRecipient } from "./types";

export const CHANNEL_INTERRUPTED_REPLY =
  "刚才没能完整回复，你把那条消息再发一次，我重新接着看。";
export const CHANNEL_AGENT_FAILED_REPLY =
  "我这边刚才有点卡住了，但不是你的问题。我们可以稍后再试一次。";

export type ChannelTurnFaultPoint =
  | "after_accept"
  | "after_claim"
  | "llm_started"
  | "after_assistant_insert"
  | "after_delivery_insert";

type MaybePromise<T> = T | Promise<T>;
type QueryablePool = Pick<Pool, "connect">;

type MessageRepository = Readonly<{
  createIdempotentUserTurn(
    scope: AgentScope,
    input: {
      conversationId: string;
      clientTurnId: string;
      payloadHash: string;
      content: string;
      attachmentIds: string[];
      memoryProcessed?: boolean;
    },
  ): Promise<{
    message: Pick<DbMessage, "id">;
    attachments: Array<Pick<DbMessageAttachment, "id">>;
    created: boolean;
  }>;
  acquireClientTurnExecutionLock(
    scope: AgentScope,
    clientTurnId: string,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>;
  claimClientTurnExecution(
    scope: AgentScope,
    clientTurnId: string,
  ): Promise<boolean>;
  findByClientTurn(
    scope: AgentScope,
    clientTurnId: string,
    role: "user" | "assistant",
  ): Promise<Pick<DbMessage, "id" | "content"> | null>;
}>;

export type ChannelAgentTurnContext = Readonly<{
  claim: ClaimedChannelEvent;
  conversationId: string;
  journal: ExecutionJournal;
  signal?: AbortSignal;
}>;

export type PersistChannelReplyInput = Readonly<{
  claim: ClaimedChannelEvent;
  conversationId: string;
  body: string;
  recipient: ChannelRecipient;
  replyHandleId: string | null;
  reactionPlan: ChannelDeliveryReactionPlan | null;
}>;

export type PersistChannelReplyResult = Readonly<{
  assistantMessageId: string;
  deliveryId: string;
  created: boolean;
}>;

export type ChannelTurnResult = PersistChannelReplyResult & Readonly<{
  degraded: boolean;
}>;

export type ChannelTurnDecision =
  | Readonly<{ kind: "proceed" }>
  | Readonly<{ kind: "skip"; reason: string }>;

export type SkippedChannelTurnResult = Readonly<{
  skipped: true;
  reason: string;
  assistantMessageId: null;
  deliveryId: null;
  created: false;
  degraded: false;
}>;

export type ChannelTurnExecutor = Readonly<{
  execute(
    claim: ClaimedChannelEvent,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ChannelTurnResult | SkippedChannelTurnResult>;
}>;

export function createChannelTurnExecutor(input: Readonly<{
  messages: MessageRepository;
  resolveConversationId(
    claim: ClaimedChannelEvent,
  ): Promise<string>;
  resolveAttachmentIds(
    claim: ClaimedChannelEvent,
  ): Promise<string[]>;
  resolveReplyHandleId?(
    claim: ClaimedChannelEvent,
  ): Promise<string | null>;
  createJournal(claim: ClaimedChannelEvent): ExecutionJournal;
  decideTurn?(
    context: ChannelAgentTurnContext,
  ): MaybePromise<ChannelTurnDecision>;
  runAgentTurn(
    context: ChannelAgentTurnContext,
  ): MaybePromise<string | AsyncIterable<string>>;
  persistReply(
    input: PersistChannelReplyInput,
  ): Promise<PersistChannelReplyResult>;
  completeWithoutReply?(
    claim: ClaimedChannelEvent,
    conversationId: string,
    reason: string,
  ): Promise<void>;
  typing?(
    claim: ClaimedChannelEvent,
    active: boolean,
  ): MaybePromise<void>;
  // Puts the busy marker on the user's message. The delivery worker clears it
  // once the reply lands, so this only withdraws it when no reply is coming.
  reaction?(
    claim: ClaimedChannelEvent,
    active: boolean,
  ): MaybePromise<void>;
  chooseReaction?(
    claim: ClaimedChannelEvent,
  ): MaybePromise<ChannelReaction | null>;
  faultInjector?(
    point: ChannelTurnFaultPoint,
  ): MaybePromise<void>;
  // The degraded reply is deliberately vague to the user, so the real cause has
  // to be reported here or it is lost entirely.
  onAgentFailure?(
    context: ChannelAgentTurnContext,
    error: unknown,
  ): MaybePromise<void>;
}>): ChannelTurnExecutor {
  return {
    async execute(
      claim,
      options = {},
    ): Promise<ChannelTurnResult | SkippedChannelTurnResult> {
      options.signal?.throwIfAborted();
      const conversationId = await input.resolveConversationId(claim);
      const attachmentIds = await input.resolveAttachmentIds(claim);
      options.signal?.throwIfAborted();

      await input.messages.createIdempotentUserTurn(claim.scope, {
        conversationId,
        clientTurnId: claim.clientTurnId,
        payloadHash: claim.payloadHash,
        content: claim.normalizedEvent.text,
        attachmentIds,
        memoryProcessed:
          claim.normalizedEvent.chatType === "group",
      });
      options.signal?.throwIfAborted();

      const release = await input.messages.acquireClientTurnExecutionLock(
        claim.scope,
        claim.clientTurnId,
        options.signal,
      );
      let reactionAttached = false;
      let reactionHandedOff = false;
      try {
        options.signal?.throwIfAborted();
        const existingAssistant =
          await input.messages.findByClientTurn(
            claim.scope,
            claim.clientTurnId,
            "assistant",
          );
        if (existingAssistant) {
          const persisted = await persist(
            input,
            claim,
            conversationId,
            existingAssistant.content,
          );
          return {
            ...persisted,
            degraded:
              existingAssistant.content === CHANNEL_INTERRUPTED_REPLY,
          };
        }

        const journal = input.createJournal(claim);
        const decision = await input.decideTurn?.({
          claim,
          conversationId,
          journal,
          signal: options.signal,
        }) ?? { kind: "proceed" as const };
        if (decision.kind === "skip") {
          if (!input.completeWithoutReply) {
            throw new Error(
              "channel_turn_skip_persister_missing",
            );
          }
          await input.completeWithoutReply(
            claim,
            conversationId,
            decision.reason,
          );
          return {
            skipped: true,
            reason: decision.reason,
            assistantMessageId: null,
            deliveryId: null,
            created: false,
            degraded: false,
          };
        }

        const executionClaimed =
          await input.messages.claimClientTurnExecution(
            claim.scope,
            claim.clientTurnId,
          );
        if (!executionClaimed) {
          const persisted = await persist(
            input,
            claim,
            conversationId,
            CHANNEL_INTERRUPTED_REPLY,
          );
          return {
            ...persisted,
            degraded: true,
          };
        }

        await input.faultInjector?.("after_claim");
        options.signal?.throwIfAborted();
        let body: string;
        let degraded = false;
        await Promise.resolve(
          input.typing?.(claim, true),
        ).catch(() => undefined);
        await Promise.resolve(
          input.reaction?.(claim, true),
        ).catch(() => undefined);
        reactionAttached = input.reaction !== undefined;
        // Runs alongside the Agent because it only reads the incoming
        // message, so the extra model call never delays the reply.
        const chosenReaction = Promise.resolve(
          input.chooseReaction?.(claim) ?? null,
        ).catch(() => null);
        const agentContext: ChannelAgentTurnContext = {
          claim,
          conversationId,
          journal,
          ...(options.signal ? { signal: options.signal } : {}),
        };
        try {
          try {
            body = normalizeAssistantBody(
              await collectReply(input.runAgentTurn(agentContext)),
              CHANNEL_AGENT_FAILED_REPLY,
            );
            degraded = body === CHANNEL_AGENT_FAILED_REPLY;
          } catch (error) {
            if (
              isProcessCrash(error)
              || options.signal?.aborted === true
            ) {
              throw error;
            }
            await Promise.resolve(
              input.onAgentFailure?.(agentContext, error),
            ).catch(() => undefined);
            body = CHANNEL_AGENT_FAILED_REPLY;
            degraded = true;
          }
        } finally {
          await Promise.resolve(
            input.typing?.(claim, false),
          ).catch(() => undefined);
        }
        options.signal?.throwIfAborted();
        const persisted = await persist(
          input,
          claim,
          conversationId,
          body,
          await chosenReaction,
        );
        reactionHandedOff = true;
        return {
          ...persisted,
          degraded,
        };
      } finally {
        if (reactionAttached && !reactionHandedOff) {
          await Promise.resolve(
            input.reaction?.(claim, false),
          ).catch(() => undefined);
        }
        await release();
      }
    },
  };
}

export function createAtomicChannelReplyPersister(
  pool: QueryablePool,
  options: Readonly<{
    faultInjector?(
      point: ChannelTurnFaultPoint,
    ): MaybePromise<void>;
  }> = {},
) {
  return async (
    input: PersistChannelReplyInput,
  ): Promise<PersistChannelReplyResult> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const assistant = await insertOrReadAssistant(client, input);
      await options.faultInjector?.("after_assistant_insert");
      const delivery = await insertOrReadDelivery(
        client,
        input,
        assistant.id,
        assistant.content,
      );
      await options.faultInjector?.("after_delivery_insert");

      const completed = await client.query(
        `UPDATE channel_inbound_events
         SET status = 'completed',
             assistant_message_id = $3,
             claim_owner = NULL,
             claim_expires_at = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND user_id = $4
           AND agent_id = $5
           AND connection_id = $6
           AND claim_expires_at > now()`,
        [
          input.claim.id,
          input.claim.claimOwner,
          assistant.id,
          input.claim.scope.userId,
          input.claim.scope.agentId,
          input.claim.connectionId,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new Error("channel_event_claim_lost");
      }
      await client.query(
        `UPDATE conversations
         SET updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND agent_id = $3`,
        [
          input.conversationId,
          input.claim.scope.userId,
          input.claim.scope.agentId,
        ],
      );
      await client.query("COMMIT");
      return {
        assistantMessageId: assistant.id,
        deliveryId: delivery.id,
        created: assistant.created,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

export function createAtomicChannelNoReplyPersister(
  pool: QueryablePool,
) {
  return async (
    claim: ClaimedChannelEvent,
    conversationId: string,
    reason: string,
  ): Promise<void> => {
    if (
      !/^[a-z0-9_:-]{1,128}$/.test(reason)
    ) {
      throw new Error("channel_turn_skip_reason_invalid");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        `UPDATE channel_inbound_events
         SET status = 'completed',
             assistant_message_id = NULL,
             failure_code = $6,
             claim_owner = NULL,
             claim_expires_at = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND user_id = $3
           AND agent_id = $4
           AND connection_id = $5
           AND claim_expires_at > now()`,
        [
          claim.id,
          claim.claimOwner,
          claim.scope.userId,
          claim.scope.agentId,
          claim.connectionId,
          reason,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new Error("channel_event_claim_lost");
      }
      await client.query(
        `UPDATE conversations
         SET updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND agent_id = $3`,
        [
          conversationId,
          claim.scope.userId,
          claim.scope.agentId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

async function persist(
  input: Parameters<typeof createChannelTurnExecutor>[0],
  claim: ClaimedChannelEvent,
  conversationId: string,
  body: string,
  reaction: ChannelReaction | null = null,
): Promise<PersistChannelReplyResult> {
  const threadId = claim.normalizedEvent.thread.externalThreadId;
  const recipient: ChannelRecipient = {
    externalConversationId:
      claim.normalizedEvent.externalConversationId,
    chatType: claim.normalizedEvent.chatType,
    ...(threadId ? { externalThreadId: threadId } : {}),
    ...(claim.normalizedEvent.chatType === "direct"
      ? {
          externalUserId:
            claim.normalizedEvent.externalSenderId,
        }
      : {}),
  };
  const platformMessageId =
    claim.normalizedEvent.rawSummary.platformMessageId;
  return input.persistReply({
    claim,
    conversationId,
    body,
    recipient,
    replyHandleId:
      await input.resolveReplyHandleId?.(claim) ?? null,
    reactionPlan: typeof platformMessageId === "string"
      && platformMessageId.length > 0
      ? { platformMessageId, reaction }
      : null,
  });
}

async function collectReply(
  value: MaybePromise<string | AsyncIterable<string>>,
): Promise<string> {
  const resolved = await value;
  if (typeof resolved === "string") return resolved;
  let output = "";
  for await (const chunk of resolved) output += chunk;
  return output;
}

function normalizeAssistantBody(
  body: string,
  fallback: string,
): string {
  const normalized = body.trim();
  return normalized || fallback;
}

function isProcessCrash(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "isChannelProcessCrash" in error
    && error.isChannelProcessCrash === true
  );
}

async function insertOrReadAssistant(
  client: PoolClient,
  input: PersistChannelReplyInput,
): Promise<{
  id: string;
  content: string;
  created: boolean;
}> {
  const inserted = await client.query<{
    id: string;
    content: string;
  }>(
    `INSERT INTO messages (
       user_id, agent_id, conversation_id, role, content,
       client_turn_id
     )
     SELECT $1, $2, conversation.id, 'assistant', $4, $5
     FROM conversations AS conversation
     WHERE conversation.id = $3
       AND conversation.user_id = $1
       AND conversation.agent_id = $2
     ON CONFLICT (
       user_id, agent_id, client_turn_id, role
     ) WHERE client_turn_id IS NOT NULL
     DO NOTHING
     RETURNING id, content`,
    [
      input.claim.scope.userId,
      input.claim.scope.agentId,
      input.conversationId,
      input.body,
      input.claim.clientTurnId,
    ],
  );
  if (inserted.rows[0]) {
    return {
      ...inserted.rows[0],
      created: true,
    };
  }

  const existing = await client.query<{
    id: string;
    content: string;
    conversation_id: string;
  }>(
    `SELECT id, content, conversation_id
     FROM messages
     WHERE user_id = $1
       AND agent_id = $2
       AND client_turn_id = $3
       AND role = 'assistant'
     FOR UPDATE`,
    [
      input.claim.scope.userId,
      input.claim.scope.agentId,
      input.claim.clientTurnId,
    ],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("client_turn_assistant_missing");
  if (row.conversation_id !== input.conversationId) {
    throw new Error("client_turn_conflict");
  }
  return {
    id: row.id,
    content: row.content,
    created: false,
  };
}

async function insertOrReadDelivery(
  client: PoolClient,
  input: PersistChannelReplyInput,
  assistantMessageId: string,
  body: string,
): Promise<{ id: string }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO channel_deliveries (
       user_id, agent_id, event_id, connection_id,
       assistant_message_id, reply_handle_id, body, recipient,
       reaction_plan
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [
      input.claim.scope.userId,
      input.claim.scope.agentId,
      input.claim.id,
      input.claim.connectionId,
      assistantMessageId,
      input.replyHandleId,
      body,
      JSON.stringify(input.recipient),
      input.reactionPlan
        ? JSON.stringify(input.reactionPlan)
        : null,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await client.query<{
    id: string;
    assistant_message_id: string;
    connection_id: string;
    reply_handle_id: string | null;
    body: string;
    recipient: ChannelRecipient;
  }>(
    `SELECT id, assistant_message_id, connection_id,
            reply_handle_id, body, recipient
     FROM channel_deliveries
     WHERE event_id = $1
       AND user_id = $2
       AND agent_id = $3
     FOR UPDATE`,
    [
      input.claim.id,
      input.claim.scope.userId,
      input.claim.scope.agentId,
    ],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("channel_delivery_missing");
  if (
    row.assistant_message_id !== assistantMessageId
    || row.connection_id !== input.claim.connectionId
    || row.reply_handle_id !== input.replyHandleId
    || row.body !== body
    || !sameRecipient(row.recipient, input.recipient)
  ) {
    throw new Error("channel_delivery_payload_conflict");
  }
  return { id: row.id };
}

function sameRecipient(
  left: ChannelRecipient,
  right: ChannelRecipient,
): boolean {
  return (
    left.externalConversationId === right.externalConversationId
    && left.externalThreadId === right.externalThreadId
    && left.externalUserId === right.externalUserId
  );
}
