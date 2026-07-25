import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent } from "@/server/agent/run-agent";
import {
  createSearchGate,
  normalizeSearchAggressiveness,
  type SearchGate,
} from "@/server/agent/search-gate";
import {
  buildExplicitSkillFallbackMessage,
  parseSlashCommand,
} from "@/server/agent/skill-command";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import type { AgentScope } from "@/server/agents/types";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import type { SkillInstallOutcome } from "@/server/skills/install";
import type { LlmClient } from "@/server/llm/types";
import type { LlmRouteConfig } from "@/server/llm/router";
import type { createRepositories } from "@/server/db/repositories";

import { shouldInterject } from "../interjection";
import {
  hashExecutionRequest,
  type ExecutionJournal,
} from "./execution-journal";
import type {
  ChannelAgentTurnContext,
  ChannelTurnDecision,
} from "./turn-executor";

type Repositories = ReturnType<typeof createRepositories>;

type ChannelSettings = Awaited<
  ReturnType<Repositories["settings"]["get"]>
>;

type ResolvedModel = Readonly<{
  client: LlmClient;
  model: string;
}>;

type StoredInterjectionDecision = Readonly<{
  shouldInterject: boolean;
  reason: string;
}>;

export function createChannelAgentTurnRunner(input: Readonly<{
  repositories: Repositories;
  resolveMainModel(
    scope: AgentScope,
    routing: LlmRouteConfig,
  ): Promise<ResolvedModel> | ResolvedModel;
  search?: typeof searchWeb;
  skillInstaller?: Readonly<{
    install(
      scope: AgentScope,
      url: string,
      signal?: AbortSignal,
    ): Promise<SkillInstallOutcome>;
  }>;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());

  return {
    async decideTurn(
      context: ChannelAgentTurnContext,
    ): Promise<ChannelTurnDecision> {
      context.signal?.throwIfAborted();
      const message = toLegacyChannelMessage(context);
      await input.repositories.channels.createChannelMessage(
        context.claim.scope,
        {
          conversationId: context.conversationId,
          message,
        },
      );
      context.signal?.throwIfAborted();
      if (message.chatType !== "group") {
        return { kind: "proceed" };
      }

      const stepKey = "tool:group_interjection_decision";
      const action = await context.journal.begin({
        key: stepKey,
        kind: "tool",
        requestHash: hashExecutionRequest({
          eventId: context.claim.id,
          payloadHash: context.claim.payloadHash,
        }),
      });
      if (action === "reuse") {
        const stored = await context.journal
          .read<unknown>(stepKey);
        if (!isStoredInterjectionDecision(stored)) {
          throw new Error(
            "channel_interjection_decision_invalid",
          );
        }
        return stored.shouldInterject
          ? { kind: "proceed" }
          : { kind: "skip", reason: stored.reason };
      }
      if (action === "ambiguous") {
        return {
          kind: "skip",
          reason: "decision_outcome_unknown",
        };
      }

      try {
        const decision = await decideGroupInterjection(
          input.repositories,
          context.claim.scope,
          context.conversationId,
          message,
          now(),
          context.signal,
        );
        await context.journal.complete(stepKey, decision);
        return decision.shouldInterject
          ? { kind: "proceed" }
          : { kind: "skip", reason: decision.reason };
      } catch (error) {
        await context.journal
          .fail(stepKey, stableTurnErrorCode(error))
          .catch(() => undefined);
        throw error;
      }
    },

    async *runAgentTurn(
      context: ChannelAgentTurnContext,
    ): AsyncIterable<string> {
      context.signal?.throwIfAborted();
      const message = toLegacyChannelMessage(context);
      await recordDissatisfaction(
        input.repositories,
        context,
        message,
      );
      await scheduleDirectTask(
        input.repositories,
        context,
        message,
        now(),
      );
      context.signal?.throwIfAborted();

      const settings = await input.repositories.settings.get(
        context.claim.scope,
      );
      const history = await input.repositories.messages.recentHistory(
        context.claim.scope,
        context.conversationId,
      );
      const historyAttachments =
        await input.repositories.messageAttachments.listForMessages(
          context.claim.scope,
          history.map((message) => message.id),
        );
      const model = await input.resolveMainModel(
        context.claim.scope,
        settings.modelRouting,
      );
      context.signal?.throwIfAborted();

      const hasAttachmentContext =
        context.claim.normalizedEvent.permission
          .attachmentsPresent
        || context.claim.normalizedEvent.attachments.length > 0
        || historyAttachments.length > 0;
      const invocation = await resolveSkillInvocation(
        input.repositories,
        context.claim.scope,
        message.text,
        hasAttachmentContext
          ? "none"
          : context.claim.normalizedEvent.permission.skills,
      );
      const searchGate = hasAttachmentContext
        ? denyAttachmentSearch()
        : createSearchGate({
            aggressiveness: normalizeSearchAggressiveness(
              settings.search?.aggressiveness,
            ),
            userMessage: message.text,
            userEnabled: false,
          });

      yield* runAgent({
        userId: context.claim.scope.userId,
        agentId: context.claim.scope.agentId,
        conversationId: context.conversationId,
        message: invocation.message,
        history,
        persona: settings.persona,
        llm: model.client,
        model: model.model,
        repositories: channelAgentRepositories(
          input.repositories,
          invocation.createSkillMode,
        ),
        explicitSkillIds: invocation.explicitSkillIds,
        createSkillMode: invocation.createSkillMode,
        searchGate,
        attachmentToolGuard: hasAttachmentContext,
        executionJournal: context.journal,
        signal: context.signal,
        search: {
          run: async (query, signal) => {
            const results = await (
              input.search ?? searchWeb
            )(query, undefined, signal);
            return {
              results,
              summary: summarizeSearchResults(results),
            };
          },
        },
        ...(input.skillInstaller
          && invocation.allowSkillInstaller
          ? {
              skillInstaller: {
                install: (url, signal) =>
                  input.skillInstaller!.install(
                    context.claim.scope,
                    url,
                    signal,
                  ),
              },
            }
          : {}),
      });
    },
  };
}

