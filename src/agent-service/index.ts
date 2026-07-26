import { pathToFileURL } from "node:url";
import { createActiveAgentTickRunner } from "@/agent-service/active-agent-tick";
import {
  startAgentChannelGateway,
} from "@/agent-service/channel-gateway";
import { withUserDataLease } from "@/server/admin/user-data-lease";
import { buildConversationSummary, shouldCompactConversation } from "@/server/agent/compaction";
import { extractMemoriesWithLlm } from "@/server/agent/memory-extraction";
import { processDueProactiveTasks } from "@/server/agent/proactive-delivery";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import {
  runAttachmentCleanupRound,
  startAttachmentCleanupScheduler,
} from "@/server/attachments/cleanup";
import {
  enqueueProactiveChannelDelivery,
  startChannelRuntime,
} from "@/server/channels/runtime/start";
import { readEnv } from "@/server/config/env";
import { closePool, getPool } from "@/server/db/client";
import { createRepositories } from "@/server/db/repositories";
import {
  createChannelNodeRuntimeBridge,
} from "@/server/channels/nodes/runtime-bridge";
import { createSkillDraft } from "@/server/evolution/skills";
import { consolidateMemoryKind, MEMORY_CAPACITY_LIMITS } from "@/server/evolution/memory-consolidation";
import { generateReflectionWithLlm, normalizeReflection, shouldRunDailyReflection } from "@/server/evolution/reflection";
import { processSkillImprovement } from "@/server/evolution/skill-improvement";
import { executeGoalStep } from "@/server/goals/executor";
import { processGoalLoops } from "@/server/goals/orchestrator";
import { verifyGoalStep } from "@/server/goals/verifier";
import { getLlmClient } from "@/server/llm/router";
import { cleanupStaleTaskArtifacts } from "@/server/tasks/artifact-cleanup";
import { defaultArtifactRoot } from "@/server/tasks/artifacts";
import type { AgentScope } from "@/server/agents/types";
import { assertAuthorizedModelRoutes } from "@/server/agents/service";

const intervalMs = 15_000;
const skillImprovementIntervalMs = 24 * 60 * 60 * 1000;
export const AGENT_TICK_TIMEOUT_MS = 120_000;
const lastSkillImprovementAt = new Map<string, number>();

async function main() {
  const pool = getPool();
  const repositories = createRepositories(pool);
  const user = await repositories.users.ensureDefault();
  await withUserDataLease(repositories, user.id, async () => {
    const defaultAgent = await repositories.agents.ensureDefault(user.id);
    await repositories.agentSettings.ensure({ userId: user.id, agentId: defaultAgent.id });
  });

  const env = readEnv();
  const channelNodes = createChannelNodeRuntimeBridge({
    pool,
    repositories,
    secretKey: env.channelSecretsKey.status === "ready"
      ? env.channelSecretsKey.key
      : null,
    attachmentStorageDir: env.attachmentStorageDir,
  });
  const cleanupScheduler = startAttachmentCleanupScheduler({
    run: async () => {
      const agents = await repositories.agents.listActive();
      await runAttachmentCleanupRound({
        scopes: agents.map((agent) => ({ userId: agent.userId, agentId: agent.id })),
        repositories,
        storageDirectory: env.attachmentStorageDir,
        withScope: (scope, work) => withUserDataLease(repositories, scope.userId, async () => {
          const attachmentResult = await work();
          await cleanupStaleTaskArtifacts({
            scope,
            repositories,
            root: defaultArtifactRoot(),
          });
          return attachmentResult;
        }),
      });
    },
  });
  const shutdown = new AbortController();
  const channelRuntime = await startChannelRuntime({
    repositories,
    env,
    pool,
    channelNodes,
  });
  let channelGateway:
    | Awaited<ReturnType<typeof startAgentChannelGateway>>
    | undefined;
  try {
    channelGateway = await startAgentChannelGateway({
      env,
      channelNodes,
    });
  } catch (error) {
    await stopAgentServiceResources({
      channelRuntime,
      cleanupScheduler,
      closeDatabase: closePool,
    });
    throw error;
  }
  const runActiveAgentTick = createActiveAgentTickRunner({
    listActiveAgents: () => repositories.agents.listActive(),
    execute: (scope) => runAgentTickUnderLease(repositories, scope),
    onError: (error, scope) => {
      console.error("agent_tick_failed", {
        userId: scope.userId,
        agentId: scope.agentId,
        errorType: error instanceof Error ? "Error" : "NonError",
      });
    },
  });
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  console.log("DigitalMate agent service started.");

  try {
    await cleanupScheduler.initialRun;
    if (process.env.AGENT_ONCE === "1") {
      await runActiveAgentTick();
      return;
    }

    while (!shutdown.signal.aborted) {
      await runActiveAgentTick();
      await sleep(intervalMs, shutdown.signal);
    }
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    await stopAgentServiceResources({
      channelGateway,
      channelRuntime,
      cleanupScheduler,
      closeDatabase: closePool,
    });
  }
}

