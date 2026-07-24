import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acquireUserDataLease,
  type FencedUserDataLease,
} from "@/server/admin/user-data-lease";
import { generateConversationTitle } from "@/server/agent/conversation-title";
import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import { createSearchGate, normalizeSearchAggressiveness } from "@/server/agent/search-gate";
import { buildExplicitSkillFallbackMessage, parseSlashCommand } from "@/server/agent/skill-command";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { loadAttachmentContext } from "@/server/attachments/context";
import { readAttachment } from "@/server/attachments/storage";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import { userConnectionDisconnector } from "@/server/admin/user-connections";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import {
  createRepositories,
  type DbMessageAttachment,
  type UserDataLease,
  type UserDataRequestFence,
} from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { recordTurnReview } from "@/server/evolution/turn-review";
import { supportsImageInput } from "@/server/llm/catalog";
import type { LlmMessage } from "@/server/llm/types";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";
import {
  assertAuthorizedModelRoutes,
  resolveDefaultAgentScope,
} from "@/server/agents/service";
import type { AgentScope } from "@/server/agents/types";

export const runtime = "nodejs";

export const CHAT_FOREGROUND_TIMEOUT_MS = 120_000;
export const CHAT_POST_TURN_TIMEOUT_MS = 15_000;

const requestSchema = z
  .object({
    message: z.string().max(8000).default(""),
    attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_LIMITS.maxCount).default([]),
    clientTurnId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    skillIds: z.array(z.string().uuid()).max(3).optional(),
    searchEnabled: z.boolean().optional(),
  })
  .refine(
    (value) => value.message.trim().length > 0 || value.attachmentIds.length > 0,
    "message_or_attachment_required",
  );

export async function POST(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositories = createRepositories();
  const foreground = createBoundedAbortLifecycle({
    sourceSignals: [request.signal],
    timeoutMs: CHAT_FOREGROUND_TIMEOUT_MS,
    timeoutCode: "chat_foreground_timeout",
  });
  let userDataLease: FencedUserDataLease;
  try {
    userDataLease = await acquireUserDataLease(repositories, user.id, {
      signal: foreground.signal,
    });
  } catch (error) {
    foreground.dispose();
    const code = error instanceof Error ? error.message : "user_data_lease_failed";
    return NextResponse.json(
      { error: code === "user_data_epoch_changed" ? code : "user_data_lease_failed" },
      { status: code === "user_data_epoch_changed" ? 409 : 503 },
    );
  }

  return handleLeasedChatRequest(request, user, repositories, userDataLease, foreground);
}