export function toLegacyChannelMessage(
  context: Pick<ChannelAgentTurnContext, "claim">,
): NormalizedChannelMessage {
  const event = context.claim.normalizedEvent;
  if (
    !["telegram", "slack", "feishu", "dingtalk"]
      .includes(event.channelType)
  ) {
    throw new Error("channel_legacy_message_unsupported");
  }
  return {
    channel:
      event.channelType as NormalizedChannelMessage["channel"],
    externalConversationId: event.externalConversationId,
    externalMessageId: event.externalEventId,
    senderId: event.externalSenderId,
    chatType: event.chatType,
    text: event.text,
    occurredAt: event.occurredAt,
    raw: event.rawSummary,
  };
}

async function decideGroupInterjection(
  repositories: Repositories,
  scope: AgentScope,
  conversationId: string,
  message: NormalizedChannelMessage,
  now: Date,
  signal?: AbortSignal,
): Promise<StoredInterjectionDecision> {
  const recentWindowStart = new Date(
    now.getTime() - 2 * 60_000,
  );
  const [
    settings,
    memories,
    recentBotMessageAt,
    counts,
    recentMessageCount,
  ] = await Promise.all([
    repositories.settings.get(scope),
    repositories.memories.findRelevant(
      scope,
      message.text,
      signal,
    ),
    repositories.channels.recentBotMessageAt(
      scope,
      message.channel,
      message.externalConversationId,
    ),
    repositories.channels.sentCounts(
      scope,
      message.channel,
      message.externalConversationId,
      now,
    ),
    repositories.channels.recentMessageCount(
      scope,
      message.channel,
      message.externalConversationId,
      recentWindowStart,
    ),
  ]);
  signal?.throwIfAborted();
  const decision = shouldInterject({
    message,
    memories: memories.map((memory) => memory.content),
    now,
    policy: {
      minIntervalMinutes:
        settings.proactivity.minIntervalMinutes ?? 30,
      maxPerHour:
        settings.proactivity.maxPerHour ?? 2,
      maxPerDay: settings.proactivity.maxPerDay,
      quietStart: settings.proactivity.quietStart,
      quietEnd: settings.proactivity.quietEnd,
    },
    recentBotMessageAt,
    sentInLastHour: counts.sentInLastHour,
    sentToday: counts.sentToday,
    recentMessageCount,
  });
  await repositories.channels.createDecision(scope, {
    conversationId,
    message,
    shouldInterject: decision.shouldInterject,
    reason: decision.reason,
  });
  return decision;
}

