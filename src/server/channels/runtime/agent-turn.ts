import { parseFollowUp, parseReminder } from "@/server/agent/reminders";
import { runAgent, type SkillContext } from "@/server/agent/run-agent";
import { createLlmSkillMatcher } from "@/server/agent/skill-routing";
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
import {
  recordEventReflection,
  shouldReflectOnUserDissatisfaction,
} from "@/server/evolution/event-reflection";
import { recordSkillMismatch } from "@/server/evolution/skill-mismatch";
import type { SkillInstallOutcome } from "@/server/skills/install";
import type { LlmClient } from "@/server/llm/types";
import type { LlmRouteConfig } from "@/server/llm/router";
import type { createRepositories } from "@/server/db/repositories";

import { shouldInterject } from "../interjection";
import { hashExecutionRequest } from "./execution-journal";
import type {
  ChannelAgentTurnContext,
  ChannelTurnDecision,
} from "./turn-executor";
import type { NormalizedChannelEvent } from "./types";

type Repositories = ReturnType<typeof createRepositories>;

type ResolvedModel = Readonly<{
  client: LlmClient;
  model: string;
}>;

type StoredInterjectionDecision = Readonly<{
  shouldInterject: boolean;
  reason: string;
}>;

type SkillMatcher = (
  scope: AgentScope,
  query: string,
  signal?: AbortSignal,
) => Promise<SkillContext[]>;

const noSkillMatching: SkillMatcher = async () => [];