async function handleLeasedChatRequest(
  request: Request,
  user: { id: string },
  repositories: ReturnType<typeof createRepositories>,
  userDataLease: FencedUserDataLease,
  foreground: AbortLifecycle,
): Promise<Response> {
  let leaseTransferredToStream = false;
  try {
  const body = requestSchema.safeParse(await request.json());
  foreground.signal.throwIfAborted();
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
  const conversation = body.data.conversationId
    ? await repositories.conversations.get(scope, body.data.conversationId)
    : await repositories.conversations.getOrCreateDefault(scope);
  if (!conversation) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }
  const conversationId = conversation.id;
  const clientTurnId = body.data.clientTurnId;
  const payloadHash = hashClientTurnPayload({
    conversationId,
    message: body.data.message,
    attachmentIds: body.data.attachmentIds,
    skillIds: body.data.skillIds ?? [],
    searchEnabled: body.data.searchEnabled === true,
  });

  const existingUserMessage = await repositories.messages.findByClientTurn(scope, clientTurnId, "user");
  const encoder = new TextEncoder();
  let userTurn: Awaited<ReturnType<typeof repositories.messages.createIdempotentUserTurn>> | undefined;
  if (existingUserMessage) {
    try {
      userTurn = await repositories.messages.createIdempotentUserTurn(scope, {
        conversationId,
        clientTurnId,
        payloadHash,
        content: body.data.message,
        attachmentIds: body.data.attachmentIds,
      });
    } catch (error) {
      return createClientTurnErrorResponse(error);
    }

    const existingAssistant = await repositories.messages.findByClientTurn(scope, clientTurnId, "assistant");
    if (existingAssistant) {
      return createReplayResponse({
        encoder,
        conversationId,
        clientTurnId,
        userMessageId: userTurn.message.id,
        assistantMessageId: existingAssistant.id,
        content: existingAssistant.content,
      });
    }
  }

  // Read history before creating the current turn so it cannot be appended
  // twice by buildMessages (once in history and once as the current user turn).
  const historyRows = await repositories.messages.recentHistory(scope, conversationId, 12, clientTurnId);
  const settings = await repositories.settings.get(scope);
  const env = readEnv();
  await assertAuthorizedModelRoutes(
    scope,
    ["main", "light"],
    settings.modelRouting,
    repositories.agents,
  );
  const { client, model } = getLlmClient("main", env, settings.modelRouting);
  const light = getLlmClient("light", env, settings.modelRouting);
  let currentAttachments = await loadTurnAttachments({
    repositories,
    scope,
    attachmentIds: body.data.attachmentIds,
    existingUserMessageId: existingUserMessage?.id,
  });
  if (!currentAttachments && !existingUserMessage) {
    const racedUserMessage = await repositories.messages.findByClientTurn(scope, clientTurnId, "user");
    if (racedUserMessage) {
      try {
        userTurn = await repositories.messages.createIdempotentUserTurn(scope, {
          conversationId,
          clientTurnId,
          payloadHash,
          content: body.data.message,
          attachmentIds: body.data.attachmentIds,
        });
      } catch (error) {
        return createClientTurnErrorResponse(error);
      }
      const racedAssistant = await repositories.messages.findByClientTurn(scope, clientTurnId, "assistant");
      if (racedAssistant) {
        return createReplayResponse({
          encoder,
          conversationId,
          clientTurnId,
          userMessageId: userTurn.message.id,
          assistantMessageId: racedAssistant.id,
          content: racedAssistant.content,
        });
      }
      currentAttachments = await loadTurnAttachments({
        repositories,
        scope,
        attachmentIds: body.data.attachmentIds,
        existingUserMessageId: racedUserMessage.id,
      });
    }
  }
  if (!currentAttachments) {
    return NextResponse.json({ error: "attachment_not_bindable" }, { status: 400 });
  }

  const historyMessageIds = historyRows
    .map((message) => ("id" in message && typeof message.id === "string" ? message.id : null))
    .filter((id): id is string => id !== null);
  const historicalAttachments = historyMessageIds.length > 0
    ? await repositories.messageAttachments.listForMessages(scope, historyMessageIds)
    : [];
  const orderedHistoricalAttachments = orderAttachmentsByMessage(historyMessageIds, historicalAttachments);
  const imageInputSupported = supportsImageInput(model);
  if (currentAttachments.some((attachment) => attachment.kind === "image") && !imageInputSupported) {
    return NextResponse.json(
      {
        error: "image_model_not_supported",
        message: "当前模型暂不支持图片理解，请切换到支持图片的模型后重试。",
      },
      { status: 422 },
    );
  }

  let attachmentContext;
  try {
    attachmentContext = await loadAttachmentContext({
      currentAttachments,
      historicalAttachments: orderedHistoricalAttachments,
      storage: { read: (storageKey) => readAttachment(env.attachmentStorageDir, storageKey) },
      includeHistoricalImages: imageInputSupported,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "attachment_context_invalid";
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const history = attachHistoryFiles(historyRows, orderedHistoricalAttachments, attachmentContext.history);
  const currentLlmAttachments = attachmentContext.current;

  if (!userTurn) {
    try {
      userTurn = await repositories.messages.createIdempotentUserTurn(scope, {
        conversationId,
        clientTurnId,
        payloadHash,
        content: body.data.message,
        attachmentIds: body.data.attachmentIds,
      });
    } catch (error) {
      return createClientTurnErrorResponse(error);
    }
  }
  const userMessage = userTurn.message;
  if (userTurn.created) {
    await recordEventReflection(repositories, {
      scope,
      event: "user_dissatisfaction",
      summary: body.data.message,
      source: { conversationId, messageId: userMessage.id },
    }).catch(() => undefined);
  }
  const existingAssistant = await repositories.messages.findByClientTurn(scope, clientTurnId, "assistant");
  if (existingAssistant) {
    return createReplayResponse({
      encoder,
      conversationId,
      clientTurnId,
      userMessageId: userMessage.id,
      assistantMessageId: existingAssistant.id,
      content: existingAssistant.content,
    });
  }

  // Explicit skill invocation (P1-11) and the /create-skill flow (P1-12):
  // skill cards arrive as structured skillIds; typed slash commands are parsed
  // from the message text so IM-style prefixes also work on the web.
  let agentMessage = body.data.message;
  let createSkillMode = false;
  const explicitSkillIds = [...(body.data.skillIds ?? [])];
  const command = parseSlashCommand(body.data.message);
  if (command?.kind === "create_skill") {
    createSkillMode = true;
    if (command.rest) agentMessage = command.rest;
  } else if (command?.kind === "use_skill") {
    const skill = await repositories.skills.findEnabledByName(scope, command.name);
    if (skill) {
      if (!explicitSkillIds.includes(skill.id)) explicitSkillIds.push(skill.id);
      agentMessage = command.rest || buildExplicitSkillFallbackMessage(skill.name);
    }
  }

  const searchGate = createSearchGate({
    aggressiveness: normalizeSearchAggressiveness(settings.search?.aggressiveness),
    userMessage: body.data.message,
    userEnabled: body.data.searchEnabled === true,
  });

  leaseTransferredToStream = true;
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new ReadableStream({
      async start(controller) {
        let assistantText = "";
        let executionAccepted = false;
        let assistantPersisted = false;
        let admissionStage: "connection" | "turn_lock" | "execution" = "connection";
        let releaseExecutionLock: (() => Promise<void>) | undefined;
        let releaseUserConnection: (() => void) | undefined;
        let detachedPostTurn: DetachedPostTurnInput | undefined;

        const emit = (payload: unknown): boolean => {
          if (safeEnqueue(controller, encoder, payload)) return true;
          foreground.abort(new Error("chat_client_disconnected"));
          return false;
        };
        const acceptExecution = () => {
          executionAccepted = true;
          emit({
            type: "accepted",
            conversationId,
            userMessageId: userMessage.id,
            clientTurnId,
          });
        };

        try {
          foreground.signal.throwIfAborted();
          releaseUserConnection = userConnectionDisconnector.registerUserConnection(user.id);
          admissionStage = "turn_lock";
          releaseExecutionLock = await repositories.messages.acquireClientTurnExecutionLock(scope, clientTurnId);
          admissionStage = "execution";
          foreground.signal.throwIfAborted();

          const assistantAfterLock = await repositories.messages.findByClientTurn(scope, clientTurnId, "assistant");
          foreground.signal.throwIfAborted();
          if (assistantAfterLock) {
            assistantPersisted = true;
            acceptExecution();
            emit({ type: "chunk", content: assistantAfterLock.content });
            emit({
              type: "done",
              conversationId,
              clientTurnId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantAfterLock.id,
            });
            safeClose(controller);
            return;
          }

          const executionClaimed = await repositories.messages.claimClientTurnExecution(scope, clientTurnId);
          foreground.signal.throwIfAborted();
          if (!executionClaimed) {
            const interruptedText = "刚才没能完整回复，你把那条消息再发一次，我重新接着看。";
            const interruptedTurn = await repositories.messages.createIdempotentAssistantTurn(scope, {
              conversationId,
              clientTurnId,
              content: interruptedText,
            });
            assistantPersisted = true;
            acceptExecution();
            emit({ type: "chunk", content: interruptedTurn.message.content });
            emit({
              type: "done",
              conversationId,
              clientTurnId,
              userMessageId: userMessage.id,
              assistantMessageId: interruptedTurn.message.id,
              degraded: true,
            });
            safeClose(controller);
            return;
          }

          acceptExecution();
          foreground.signal.throwIfAborted();
          for await (const chunk of runAgent({
            userId: user.id,
            agentId: scope.agentId,
            conversationId,
            message: agentMessage,
            attachments: currentLlmAttachments,
            history,
            attachmentToolGuard: currentAttachments.length > 0 || historicalAttachments.length > 0,
            persona: settings.persona,
            llm: client,
            model,
            repositories,
            explicitSkillIds,
            createSkillMode,
            webSearchEnabled: body.data.searchEnabled === true,
            searchGate,
            signal: foreground.signal,
            search: {
              run: async (query, signal) => {
                const results = await searchWeb(query, env, signal);
                return { results, summary: summarizeSearchResults(results) };
              },
            },
            skillInstaller: {
              install: (url, signal) =>
                installSkillsFromGitHub({
                  url,
                  userId: user.id,
                  repositories,
                  scanner: { llm: light.client, model: light.model },
                  token: env.githubToken,
                  signal,
                }),
            },
          })) {
            foreground.signal.throwIfAborted();
            assistantText += chunk;
            emit({ type: "chunk", content: chunk });
          }

          if (!assistantText.trim()) {
            assistantText = "我这边刚才没顺利想出来，等一下我们再试一次。";
            emit({ type: "chunk", content: assistantText });
            foreground.signal.throwIfAborted();
          }

          const assistantTurn = await repositories.messages.createIdempotentAssistantTurn(scope, {
            conversationId,
            clientTurnId,
            content: assistantText,
          });
          assistantPersisted = true;
          const assistantMessage = assistantTurn.message;
          if (!assistantTurn.created && assistantMessage.content !== assistantText) {
            emit({ type: "replace", content: assistantMessage.content });
            assistantText = assistantMessage.content;
          }

          foreground.signal.throwIfAborted();
          if (assistantTurn.created) try {
            const reminder = parseReminder(body.data.message);
            if (reminder) {
              await repositories.proactiveTasks.create(scope, {
                conversationId,
                kind: "reminder",
                content: reminder.content,
                scheduledAt: reminder.scheduledAt,
                metadata: { urgent: reminder.urgent },
              });
            } else {
              const followUp = parseFollowUp(body.data.message);
              if (followUp) {
                await repositories.proactiveTasks.create(scope, {
                  conversationId,
                  kind: "follow_up",
                  content: followUp.content,
                  scheduledAt: followUp.scheduledAt,
                });
              }
            }
          } catch {
            console.error("chat_proactive_task_failed", { code: "proactive_task_create_failed" });
          }

          foreground.signal.throwIfAborted();
          emit({
            type: "done",
            conversationId,
            clientTurnId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
          });
          foreground.signal.throwIfAborted();
          safeClose(controller);

          if (assistantTurn.created) {
            detachedPostTurn = {
              repositories,
              fence: userDataLease.requestFence,
              scope,
              conversationId,
              conversationTitle: conversation.title,
              userText: body.data.message,
              assistantText,
              llm: light.client,
              model: light.model,
            };
          }
        } catch (error) {
          if (!executionAccepted) {
            if (admissionStage === "connection") {
              emit({ type: "error", message: "个人数据正在清理，请稍后重试。" });
            } else {
              if (admissionStage === "turn_lock") {
                console.error("chat_turn_lock_failed", { code: "turn_lock_acquire_failed" });
              } else {
                console.error("chat_turn_admission_failed", {
                  code: "turn_admission_failed",
                  errorType: error instanceof Error ? "Error" : "NonError",
                });
              }
              emit({ type: "error", message: "消息暂时没有受理，请重试。" });
            }
            safeClose(controller);
            return;
          }

          if (assistantPersisted) {
            safeClose(controller);
            return;
          }

          const fallback = "我这边刚才有点卡住了，但不是你的问题。我们可以稍后再试一次。";
          const suffix = assistantText.trim() ? `\n\n${fallback}` : fallback;
          const content = `${assistantText}${suffix}`;
          console.error("chat_agent_failed", {
            code: "agent_response_failed",
            errorType: error instanceof Error ? "Error" : "NonError",
          });
          let fallbackTurn;
          try {
            fallbackTurn = await repositories.messages.createIdempotentAssistantTurn(scope, {
              conversationId,
              clientTurnId,
              content,
            });
            assistantPersisted = true;
          } catch (fallbackError) {
            console.error("chat_fallback_persist_failed", {
              code: "fallback_persist_failed",
              errorType: fallbackError instanceof Error ? "Error" : "NonError",
            });
            emit({
              type: "done",
              conversationId,
              clientTurnId,
              userMessageId: userMessage.id,
              degraded: true,
            });
            safeClose(controller);
            return;
          }
          const fallbackMessage = fallbackTurn.message;
          if (fallbackTurn.created) {
            emit({ type: "chunk", content: suffix });
          } else {
            emit({ type: "replace", content: fallbackMessage.content });
          }
          emit({
            type: "done",
            conversationId,
            clientTurnId,
            userMessageId: userMessage.id,
            assistantMessageId: fallbackMessage.id,
            degraded: true,
          });
          safeClose(controller);
        } finally {
          if (releaseExecutionLock) {
            await releaseExecutionLock().catch(() => {
              console.error("chat_turn_lock_release_failed", { code: "turn_lock_release_failed" });
            });
          }
          releaseUserConnection?.();
          await releaseChatUserDataLease(userDataLease);
          foreground.dispose();
          if (detachedPostTurn) {
            startDetachedPostTurn(detachedPostTurn);
          }
        }
      },
      cancel(reason) {
        foreground.abort(toAbortReason(reason, "chat_client_disconnected"));
      },
    });
  } catch (error) {
    leaseTransferredToStream = false;
    throw error;
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
  } finally {
    if (!leaseTransferredToStream) {
      await releaseChatUserDataLease(userDataLease);
      foreground.dispose();
    }
  }
}

async function releaseChatUserDataLease(lease: UserDataLease): Promise<void> {
  await lease.release().catch(() => {
    console.error("chat_user_data_lease_release_failed", { code: "user_data_lease_release_failed" });
  });
}

async function loadTurnAttachments(input: {
  repositories: ReturnType<typeof createRepositories>;
  scope: AgentScope;
  attachmentIds: string[];
  existingUserMessageId?: string;
}): Promise<DbMessageAttachment[] | null> {
  if (new Set(input.attachmentIds).size !== input.attachmentIds.length) return null;
  const attachments = await Promise.all(
    input.attachmentIds.map((attachmentId) => input.repositories.messageAttachments.get(input.scope, attachmentId)),
  );
  if (
    attachments.some(
      (attachment) =>
        !attachment
        || !(
          (attachment.status === "ready" && attachment.messageId === null)
          || (
            attachment.status === "bound"
            && Boolean(input.existingUserMessageId)
            && attachment.messageId === input.existingUserMessageId
          )
        ),
    )
  ) {
    return null;
  }
  const bindable = attachments as DbMessageAttachment[];
  const totalSize = bindable.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  return totalSize <= ATTACHMENT_LIMITS.maxMessageBytes ? bindable : null;
}

function orderAttachmentsByMessage(
  messageIds: string[],
  attachments: DbMessageAttachment[],
): DbMessageAttachment[] {
  const order = new Map(messageIds.map((messageId, index) => [messageId, index]));
  return [...attachments].sort(
    (left, right) => (order.get(left.messageId ?? "") ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.messageId ?? "") ?? Number.MAX_SAFE_INTEGER),
  );
}

function attachHistoryFiles(
  historyRows: Array<{ role: "user" | "assistant"; content: string; id?: string }>,
  originalAttachments: DbMessageAttachment[],
  loadedAttachments: Array<{
    attachment: DbMessageAttachment;
    llmAttachment: NonNullable<LlmMessage["attachments"]>[number];
  }>,
): LlmMessage[] {
  const messagesWithOriginalAttachments = new Set(
    originalAttachments
      .map((attachment) => attachment.messageId)
      .filter((messageId): messageId is string => messageId !== null),
  );
  const byMessage = new Map<string, NonNullable<LlmMessage["attachments"]>>();
  loadedAttachments.forEach(({ attachment, llmAttachment }) => {
    if (!attachment.messageId) return;
    const list = byMessage.get(attachment.messageId) ?? [];
    list.push(llmAttachment);
    byMessage.set(attachment.messageId, list);
  });
  return historyRows.map((message) => {
    const attachments = message.id ? byMessage.get(message.id) : undefined;
    const needsCroppedAttachmentPlaceholder =
      message.role === "user"
      && message.content.trim().length === 0
      && Boolean(message.id && messagesWithOriginalAttachments.has(message.id))
      && !attachments?.length;
    return {
      role: message.role,
      content: needsCroppedAttachmentPlaceholder
        ? "[该轮历史附件已从当前模型上下文中裁剪；这不是新的用户指令。]"
        : message.content,
      ...(attachments?.length ? { attachments } : {}),
    };
  });
}

function toSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function safeEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  payload: unknown,
): boolean {
  try {
    controller.enqueue(encoder.encode(toSse(payload)));
    return true;
  } catch {
    return false;
  }
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // The client may have cancelled after persistence; transport closure is best-effort.
  }
}

