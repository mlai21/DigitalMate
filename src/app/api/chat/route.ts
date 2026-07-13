import { NextResponse } from "next/server";
import { z } from "zod";
import { generateConversationTitle } from "@/server/agent/conversation-title";
import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import { createSearchGate, normalizeSearchAggressiveness } from "@/server/agent/search-gate";
import { buildExplicitSkillFallbackMessage, parseSlashCommand } from "@/server/agent/skill-command";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { loadAttachmentContext } from "@/server/attachments/context";
import { readAttachment } from "@/server/attachments/storage";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories, type DbMessageAttachment } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { recordTurnReview } from "@/server/evolution/turn-review";
import { supportsImageInput } from "@/server/llm/catalog";
import type { LlmMessage } from "@/server/llm/types";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";

export const runtime = "nodejs";

const requestSchema = z
  .object({
    message: z.string().max(8000).default(""),
    attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_LIMITS.maxCount).default([]),
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

  const body = requestSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repositories = createRepositories();
  const conversation = body.data.conversationId
    ? await repositories.conversations.getForUser(user.id, body.data.conversationId)
    : await repositories.conversations.getOrCreateDefault(user.id);
  if (!conversation) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }
  const conversationId = conversation.id;

  // Read history before creating the current turn so it cannot be appended
  // twice by buildMessages (once in history and once as the current user turn).
  const historyRows = await repositories.messages.recentHistory(conversationId);
  const settings = await repositories.settings.get(user.id);
  const env = readEnv();
  const { client, model } = getLlmClient("main", env, settings.modelRouting);
  const light = getLlmClient("light", env, settings.modelRouting);
  const currentAttachments = await loadBindableAttachments({
    repositories,
    userId: user.id,
    attachmentIds: body.data.attachmentIds,
  });
  if (!currentAttachments) {
    return NextResponse.json({ error: "attachment_not_bindable" }, { status: 400 });
  }

  const historyMessageIds = historyRows
    .map((message) => ("id" in message && typeof message.id === "string" ? message.id : null))
    .filter((id): id is string => id !== null);
  const historicalAttachments = historyMessageIds.length > 0
    ? await repositories.messageAttachments.listForMessages(user.id, historyMessageIds)
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

  let userMessage;
  if (body.data.attachmentIds.length > 0) {
    try {
      const created = await repositories.messages.createWithAttachments({
        userId: user.id,
        conversationId,
        content: body.data.message,
        attachmentIds: body.data.attachmentIds,
      });
      userMessage = created.message;
    } catch {
      return NextResponse.json({ error: "attachment_not_bindable" }, { status: 400 });
    }
  } else {
    userMessage = await repositories.messages.create({
      userId: user.id,
      conversationId,
      role: "user",
      content: body.data.message,
    });
  }
  await recordEventReflection(repositories, {
    userId: user.id,
    event: "user_dissatisfaction",
    summary: body.data.message,
    source: { conversationId, messageId: userMessage.id },
  }).catch(() => undefined);
  const encoder = new TextEncoder();

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
    const skill = await repositories.skills.findEnabledByName(user.id, command.name);
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

  const stream = new ReadableStream({
    async start(controller) {
      let assistantText = "";
      controller.enqueue(encoder.encode(toSse({
        type: "accepted",
        conversationId,
        userMessageId: userMessage.id,
      })));
      try {
        for await (const chunk of runAgent({
          userId: user.id,
          conversationId,
          message: agentMessage,
          attachments: currentLlmAttachments,
          history,
          persona: settings.persona,
          llm: client,
          model,
          repositories,
          explicitSkillIds,
          createSkillMode,
          webSearchEnabled: body.data.searchEnabled === true,
          searchGate,
          search: {
            run: async (query) => {
              const results = await searchWeb(query);
              return { results, summary: summarizeSearchResults(results) };
            },
          },
          skillInstaller: {
            install: (url) =>
              installSkillsFromGitHub({
                url,
                userId: user.id,
                repositories,
                scanner: { llm: light.client, model: light.model },
                token: env.githubToken,
              }),
          },
        })) {
          assistantText += chunk;
          controller.enqueue(encoder.encode(toSse({ type: "chunk", content: chunk })));
        }

        if (!assistantText.trim()) {
          assistantText = "我这边刚才没顺利想出来，等一下我们再试一次。";
          controller.enqueue(encoder.encode(toSse({ type: "chunk", content: assistantText })));
        }

        const assistantMessage = await repositories.messages.create({
          userId: user.id,
          conversationId,
          role: "assistant",
          content: assistantText,
        });

        try {
          const reminder = parseReminder(body.data.message);
          if (reminder) {
            await repositories.proactiveTasks.create({
              userId: user.id,
              conversationId,
              kind: "reminder",
              content: reminder.content,
              scheduledAt: reminder.scheduledAt,
              metadata: { urgent: reminder.urgent },
            });
          } else {
            const followUp = parseFollowUp(body.data.message);
            if (followUp) {
              await repositories.proactiveTasks.create({
                userId: user.id,
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

        controller.enqueue(encoder.encode(toSse({
          type: "done",
          conversationId,
          assistantMessageId: assistantMessage.id,
        })));
        controller.close();

        // Post-turn background work on the light model: auto-title new
        // conversations and run the Hermes-style per-turn review. Neither may
        // block or fail the reply.
        setTimeout(() => {
          void runPostTurnTasks({
            repositories,
            userId: user.id,
            conversationId,
            conversationTitle: conversation.title,
            userText: body.data.message,
            assistantText,
            llm: light.client,
            model: light.model,
          });
        }, 0);
      } catch (error) {
        const fallback = "我这边刚才有点卡住了，但不是你的问题。我们可以稍后再试一次。";
        const suffix = assistantText.trim() ? `\n\n${fallback}` : fallback;
        const content = `${assistantText}${suffix}`;
        console.error("chat_agent_failed", {
          code: "agent_response_failed",
          errorType: error instanceof Error ? "Error" : "NonError",
        });
        let fallbackMessage;
        try {
          fallbackMessage = await repositories.messages.create({
            userId: user.id,
            conversationId,
            role: "assistant",
            content,
          });
        } catch (fallbackError) {
          console.error("chat_fallback_persist_failed", {
            code: "fallback_persist_failed",
            errorType: fallbackError instanceof Error ? "Error" : "NonError",
          });
          controller.enqueue(encoder.encode(toSse({ type: "done", conversationId, degraded: true })));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(toSse({ type: "chunk", content: suffix })));
        controller.enqueue(encoder.encode(toSse({
          type: "done",
          conversationId,
          assistantMessageId: fallbackMessage.id,
          degraded: true,
        })));
        controller.close();
      }
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

async function loadBindableAttachments(input: {
  repositories: ReturnType<typeof createRepositories>;
  userId: string;
  attachmentIds: string[];
}): Promise<DbMessageAttachment[] | null> {
  if (new Set(input.attachmentIds).size !== input.attachmentIds.length) return null;
  const attachments = await Promise.all(
    input.attachmentIds.map((attachmentId) => input.repositories.messageAttachments.getForUser(input.userId, attachmentId)),
  );
  if (
    attachments.some(
      (attachment) => !attachment || attachment.status !== "ready" || attachment.messageId !== null,
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

async function runPostTurnTasks(input: {
  repositories: ReturnType<typeof createRepositories>;
  userId: string;
  conversationId: string;
  conversationTitle: string;
  userText: string;
  assistantText: string;
  llm: ReturnType<typeof getLlmClient>["client"];
  model: string;
}): Promise<void> {
  const isDefaultTitle = input.conversationTitle === "新的对话" || input.conversationTitle === "和 DigitalMate 的对话";
  if (isDefaultTitle) {
    await generateConversationTitle({
      llm: input.llm,
      model: input.model,
      userText: input.userText,
      assistantText: input.assistantText,
    })
      .then((title) => input.repositories.conversations.setTitleIfDefault(input.conversationId, title))
      .catch(() => undefined);
  }

  await recordTurnReview(input.repositories, {
    userId: input.userId,
    conversationId: input.conversationId,
    llm: input.llm,
    model: input.model,
    userText: input.userText,
    assistantText: input.assistantText,
  }).catch(() => undefined);
}