export function createChannelAgentTurnRunner(input: Readonly<{
  repositories: Repositories;
  resolveMainModel(
    scope: AgentScope,
    routing: LlmRouteConfig,
  ): Promise<ResolvedModel> | ResolvedModel;
  resolveLightModel(
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
      // Interjection is the "no @ needed" path (PRD P1-6). A direct mention is
      // an ordinary request and must never be filtered by interjection policy.
      if (
        message.chatType !== "group"
        || context.claim.normalizedEvent.mentioned
      ) {
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
        !hasAttachmentContext
          && context.claim.normalizedEvent.permission
            .manageGlobalAssets === true,
      );
      // Resolving the light route touches the DB, so resolve it once per turn
      // and only when something actually needs it. An unauthorized light route
      // degrades that feature instead of failing the reply.
      let resolvedLight: ResolvedModel | null | undefined;
      const resolveLight = async (): Promise<ResolvedModel | null> => {
        if (resolvedLight !== undefined) return resolvedLight;
        try {
          resolvedLight = await input.resolveLightModel(
            context.claim.scope,
            settings.modelRouting,
          );
        } catch {
          resolvedLight = null;
        }
        return resolvedLight;
      };

      let matchSkills: SkillMatcher = noSkillMatching;
      if (!hasAttachmentContext && invocation.explicitSkillIds.length === 0) {
        const light = await resolveLight();
        if (light) {
          matchSkills = createLlmSkillMatcher({
            llm: light.client,
            model: light.model,
            repositories: input.repositories,
          });
        }
      }
      context.signal?.throwIfAborted();

      // Runs before this turn's own usage log, so the Skill it looks up is the
      // one that was auto-applied to the message the user is correcting.
      await recordSkillMismatchDraft(
        input.repositories,
        context,
        message,
        resolveLight,
      );
      context.signal?.throwIfAborted();

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
          invocation.allowSkillCreation,
          message.chatType === "direct"
            ? message.contextKey ?? null
            : null,
          matchSkills,
        ),
        explicitSkillIds: invocation.explicitSkillIds,
        createSkillMode: invocation.createSkillMode,
        capabilityNotice: invocation.capabilityNotice,
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
    ![
      "telegram",
      "discord",
      "slack",
      "mattermost",
      "feishu",
      "dingtalk",
      "qq",
      "mqtt",
      "matrix",
      "wecom",
      "xiaoyi",
      "yuanbao",
    ]
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
    contextKey: channelContextKey(event),
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
    recentBotMessageAt,
    counts,
    recentMessageCount,
  ] = await Promise.all([
    repositories.settings.get(scope),
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
    memories: [],
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
  if (
    message.chatType !== "direct"
    || context.claim.normalizedEvent.permission
      .manageGlobalAssets !== true
  ) {
    return;
  }
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

/**
 * Turns a correction that followed an auto-matched Skill into a pending
 * scope-tightening draft.
 *
 * Unlike `recordDissatisfaction` this is not gated on `manageGlobalAssets`: the
 * draft changes nothing until an admin approves it, and the sales seat is
 * exactly where auto-matching gets used most, so its corrections are the most
 * valuable signal. Failures stay silent — this must never affect the reply.
 */
async function recordSkillMismatchDraft(
  repositories: Repositories,
  context: ChannelAgentTurnContext,
  message: NormalizedChannelMessage,
  resolveLight: () => Promise<ResolvedModel | null>,
): Promise<void> {
  if (!shouldReflectOnUserDissatisfaction(message.text)) return;
  const stepKey = "tool:skill_mismatch_draft";
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
    const light = await resolveLight();
    const proposed = light
      ? await recordSkillMismatch({
          repositories,
          scope: context.claim.scope,
          conversationId: context.conversationId,
          correction: message.text,
          llm: light.client,
          model: light.model,
          ...(context.signal ? { signal: context.signal } : {}),
        })
      : false;
    await context.journal.complete(stepKey, { proposed });
  } catch (error) {
    await context.journal
      .fail(stepKey, stableTurnErrorCode(error))
      .catch(() => undefined);
  }
}

const skillCapabilityDeniedNotice =
  "本轮不具备创建或安装 Skill 的能力。若用户提出这类请求，用自然语言说明你现在无法在这里创建或安装、需要由管理员处理，然后正常继续对话。";

const skillNotFoundNotice =
  "用户指定的 Skill 当前不存在或未启用。请直接按用户的实际意图正常回应，不要提及 Skill 索引或任何内部机制。";

type SkillInvocation = {
  message: string;
  createSkillMode: boolean;
  explicitSkillIds: string[];
  allowSkillInstaller: boolean;
  /** Admin-only: mounts the Skill mutation tools for the whole turn. */
  allowSkillCreation: boolean;
  capabilityNotice: string | null;
};

async function resolveSkillInvocation(
  repositories: Repositories,
  scope: AgentScope,
  text: string,
  permission: "none" | "explicit_slash",
  allowGlobalAssetMutation: boolean,
): Promise<SkillInvocation> {
  // Tool availability follows the admin gate alone, so an admin can also start a
  // creation flow in plain language; the slash command only drives the guided
  // prompt. Everyone else keeps the tools closed.
  const base = {
    message: text,
    createSkillMode: false,
    explicitSkillIds: [] as string[],
    allowSkillInstaller: false,
    allowSkillCreation: allowGlobalAssetMutation,
    capabilityNotice: null,
  } satisfies SkillInvocation;
  if (permission !== "explicit_slash") return base;

  const command = parseSlashCommand(text);
  if (command?.kind === "create_skill") {
    if (!allowGlobalAssetMutation) {
      return { ...base, capabilityNotice: skillCapabilityDeniedNotice };
    }
    return {
      ...base,
      message: command.rest || text,
      createSkillMode: true,
    };
  }
  if (command?.kind === "use_skill") {
    if (
      ["install-skill", "install_skill"]
        .includes(command.name.toLowerCase())
      && /^https:\/\/github\.com\//i.test(command.rest)
    ) {
      if (!allowGlobalAssetMutation) {
        return { ...base, capabilityNotice: skillCapabilityDeniedNotice };
      }
      return {
        ...base,
        message: `请安装这个 Skill：${command.rest}`,
        allowSkillInstaller: true,
      };
    }
    const skill = await repositories.skills.findEnabledByName(
      scope,
      command.name,
    );
    if (skill) {
      return {
        ...base,
        message:
          command.rest
          || buildExplicitSkillFallbackMessage(skill.name),
        explicitSkillIds: [skill.id],
      };
    }
    return { ...base, capabilityNotice: skillNotFoundNotice };
  }
  return base;
}

function channelAgentRepositories(
  repositories: Repositories,
  allowSkillCreation: boolean,
  memoryContextKey: string | null,
  matchSkills: SkillMatcher,
): Parameters<typeof runAgent>[0]["repositories"] {
  return {
    memories: memoryContextKey === null
      ? {
          findRelevant: async () => [],
        }
      : {
          findRelevant: (scope, query, signal) =>
            repositories.memories.findRelevantInContext(
              scope,
              memoryContextKey,
              query,
              signal,
            ),
        },
    conversationSummaries: repositories.conversationSummaries,
    reflections: repositories.reflections,
    llmUsage: repositories.llmUsage,
    toolLogs: repositories.toolLogs,
    skills: {
      // IM channels have no slash index panel to browse, so auto-matching is the
      // main path here rather than a fallback (PRD 6.3).
      findEnabled: matchSkills,
      findByIds: repositories.skills.findByIds,
      recordUsage: repositories.skills.recordUsage,
      ...(allowSkillCreation
        ? { create: repositories.skills.create }
        : {}),
    },
  };
}

export function channelContextKey(
  event: Pick<
    NormalizedChannelEvent,
    | "chatType"
    | "connectionId"
    | "externalConversationId"
    | "externalSenderId"
  >,
): string {
  const target = event.chatType === "direct"
    ? event.externalSenderId
    : event.externalConversationId;
  return [
    event.chatType,
    encodeURIComponent(event.connectionId),
    encodeURIComponent(target),
  ].join(":");
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
