import { buildConversationSummary, shouldCompactConversation } from "@/server/agent/compaction";
import { extractMemoriesWithLlm } from "@/server/agent/memory-extraction";
import { processDueProactiveTasks } from "@/server/agent/proactive-delivery";
import { buildProactiveShareContent, shouldCreateProactiveShare } from "@/server/agent/proactive-share";
import { searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import { sendChannelMessage } from "@/server/channels/outbound";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { consolidateMemoryKind, MEMORY_CAPACITY_LIMITS } from "@/server/evolution/memory-consolidation";
import { generateReflectionWithLlm, normalizeReflection, shouldRunDailyReflection } from "@/server/evolution/reflection";
import { getLlmClient } from "@/server/llm/router";

const intervalMs = 15_000;

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
  await processProactiveShares(repositories);
}

async function processProactiveShares(repositories: ReturnType<typeof createRepositories>) {
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const sentToday = await repositories.proactiveTasks.countSentToday(user.id);
  const latestShareAt = await repositories.proactiveTasks.latestByKind(user.id, "share");
  const unansweredCount = await repositories.proactiveTasks.unansweredStreak(user.id);
  const now = new Date();
  if (unansweredCount >= 2) {
    await recordEventReflection(repositories, {
      userId: user.id,
      event: "proactive_ignored",
      summary: `主动消息连续 ${unansweredCount} 次没有收到用户回应。`,
      source: { unansweredCount },
      dedupeByEvent: true,
      now,
    }).catch(() => undefined);
  }
  const shouldShare = shouldCreateProactiveShare({
    now,
    latestShareAt,
    quietStart: settings.proactivity.quietStart,
    quietEnd: settings.proactivity.quietEnd,
    sentToday,
    maxPerDay: settings.proactivity.maxPerDay,
    unansweredCount,
  });
  if (!shouldShare) return;

  const memories = await repositories.memories.list(user.id);
  const memory = memories.find((item) => item.kind === "profile") ?? memories[0];
  if (!memory) return;

  const conversations = await repositories.conversations.list(user.id);
  const conversation = conversations[0] ?? (await repositories.conversations.getOrCreateDefault(user.id));

  try {
    const results = await searchWeb(`和这个偏好相关的最新信息：${memory.content}`);
    const content = buildProactiveShareContent({
      memory: memory.content,
      searchSummary: summarizeSearchResults(results),
    });
    await repositories.proactiveTasks.create({
      userId: user.id,
      conversationId: conversation.id,
      kind: "share",
      content,
      scheduledAt: now,
    });
  } catch {
    return;
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
  const reflection =
    (await generateReflectionWithLlm({ llm: client, model, digest })) ??
    normalizeReflection("做得好：保持了稳定陪伴。需要改进：反思模型暂不可用，本次为降级记录。建议：检查 light 模型配置。");
  await repositories.reflections.create({
    userId: user.id,
    reflection,
    sourceWindow: { event: "daily", conversationId: conversation.id, messageCount: messages.length },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