function createClientTurnErrorResponse(error: unknown): NextResponse {
  const code = error instanceof Error ? error.message : "chat_turn_create_failed";
  if (code === "client_turn_conflict") {
    return NextResponse.json({ error: code }, { status: 409 });
  }
  if (code === "conversation_not_found") {
    return NextResponse.json({ error: code }, { status: 404 });
  }
  if (
    code === "attachment_not_bindable"
    || code === "attachment_count_exceeded"
    || code === "attachment_total_size_exceeded"
  ) {
    return NextResponse.json({ error: code }, { status: 400 });
  }
  console.error("chat_turn_create_failed", { code: "turn_persist_failed" });
  return NextResponse.json({ error: "chat_turn_create_failed" }, { status: 500 });
}

function createReplayResponse(input: {
  encoder: TextEncoder;
  conversationId: string;
  clientTurnId: string;
  userMessageId: string;
  assistantMessageId: string;
  content: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      safeEnqueue(controller, input.encoder, {
        type: "accepted",
        conversationId: input.conversationId,
        clientTurnId: input.clientTurnId,
        userMessageId: input.userMessageId,
      });
      safeEnqueue(controller, input.encoder, { type: "chunk", content: input.content });
      safeEnqueue(controller, input.encoder, {
        type: "done",
        conversationId: input.conversationId,
        clientTurnId: input.clientTurnId,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
      });
      safeClose(controller);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function hashClientTurnPayload(input: {
  conversationId: string;
  message: string;
  attachmentIds: string[];
  skillIds: string[];
  searchEnabled: boolean;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

type DetachedPostTurnInput = {
  repositories: ReturnType<typeof createRepositories>;
  fence: UserDataRequestFence;
  scope: AgentScope;
  conversationId: string;
  conversationTitle: string;
  userText: string;
  assistantText: string;
  llm: ReturnType<typeof getLlmClient>["client"];
  model: string;
};

type AbortLifecycle = {
  signal: AbortSignal;
  abort(reason: unknown): void;
  dispose(): void;
};

function createBoundedAbortLifecycle(input: {
  sourceSignals: AbortSignal[];
  timeoutMs: number;
  timeoutCode: string;
}): AbortLifecycle {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let disposed = false;

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(toAbortReason(reason, input.timeoutCode));
    }
  };

  for (const sourceSignal of input.sourceSignals) {
    if (sourceSignal.aborted) {
      abort(sourceSignal.reason);
      break;
    }
    const listener = () => abort(sourceSignal.reason);
    sourceSignal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal: sourceSignal, listener });
  }

  const timer = setTimeout(() => abort(new Error(input.timeoutCode)), input.timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    abort,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function toAbortReason(reason: unknown, fallbackCode: string): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason ? reason : fallbackCode);
}