export async function stopAgentServiceResources(input: Readonly<{
  channelGateway?: Readonly<{ stop(): Promise<void> }>;
  channelRuntime: Readonly<{ stop(): Promise<void> }>;
  cleanupScheduler: Readonly<{ stop(): Promise<void> }>;
  closeDatabase(): Promise<void>;
}>): Promise<void> {
  try {
    await input.channelGateway?.stop();
  } finally {
    try {
      await input.channelRuntime.stop();
    } finally {
      try {
        await input.cleanupScheduler.stop();
      } finally {
        await input.closeDatabase();
      }
    }
  }
}

export async function runAgentTickUnderLease(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  await withUserDataLease(
    repositories,
    scope.userId,
    (_lease, signal) => processAgentTick(repositories, scope, signal),
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? AGENT_TICK_TIMEOUT_MS,
      timeoutCode: "agent_tick_timeout",
    },
  );
}

async function processAgentTick(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await processDueProactiveTasks({
    scope,
    repositories,
    signal,
    enqueueChannel: (delivery) =>
      enqueueProactiveChannelDelivery({
        repositories,
        ...delivery,
      }),
  });
  signal.throwIfAborted();
  await processMemoryMessages(repositories, scope, signal);
  signal.throwIfAborted();
  await processMemoryConsolidation(repositories, scope, signal);
  signal.throwIfAborted();
  await processConversationCompaction(repositories, scope, signal);
  signal.throwIfAborted();
  await processDailyReflection(repositories, scope, signal);
  signal.throwIfAborted();
  await processSkillImprovementJob(repositories, scope, signal);
  signal.throwIfAborted();
  await processGoalLoopsJob(repositories, scope, signal);
  signal.throwIfAborted();
}

async function processGoalLoopsJob(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const env = readEnv();
  const settings = await repositories.settings.get(scope);
  await assertAuthorizedModelRoutes(
    scope,
    ["main", "light"],
    settings.modelRouting,
    repositories.agents,
  );
  const main = getLlmClient("main", env, settings.modelRouting);
  const light = getLlmClient("light", env, settings.modelRouting);

  const outcome = await processGoalLoops({
    scope,
    repositories,
    services: {
      executeStep: async (goal, recentSteps) => {
        const candidate = await executeGoalStep({
          goal,
          recentSteps,
          llm: main.client,
          model: main.model,
          signal,
          search: {
            run: async (query, searchSignal) => {
              const results = await searchWeb(query, env, searchSignal);
              return { summary: summarizeSearchResults(results) };
            },
          },
          memories: repositories.memories,
          toolLogs: repositories.toolLogs,
        });
        await repositories.llmUsage
          .create({
            userId: goal.userId,
            agentId: goal.agentId,
            conversationId: goal.conversationId,
            purpose: "main",
            model: main.model,
            inputTokens: candidate.tokensUsed,
            outputTokens: 0,
            totalTokens: candidate.tokensUsed,
          })
          .catch(() => undefined);
        return candidate;
      },
      verifyStep: async (goal, candidate, priorEvidence) => {
        const verify = await verifyGoalStep({
          goal,
          candidate,
          priorEvidence,
          llm: light.client,
          model: light.model,
          signal,
        });
        await repositories.llmUsage
          .create({
            userId: goal.userId,
            agentId: goal.agentId,
            conversationId: goal.conversationId,
            purpose: "light",
            model: light.model,
            inputTokens: verify.tokensUsed,
            outputTokens: 0,
            totalTokens: verify.tokensUsed,
          })
          .catch(() => undefined);
        return verify;
      },
    },
    signal,
  }).catch(() => {
    signal.throwIfAborted();
    return null;
  });

  if (outcome && (outcome.pickedUp > 0 || outcome.rounds > 0)) {
    console.log(
      `Goal loops: picked up ${outcome.pickedUp}, ran ${outcome.rounds} round(s), succeeded ${outcome.succeeded}, stopped ${outcome.stopped}.`,
    );
  }
}

async function processSkillImprovementJob(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // At most once a day: revision proposals ride the same slow cadence as the
  // daily reflection instead of the 15s tick.
  if (Date.now() - (lastSkillImprovementAt.get(scope.agentId) ?? 0) < skillImprovementIntervalMs) return;
  lastSkillImprovementAt.set(scope.agentId, Date.now());

  const env = readEnv();
  const settings = await repositories.settings.get(scope);
  await assertAuthorizedModelRoutes(scope, ["light"], settings.modelRouting, repositories.agents);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  const outcome = await processSkillImprovement({
    repositories,
    llm: client,
    model,
    scope,
    signal,
  }).catch(() => {
    signal.throwIfAborted();
    return null;
  });
  if (outcome && outcome.proposed > 0) {
    console.log(`Skill improvement: proposed ${outcome.proposed} pending revision(s).`);
  }
}