async function scheduleDirectTask(
  repositories: Repositories,
  context: ChannelAgentTurnContext,
  message: NormalizedChannelMessage,
  now: Date,
): Promise<void> {
  if (message.chatType !== "direct") return;
  const reminder = parseReminder(message.text, now);
  const followUp = reminder
    ? null
    : parseFollowUp(message.text, now);
  const task = reminder
    ? {
        kind: "reminder" as const,
        content: reminder.content,
        scheduledAt: reminder.scheduledAt,
        metadata: { urgent: reminder.urgent },
      }
    : followUp
      ? {
          kind: "follow_up" as const,
          content: followUp.content,
          scheduledAt: followUp.scheduledAt,
        }
      : null;
  if (!task) return;

  const stepKey = `tool:schedule_${task.kind}`;
  const action = await context.journal.begin({
    key: stepKey,
    kind: "tool",
    requestHash: hashExecutionRequest({
      conversationId: context.conversationId,
      task,
    }),
  });
  if (action !== "run") return;
  try {
    await repositories.proactiveTasks.create(
      context.claim.scope,
      {
        conversationId: context.conversationId,
        ...task,
      },
    );
    await context.journal.complete(stepKey, {
      scheduled: true,
    });
  } catch (error) {
    await context.journal
      .fail(stepKey, stableTurnErrorCode(error))
      .catch(() => undefined);
    throw error;
  }
}

async function recordDissatisfaction(
  repositories: Repositories,
  context: ChannelAgentTurnContext,
  message: NormalizedChannelMessage,
): Promise<void> {
  const stepKey = "tool:record_dissatisfaction";
  const action = await context.journal.begin({
    key: stepKey,
    kind: "tool",
    requestHash: hashExecutionRequest({
      conversationId: context.conversationId,
      text: message.text,
    }),
  });
  if (action !== "run") return;
  try {
    const recorded = await recordEventReflection(
      { reflections: repositories.reflections },
      {
        scope: context.claim.scope,
        event: "user_dissatisfaction",
        summary: message.text,
        source: {
          conversationId: context.conversationId,
          channel: message.channel,
          externalMessageId: message.externalMessageId,
        },
      },
    );
    await context.journal.complete(stepKey, { recorded });
  } catch (error) {
    await context.journal
      .fail(stepKey, stableTurnErrorCode(error))
      .catch(() => undefined);
  }
}

async function resolveSkillInvocation(
  repositories: Repositories,
  scope: AgentScope,
  text: string,
  permission: "none" | "explicit_slash",
): Promise<{
  message: string;
  createSkillMode: boolean;
  explicitSkillIds: string[];
  allowSkillInstaller: boolean;
}> {
  const blocked = {
    message: text,
    createSkillMode: false,
    explicitSkillIds: [],
    allowSkillInstaller: false,
  };
  if (permission !== "explicit_slash") return blocked;

  const command = parseSlashCommand(text);
  if (command?.kind === "create_skill") {
    return {
      message: command.rest || text,
      createSkillMode: true,
      explicitSkillIds: [],
      allowSkillInstaller: false,
    };
  }
  if (command?.kind === "use_skill") {
    if (
      ["install-skill", "install_skill"]
        .includes(command.name.toLowerCase())
      && /^https:\/\/github\.com\//i.test(command.rest)
    ) {
      return {
        message: `请安装这个 Skill：${command.rest}`,
        createSkillMode: false,
        explicitSkillIds: [],
        allowSkillInstaller: true,
      };
    }
    const skill = await repositories.skills.findEnabledByName(
      scope,
      command.name,
    );
    if (skill) {
      return {
        message:
          command.rest
          || buildExplicitSkillFallbackMessage(skill.name),
        createSkillMode: false,
        explicitSkillIds: [skill.id],
        allowSkillInstaller: false,
      };
    }
  }
  return blocked;
}

function channelAgentRepositories(
  repositories: Repositories,
  createSkillMode: boolean,
): Parameters<typeof runAgent>[0]["repositories"] {
  return {
    memories: repositories.memories,
    conversationSummaries: repositories.conversationSummaries,
    reflections: repositories.reflections,
    llmUsage: repositories.llmUsage,
    toolLogs: repositories.toolLogs,
    skills: {
      findEnabled: async () => [],
      findByIds: repositories.skills.findByIds,
      recordUsage: repositories.skills.recordUsage,
      ...(createSkillMode
        ? { create: repositories.skills.create }
        : {}),
    },
  };
}

function denyAttachmentSearch(): SearchGate {
  return {
    async evaluate() {
      return {
        allowed: false,
        method: "policy_block",
        reason:
          "当前或历史上下文含附件，禁止联网与工具调用",
      };
    },
  };
}

function isStoredInterjectionDecision(
  value: unknown,
): value is StoredInterjectionDecision {
  return (
    typeof value === "object"
    && value !== null
    && typeof (
      value as { shouldInterject?: unknown }
    ).shouldInterject === "boolean"
    && typeof (value as { reason?: unknown }).reason === "string"
  );
}

function stableTurnErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^[a-z0-9_:-]{1,128}$/i.test(error.message)
  ) {
    return error.message.toLowerCase();
  }
  return "channel_turn_side_effect_failed";
}
