import { buildConversationSummary, shouldCompactConversation } from "@/server/agent/compaction";
import { extractMemoriesWithLlm } from "@/server/agent/memory-extraction";
import { processDueProactiveTasks } from "@/server/agent/proactive-delivery";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { sendChannelMessage } from "@/server/channels/outbound";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { createSkillDraft } from "@/server/evolution/skills";
import { consolidateMemoryKind, MEMORY_CAPACITY_LIMITS } from "@/server/evolution/memory-consolidation";
import { generateReflectionWithLlm, normalizeReflection, shouldRunDailyReflection } from "@/server/evolution/reflection";
import { processSkillImprovement } from "@/server/evolution/skill-improvement";
import { executeGoalStep } from "@/server/goals/executor";
import { processGoalLoops } from "@/server/goals/orchestrator";
import { verifyGoalStep } from "@/server/goals/verifier";
import { getLlmClient } from "@/server/llm/router";

const intervalMs = 15_000;
const skillImprovementIntervalMs = 24 * 60 * 60 * 1000;
let lastSkillImprovementAt = 0;

async function main() {
  const repositories = createRepositories();
  await repositories.users.ensureDefault();
  console.log("DigitalMate agent service started.");

  if (process.env.AGENT_ONCE === "1") {
    await tick(repositories);
    return;
  }

  while (true) {
    await tick(repositories);
    await sleep(intervalMs);
  }
}

async function tick(repositories: ReturnType<typeof createRepositories>) {
  const env = readEnv();
  await processDueProactiveTasks({
    repositories,
    sendChannel: (target, text) => sendChannelMessage(env, target, text),
  });
  await processMemoryMessages(repositories);
  await processMemoryConsolidation(repositories);
  await processConversationCompaction(repositories);
  await processDailyReflection(repositories);
  await processSkillImprovementJob(repositories);
  await processGoalLoopsJob(repositories);
}

async function processGoalLoopsJob(repositories: ReturnType<typeof createRepositories>) {
  const env = readEnv();
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const main = getLlmClient("main", env, settings.modelRouting);
  const light = getLlmClient("light", env, settings.modelRouting);

  const outcome = await processGoalLoops({
    repositories,
    services: {
      executeStep: async (goal, recentSteps) => {
        const candidate = await executeGoalStep({
          goal,
          recentSteps,
          llm: main.client,
          model: main.model,
          search: {
            run: async (query) => {
              const results = await searchWeb(query);
              return { summary: summarizeSearchResults(results) };
            },
          },
          memories: repositories.memories,
          toolLogs: repositories.toolLogs,
        });
        await repositories.llmUsage
          .create({
            userId: goal.userId,
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
        const verify = await verifyGoalStep({ goal, candidate, priorEvidence, llm: light.client, model: light.model });
        await repositories.llmUsage
          .create({
            userId: goal.userId,
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
  }).catch(() => null);

  if (outcome && (outcome.pickedUp > 0 || outcome.rounds > 0)) {
    console.log(
      `Goal loops: picked up ${outcome.pickedUp}, ran ${outcome.rounds} round(s), succeeded ${outcome.succeeded}, stopped ${outcome.stopped}.`,
    );
  }
}

async function processSkillImprovementJob(repositories: ReturnType<typeof createRepositories>) {
  // At most once a day: revision proposals ride the same slow cadence as the
  // daily reflection instead of the 15s tick.
  if (Date.now() - lastSkillImprovementAt < skillImprovementIntervalMs) return;
  lastSkillImprovementAt = Date.now();

  const env = readEnv();
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  const outcome = await processSkillImprovement({
    repositories,
    llm: client,
    model,
    userId: user.id,
  }).catch(() => null);
  if (outcome && outcome.proposed > 0) {
    console.log(`Skill improvement: proposed ${outcome.proposed} pending revision(s).`);
  }
}

async function processMemoryMessages(repositories: ReturnType<typeof createRepositories>) {
  const messages = await repositories.messages.unprocessedForMemory();
  if (messages.length === 0) return;

  const env = readEnv();
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  for (const message of messages) {
    const memories = await extractMemoriesWithLlm({ llm: client, model, text: message.content });
    await repositories.memories.createMany(message.userId, message.id, memories);
  }
  await repositories.messages.markMemoryProcessed(messages.map((message) => message.id));
}

async function processMemoryConsolidation(repositories: ReturnType<typeof createRepositories>) {
  const env = readEnv();
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);

  for (const kind of Object.keys(MEMORY_CAPACITY_LIMITS) as Array<keyof typeof MEMORY_CAPACITY_LIMITS>) {
    const outcome = await consolidateMemoryKind({
      repositories,
      llm: client,
      model,
      userId: user.id,
      kind,
    }).catch(() => null);
    if (outcome) {
      console.log(
        `Memory consolidation (${outcome.kind}): ${outcome.strategy}, removed ${outcome.removedCount}, merged into ${outcome.mergedCount}.`,
      );
    }
  }
}

async function processConversationCompaction(repositories: ReturnType<typeof createRepositories>) {
  const user = await repositories.users.ensureDefault();
  const conversations = await repositories.conversations.list(user.id);
  for (const conversation of conversations) {
    const existing = await repositories.conversationSummaries.latest(conversation.id);
    if (existing) continue;

    const messages = await repositories.messages.list(conversation.id);
    if (!shouldCompactConversation(messages, { threshold: 40 })) continue;

    const summary = buildConversationSummary(messages, { keepRecent: 12 });
    await repositories.conversationSummaries.create({
      userId: user.id,
      conversationId: conversation.id,
      summary: summary.text,
      messageCount: summary.messageCount,
    });
  }
}

async function processDailyReflection(repositories: ReturnType<typeof createRepositories>) {
  const user = await repositories.users.ensureDefault();
  const latest = await repositories.reflections.latestBySourceEvent(user.id, "daily");
  if (!shouldRunDailyReflection(new Date(), latest)) return;
  const conversations = await repositories.conversations.list(user.id);
  const conversation = conversations[0];
  if (!conversation) return;
  const messages = await repositories.messages.list(conversation.id);
  if (messages.length === 0) return;

  const digest = messages
    .slice(-40)
    .map((message) => (message.role === "user" ? "用户" : "助手") + `：${message.content.slice(0, 200)}`)
    .join("\n");
  const env = readEnv();
  const settings = await repositories.settings.get(user.id);
  const { client, model } = getLlmClient("light", env, settings.modelRouting);
  const generated = await generateReflectionWithLlm({ llm: client, model, digest });
  const reflection =
    generated ??
    normalizeReflection("做得好：保持了稳定陪伴。需要改进：反思模型暂不可用，本次为降级记录。建议：检查 light 模型配置。");
  await repositories.reflections.create({
    userId: user.id,
    reflection: { positives: reflection.positives, negatives: reflection.negatives, suggestions: reflection.suggestions },
    sourceWindow: { event: "daily", conversationId: conversation.id, messageCount: messages.length },
  });

  // Daily reflection may surface a recurring task pattern worth crystallizing
  // into a new skill draft (pending user approval, like every other draft).
  if (generated?.skill) {
    await repositories.skills
      .create(
        user.id,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