async function processMemoryMessages(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const messages = await repositories.messages.unprocessedForMemory(scope);
  if (messages.length === 0) return;

  const env = readEnv();
  const settings = await repositories.settings.get(scope);
  await assertAuthorizedModelRoutes(scope, ["light"], settings.modelRouting, repositories.agents);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  for (const message of messages) {
    signal.throwIfAborted();
    const memories = await extractMemoriesWithLlm({
      llm: client,
      model,
      text: message.content,
      signal,
    });
    signal.throwIfAborted();
    await repositories.memories.createMany(scope, message.id, memories, signal);
  }
  signal.throwIfAborted();
  await repositories.messages.markMemoryProcessed(scope, messages.map((message) => message.id));
}

async function processMemoryConsolidation(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const env = readEnv();
  const settings = await repositories.settings.get(scope);
  await assertAuthorizedModelRoutes(scope, ["light"], settings.modelRouting, repositories.agents);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  for (const kind of Object.keys(MEMORY_CAPACITY_LIMITS) as Array<keyof typeof MEMORY_CAPACITY_LIMITS>) {
    const outcome = await consolidateMemoryKind({
      repositories,
      llm: client,
      model,
      scope,
      kind,
      signal,
    }).catch(() => {
      signal.throwIfAborted();
      return null;
    });
    if (outcome) {
      console.log(
        `Memory consolidation (${outcome.kind}): ${outcome.strategy}, removed ${outcome.removedCount}, merged into ${outcome.mergedCount}.`,
      );
    }
  }
}

async function processConversationCompaction(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const conversations = await repositories.conversations.list(scope);
  for (const conversation of conversations) {
    signal.throwIfAborted();
    const existing = await repositories.conversationSummaries.latest(scope, conversation.id);
    if (existing) continue;

    const messages = await repositories.messages.list(scope, conversation.id);
    if (!shouldCompactConversation(messages, { threshold: 40 })) continue;

    const summary = buildConversationSummary(messages, { keepRecent: 12 });
    await repositories.conversationSummaries.create(scope, {
      conversationId: conversation.id,
      summary: summary.text,
      messageCount: summary.messageCount,
    });
  }
}

async function processDailyReflection(
  repositories: ReturnType<typeof createRepositories>,
  scope: AgentScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const latest = await repositories.reflections.latestBySourceEvent(scope, "daily");
  if (!shouldRunDailyReflection(new Date(), latest)) return;
  const conversations = await repositories.conversations.list(scope);
  const conversation = conversations[0];
  if (!conversation) return;
  const messages = await repositories.messages.list(scope, conversation.id);
  if (messages.length === 0) return;

  const digest = messages
    .slice(-40)
    .map((message) => (message.role === "user" ? "用户" : "助手") + `：${message.content.slice(0, 200)}`)
    .join("\n");
  const env = readEnv();
  const settings = await repositories.settings.get(scope);
  await assertAuthorizedModelRoutes(scope, ["light"], settings.modelRouting, repositories.agents);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);
  const generated = await generateReflectionWithLlm({
    llm: client,
    model,
    digest,
    signal,
  });
  signal.throwIfAborted();
  const reflection =
    generated ??
    normalizeReflection("做得好：保持了稳定陪伴。需要改进：反思模型暂不可用，本次为降级记录。建议：检查 light 模型配置。");
  await repositories.reflections.create(scope, {
    reflection: { positives: reflection.positives, negatives: reflection.negatives, suggestions: reflection.suggestions },
    sourceWindow: { event: "daily", conversationId: conversation.id, messageCount: messages.length },
  });
  signal.throwIfAborted();

  // Daily reflection may surface a recurring task pattern worth crystallizing
  // into a new skill draft (pending user approval, like every other draft).
  if (generated?.skill) {
    await repositories.skills
      .create(
        scope.userId,
        createSkillDraft({
          name: generated.skill.name,
          trigger: generated.skill.trigger,
          steps: generated.skill.steps,
          source: "agent",
        }),
      )
      .catch(() => undefined);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
  });
}

export function isDirectAgentServiceEntry(
  metaUrl = import.meta.url,
  entryPath = process.argv[1],
): boolean {
  return Boolean(entryPath) && metaUrl === pathToFileURL(entryPath).href;
}

if (isDirectAgentServiceEntry()) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
