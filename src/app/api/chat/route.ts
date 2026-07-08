import { NextResponse } from "next/server";
import { z } from "zod";
import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { getLlmClient } from "@/server/llm/router";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
});

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
  const userMessage = await repositories.messages.create({
    userId: user.id,
    conversationId,
    role: "user",
    content: body.data.message,
  });
  await recordEventReflection(repositories, {
    userId: user.id,
    event: "user_dissatisfaction",
    summary: body.data.message,
    source: { conversationId, messageId: userMessage.id },
  }).catch(() => undefined);
  const settings = await repositories.settings.get(user.id);
  const history = await repositories.messages.recentHistory(conversationId);
  const env = readEnv();
  const { client, model } = getLlmClient("main", env, settings.modelRouting);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let assistantText = "";
      try {
        for await (const chunk of runAgent({
          userId: user.id,
          conversationId,
          message: body.data.message,
          history,
          persona: settings.persona,
          llm: client,
          model,
          repositories,
          search: {
            run: async (query) => {
              const results = await searchWeb(query);
              return { results, summary: summarizeSearchResults(results) };
            },
          },
        })) {
          assistantText += chunk;
          controller.enqueue(encoder.encode(toSse({ type: "chunk", content: chunk })));
        }

        if (!assistantText.trim()) {
          assistantText = "我这边刚才没顺利想出来，等一下我们再试一次。";
          controller.enqueue(encoder.encode(toSse({ type: "chunk", content: assistantText })));
        }

        await repositories.messages.create({
          userId: user.id,
          conversationId,
          role: "assistant",
          content: assistantText,
        });

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

        controller.enqueue(encoder.encode(toSse({ type: "done", conversationId })));
        controller.close();
      } catch (error) {
        const content = "我这边刚才有点卡住了，但不是你的问题。我们可以稍后再试一次。";
        await repositories.messages.create({ userId: user.id, conversationId, role: "assistant", content });
        controller.enqueue(encoder.encode(toSse({ type: "chunk", content })));
        controller.enqueue(
          encoder.encode(
            toSse({
              type: "error",
              message: error instanceof Error ? error.message : "unknown_error",
            }),
          ),
        );
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

function toSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
