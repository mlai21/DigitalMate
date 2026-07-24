import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import { createSearchGate, normalizeSearchAggressiveness } from "@/server/agent/search-gate";
import { buildExplicitSkillFallbackMessage, parseSlashCommand } from "@/server/agent/skill-command";
import { splitAssistantText } from "@/server/agent/streaming";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { shouldInterject } from "@/server/channels/interjection";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import type { ReflectionRecord } from "@/server/evolution/reflection";
import type { SkillInstallOutcome } from "@/server/skills/install";
import type { LlmClient } from "@/server/llm/types";
import type { AgentScope } from "@/server/agents/types";
import type { ToolLogInput } from "@/server/agent/run-agent";

type ChannelRepositories = {
  channels: {
    ensureConversation(scope: AgentScope, message: NormalizedChannelMessage): Promise<{ id: string }>;
    createChannelMessage(scope: AgentScope, input: unknown): Promise<unknown> | unknown;
    recentBotMessageAt(scope: AgentScope, channel: string, externalConversationId: string): Promise<Date | null>;
    sentCounts(scope: AgentScope, channel: string, externalConversationId: string, now?: Date): Promise<{ sentInLastHour: number; sentToday: number }>;
    recentMessageCount(scope: AgentScope, channel: string, externalConversationId: string, since: Date): Promise<number>;
    createDecision(scope: AgentScope, input: unknown): Promise<unknown> | unknown;
  };
  memories: {
    findRelevant(
      scope: AgentScope,
      query: string,
      signal?: AbortSignal,
    ): Promise<Array<{ id: string; content: string; createdAt: Date }>>;
  };
  proactiveTasks: {
    create(scope: AgentScope, input: {
      conversationId: string;
      kind: "reminder" | "follow_up" | "share";
      content: string;
      scheduledAt: Date;
      metadata?: Record<string, unknown>;
    }): Promise<unknown> | unknown;
  };
  toolLogs: {
    create(input: ToolLogInput): unknown;
  };
  reflections?: {
    create(scope: AgentScope, input: { reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<unknown> | unknown;
    latestBySourceEvent?(scope: AgentScope, event: string): Promise<Date | null>;
    findAppliedSuggestions?(scope: AgentScope): Promise<string[]>;
  };
  messages: {
    recentHistory(scope: AgentScope, conversationId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>>;
    create(scope: AgentScope, input: {
      conversationId: string;
      role: "user" | "assistant" | "system";
      content: string;
      visibleToUser?: boolean;
      memoryProcessed?: boolean;
    }): Promise<unknown> | unknown;
  };
  skills?: {
    findEnabledByName?(scope: AgentScope, name: string): Promise<{ id: string; name: string } | null>;
  };
  settings: {
    get(scope: AgentScope): Promise<{
      persona: { name: string; style: string; emojiHabit?: string };
      proactivity: { quietStart: string; quietEnd: string; maxPerDay: number; minIntervalMinutes?: number; maxPerHour?: number };
      modelRouting: { main: string; light: string };
      cadence: unknown;
      search?: { aggressiveness?: string };
    }>;
  };
};

export async function handleChannelMessage(input: {
  message: NormalizedChannelMessage;
  scope: AgentScope;
  repositories: ChannelRepositories;
  llm: LlmClient;
  model: string;
  send(
    message: NormalizedChannelMessage,
    text: string,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
  skillInstaller?: {
    install(url: string, signal?: AbortSignal): Promise<SkillInstallOutcome>;
  };
  /** Light-model client used for the web_search hard gate (PRD 5.4). */
  lightLlm?: { client: LlmClient; model: string };
  delay?(ms: number, signal?: AbortSignal): Promise<unknown> | unknown;
  signal?: AbortSignal;
  now?: Date;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const conversation = await input.repositories.channels.ensureConversation(input.scope, input.message);
  input.signal?.throwIfAborted();
  await input.repositories.channels.createChannelMessage(input.scope, { conversationId: conversation.id, message: input.message });
  input.signal?.throwIfAborted();
  await input.repositories.messages.create(input.scope, {
    conversationId: conversation.id,
    role: "user",
    content: input.message.text,
    memoryProcessed: input.message.chatType === "group",
  });
  input.signal?.throwIfAborted();
  if (input.repositories.reflections) {
    await recordEventReflection(
      { reflections: input.repositories.reflections },
      {
        scope: input.scope,
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
  input.signal?.throwIfAborted();

  if (input.message.chatType === "group") {
    const recentWindowStart = new Date(now.getTime() - 2 * 60_000);
    const [settings, memories, recentBotMessageAt, counts, recentMessageCount] = await Promise.all([
      input.repositories.settings.get(input.scope),
      input.repositories.memories.findRelevant(input.scope, input.message.text, input.signal),
      input.repositories.channels.recentBotMessageAt(input.scope, input.message.channel, input.message.externalConversationId),
      input.repositories.channels.sentCounts(input.scope, input.message.channel, input.message.externalConversationId, now),
      input.repositories.channels.recentMessageCount(input.scope, input.message.channel, input.message.externalConversationId, recentWindowStart),
    ]);
    input.signal?.throwIfAborted();
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
    await input.repositories.channels.createDecision(input.scope, {
      conversationId: conversation.id,
      message: input.message,
      shouldInterject: decision.shouldInterject,
      reason: decision.reason,
    });
    input.signal?.throwIfAborted();
    if (!decision.shouldInterject) return;
  }

  const settings = await input.repositories.settings.get(input.scope);
  const history = await input.repositories.messages.recentHistory(input.scope, conversation.id);
  input.signal?.throwIfAborted();

  // IM channels cannot render skill cards, so slash prefixes are the explicit
  // invocation path here: "/skill-name ..." and "/create-skill ..." (P1-11/12).
  let agentMessage = input.message.text;
  let createSkillMode = false;
  const explicitSkillIds: string[] = [];
  const command = parseSlashCommand(input.message.text);
  if (command?.kind === "create_skill") {
    createSkillMode = true;
    if (command.rest) agentMessage = command.rest;
  } else if (command?.kind === "use_skill" && input.repositories.skills?.findEnabledByName) {
    const skill = await input.repositories.skills.findEnabledByName(input.scope, command.name);
    if (skill) {
      explicitSkillIds.push(skill.id);
      agentMessage = command.rest || buildExplicitSkillFallbackMessage(skill.name);
    }
  }

  const searchGate = createSearchGate({
    aggressiveness: normalizeSearchAggressiveness(settings.search?.aggressiveness),
    userMessage: input.message.text,
    userEnabled: false,
  });

  let answer = "";
  for await (const chunk of runAgent({
    userId: input.scope.userId,
    agentId: input.scope.agentId,
    conversationId: conversation.id,
    message: agentMessage,
    history,
    persona: settings.persona,
    llm: input.llm,
    model: input.model,
    repositories: input.repositories as Parameters<typeof runAgent>[0]["repositories"],
    explicitSkillIds,
    createSkillMode,
    searchGate,
    signal: input.signal,
    search: {
      run: async (query, signal) => {
        const results = await searchWeb(query, undefined, signal);
        return { results, summary: summarizeSearchResults(results) };
      },
    },
    skillInstaller: input.skillInstaller,
  })) {
    input.signal?.throwIfAborted();
    answer += chunk;
  }
  input.signal?.throwIfAborted();
  if (!answer.trim()) return;
  await input.repositories.messages.create(input.scope, {
    conversationId: conversation.id,
    role: "assistant",
    content: answer,
  });
  input.signal?.throwIfAborted();
  const cadence = normalizeCadence(settings.cadence);
  const segments = splitAssistantText(answer).slice(0, cadence.maxSegments);
  if (segments.length > 0 && cadence.responseDelayMs > 0) {
    await runDelay(input.delay, cadence.responseDelayMs, input.signal);
  }
  for (const [index, segment] of segments.entries()) {
    input.signal?.throwIfAborted();
    if (index > 0 && cadence.segmentDelayMs > 0) {
      await runDelay(input.delay, cadence.segmentDelayMs, input.signal);
    }
    if (input.signal) {
      await input.send(input.message, segment, input.signal);
    } else {
      await input.send(input.message, segment);
    }
    input.signal?.throwIfAborted();
  }
}

async function scheduleDirectChannelTask(
  input: {
    message: NormalizedChannelMessage;
    scope: AgentScope;
    repositories: ChannelRepositories;
  },
  conversationId: string,
  now: Date,
): Promise<void> {
  if (input.message.chatType !== "direct") return;

  const reminder = parseReminder(input.message.text, now);
  if (reminder) {
    await input.repositories.proactiveTasks.create(input.scope, {
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
  await input.repositories.proactiveTasks.create(input.scope, {
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

function runDelay(
  delay: ((ms: number, signal?: AbortSignal) => Promise<unknown> | unknown) | undefined,
  ms: number,
  signal?: AbortSignal,
): Promise<unknown> | unknown {
  return delay
    ? signal
      ? delay(ms, signal)
      : delay(ms)
    : sleep(ms, signal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }

    function finish() {
      cleanup();
      resolve();
    }
  });
}