function startDetachedPostTurn(input: DetachedPostTurnInput): void {
  const lifecycle = createBoundedAbortLifecycle({
    sourceSignals: [],
    timeoutMs: CHAT_POST_TURN_TIMEOUT_MS,
    timeoutCode: "chat_post_turn_timeout",
  });

  void (async () => {
    let lease: UserDataLease | undefined;
    try {
      lease = await input.repositories.userDataMutations.acquireSharedLease(input.fence, {
        signal: lifecycle.signal,
      });
      lifecycle.signal.throwIfAborted();
      await runPostTurnTasks({
        ...input,
        signal: lifecycle.signal,
      });
    } catch (error) {
      if (
        !lifecycle.signal.aborted
        && (!(error instanceof Error) || error.message !== "user_data_epoch_changed")
      ) {
        console.error("chat_post_turn_failed", {
          code: "post_turn_failed",
          errorType: error instanceof Error ? "Error" : "NonError",
        });
      }
    } finally {
      if (lease) {
        await releaseChatUserDataLease(lease);
      }
      lifecycle.dispose();
    }
  })().catch(() => {
    lifecycle.dispose();
  });
}

async function runPostTurnTasks(input: {
  repositories: ReturnType<typeof createRepositories>;
  scope: AgentScope;
  conversationId: string;
  conversationTitle: string;
  userText: string;
  assistantText: string;
  llm: ReturnType<typeof getLlmClient>["client"];
  model: string;
  signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const isDefaultTitle = input.conversationTitle === "新的对话" || input.conversationTitle === "和 DigitalMate 的对话";
  if (isDefaultTitle) {
    try {
      const title = await generateConversationTitle({
        llm: input.llm,
        model: input.model,
        userText: input.userText,
        assistantText: input.assistantText,
        signal: input.signal,
      });
      input.signal.throwIfAborted();
      await input.repositories.conversations.setTitleIfDefault(input.scope, input.conversationId, title);
      input.signal.throwIfAborted();
    } catch {
      input.signal.throwIfAborted();
    }
  }

  input.signal.throwIfAborted();
  try {
    await recordTurnReview(input.repositories, {
      scope: input.scope,
      conversationId: input.conversationId,
      llm: input.llm,
      model: input.model,
      userText: input.userText,
      assistantText: input.assistantText,
      signal: input.signal,
    });
  } catch {
    input.signal.throwIfAborted();
  }
}
