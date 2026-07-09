import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import { splitAssistantText } from "@/server/agent/streaming";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { shouldInterject } from "@/server/channels/interjection";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import type { ReflectionRecord } from "@/server/evolution/reflection";
import type { SkillInstallOutcome } from "@/server/skills/install";
import type { LlmClient } from "@/server/llm/types";

type ChannelRepositories = {
  channels: {
    ensureConversation(userId: string, message: NormalizedChannelMessage): Promise<{ id: string }>;
    createChannelMessage(input: unknown): Promise<unknown> | unknown;
    recentBotMessageAt(channel: string, externalConversationId: string): Promise<Date | null>;
    sentCounts(userId: string, channel: string, externalConversationId: string, now?: Date): Promise<{ sentInLastHour: number; sentToday: number }>;
    recentMessageCount(channel: string, externalConversationId: string, since: Date): Promise<number>;
    createDecision(input: unknown): Promise<unknown> | unknown;
  };
  memories: {
    findRelevant(userId: string, query: string): Promise<Array<{ id: string; content: string; createdAt: Date }>>;
  };
  proactiveTasks: {
    create(input: {
      userId: string;
      conversationId: string;
      kind: "reminder" | "follow_up" | "share";
      content: string;
      scheduledAt: Date;
      metadata?: Record<string, unknown>;
    }): Promise<unknown> | unknown;
  };
  toolLogs: {
    create(input: Parameters<typeof runAgent>[0]["repositories"]["toolLogs"] extends infer T ? never : never): unknown;
  } | { create(input: unknown): unknown };
  reflections?: {
    create(input: { userId: string; reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<unknown> | unknown;
    latestBySourceEvent?(userId: string, event: string): Promise<Date | null>;
    findAppliedSuggestions?(userId: string): Promise<string[]>;
  };
  messages: {
    recentHistory(conversationId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>>;
    create(input: {
      userId: string;
      conversationId: string;
      role: "user" | "assistant" | "system";
      content: string;
      visibleToUser?: boolean;
      memoryProcessed?: boolean;
    }): Promise<unknown> | unknown;
  };
  settings: {
    get(userId: string): Promise<{
      persona: { name: string; style: string; emojiHabit?: string };
      proactivity: { quietStart: string; quietEnd: string; maxPerDay: number; minIntervalMinutes?: number; maxPerHour?: number };
      modelRouting: { main: string; light: string };
      cadence: unknown;
    }>;
  };
};

export async function handleChannelMessage(input: {
  message: NormalizedChannelMessage;
  userId: string;
  repositories: ChannelRepositories;
  llm: LlmClient;
  model: string;
  send(message: NormalizedChannelMessage, text: string): Promise<unknown> | unknown;
  skillInstaller?: { install(url: string): Promise<SkillInstallOutcome> };
  delay?(ms: number): Promise<unknown> | unknown;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const conversation = await input.repositories.channels.ensureConversation(input.userId, input.message);
  await input.repositories.channels.createChannelMessage({ userId: input.userId, conversationId: conversation.id, message: input.message });
  await input.repositories.messages.create({
    userId: input.userId,
    conversationId: conversation.id,
    role: "user",
    content: input.message.text,
    memoryProcessed: input.message.chatType === "group",
  });
  if (input.repositories.reflections) {
    await recordEventReflection(
      { reflections: input.repositories.reflections },
      {
        userId: input.userId,
        event: "user_dissatisfaction",
        summary: input.message.text,
        source: {
          conversationId: conversation.id,
          channel: input.message.channel,
          externalMessageId: input.message.externalMessageId,
        },
      },
    ).catch(() => undefined);
  }
  await scheduleDirectChannelTask(input, conversation.id, now);

  if (input.message.chatType === "group") {
    const recentWindowStart = new Date(now.getTime() - 2 * 60_000);
    const [settings, memories, recentBotMessageAt, counts, recentMessageCount] = await Promise.all([
      input.repositories.settings.get(input.userId),
      input.repositories.memories.findRelevant(input.userId, input.message.text),
      input.repositories.channels.recentBotMessageAt(input.message.channel, input.message.externalConversationId),
      input.repositories.channels.sentCounts(input.userId, input.message.channel, input.message.externalConversationId, now),
      input.repositories.channels.recentMessageCount(input.message.channel, input.message.externalConversationId, recentWindowStart),
    ]);
    const decision = shouldInterject({
      message: input.message,
      memories: memories.map((memory) => memory.content),
      now,
      policy: {
        minIntervalMinutes: settings.proactivity.minIntervalMinutes ?? 30,
        maxPerHour: settings.proactivity.maxPerHour ?? 2,
        maxPerDay: settings.proactivity.maxPerDay,
        quietStart: settings.proactivity.quietStart,
        quietEnd: settings.proactivity.quietEnd,
      },
      recentBotMessageAt,
      sentInLastHour: counts.sentInLastHour,
      sentToday: counts.sentToday,
      recentMessageCount,
    });
    await input.repositories.channels.createDecision({
      userId: input.userId,
      conversationId: conversation.id,
      message: input.message,
      shouldInterject: decision.shouldInterject,
      reason: decision.reason,
    });
    if (!decision.shouldInterject) return;
  }

  const settings = await input.repositories.settings.get(input.userId);
  const history = await input.repositories.messages.recentHistory(conversation.id);
  let answer = "";
  for await (const chunk of runAgent({
    userId: input.userId,
    conversationId: conversation.id,
    message: input.message.text,
    history,
    persona: settings.persona,
    llm: input.llm,
    model: input.model,
    repositories: input.repositories as Parameters<typeof runAgent>[0]["repositories"],
    search: {
      run: async (query) => {
        const results = await searchWeb(query);
        return { results, summary: summarizeSearchResults(results) };
      },
    },
    skillInstaller: input.skillInstaller,
  })) {
    answer += chunk;
  }
  if (!answer.trim()) return;
  await input.repositories.messages.create({
    userId: input.userId,
    conversationId: conversation.id,
    role: "assistant",
    content: answer,
  });
  const cadence = normalizeCadence(settings.cadence);
  const segments = splitAssistantText(answer).slice(0, cadence.maxSegments);
  if (segments.length > 0 && cadence.responseDelayMs > 0) {
    await (input.delay ?? sleep)(cadence.responseDelayMs);
  }
  for (const [index, segment] of segments.entries()) {
    if (index > 0 && cadence.segmentDelayMs > 0) {
      await (input.delay ?? sleep)(cadence.segmentDelayMs);
    }
    await input.send(input.message, segment);
  }
}

async function scheduleDirectChannelTask(
  input: {
    message: NormalizedChannelMessage;
    userId: string;
    repositories: ChannelRepositories;
  },
  conversationId: string,
  now: Date,
): Promise<void> {
  if (input.message.chatType !== "direct") return;

  const reminder = parseReminder(input.message.text, now);
  if (reminder) {
    await input.repositories.proactiveTasks.create({
      userId: input.userId,
      conversationId,
      kind: "reminder",
      content: reminder.content,
      scheduledAt: reminder.scheduledAt,
      metadata: { urgent: reminder.urgent },
    });
    return;
  }

  const followUp = parseFollowUp(input.message.text, now);
  if (!followUp) return;
  await input.repositories.proactiveTasks.create({
    userId: input.userId,
    conversationId,
    kind: "follow_up",
    content: followUp.content,
    scheduledAt: followUp.scheduledAt,
  });
}

function normalizeCadence(value: unknown): { responseDelayMs: number; segmentDelayMs: number; maxSegments: number } {
  const cadence = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const responseDelayMs = Number(cadence.responseDelayMs ?? 0);
  const segmentDelayMs = Number(cadence.segmentDelayMs ?? 0);
  const maxSegments = Number(cadence.maxSegments ?? 5);
  return {
    responseDelayMs: Number.isFinite(responseDelayMs) && responseDelayMs > 0 ? Math.min(responseDelayMs, 2_000) : 0,
    segmentDelayMs: Number.isFinite(segmentDelayMs) && segmentDelayMs > 0 ? Math.min(segmentDelayMs, 2_000) : 0,
    maxSegments: Number.isFinite(maxSegments) && maxSegments > 0 ? Math.min(Math.floor(maxSegments), 20) : 5,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
