import { canSendProactiveMessage } from "@/server/agent/reminders";
import { splitAssistantText } from "@/server/agent/streaming";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { DbProactiveTask } from "@/server/db/repositories";
import type { AgentScope } from "@/server/agents/types";

type ProactiveDeliveryRepositories = {
  proactiveTasks: {
    due(scope: AgentScope, now?: Date): Promise<DbProactiveTask[]>;
    countSentToday(scope: AgentScope, now?: Date): Promise<number>;
    unansweredStreak(scope: AgentScope): Promise<number>;
    markSent(scope: AgentScope, taskId: string): Promise<void> | void;
    markCancelled(scope: AgentScope, taskId: string): Promise<void> | void;
    markFailed(scope: AgentScope, taskId: string): Promise<void> | void;
  };
  settings: {
    get(scope: AgentScope): Promise<{
      proactivity: {
        quietStart: string;
        quietEnd: string;
        maxPerDay: number;
      };
    }>;
  };
  messages: {
    createFromProactiveTask(scope: AgentScope, input: {
      taskId: string;
      conversationId: string;
      content: string;
    }): Promise<boolean> | boolean;
  };
  channels: {
    latestDirectTarget(scope: AgentScope): Promise<NormalizedChannelMessage | null>;
  };
};

export async function processDueProactiveTasks(input: {
  scope: AgentScope;
  repositories: ProactiveDeliveryRepositories;
  sendChannel?: (target: NormalizedChannelMessage, text: string) => Promise<unknown> | unknown;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const tasks = await input.repositories.proactiveTasks.due(input.scope, now);

  for (const task of tasks) {
    if (task.kind === "share" && !isAuthorizedShare(task)) {
      await input.repositories.proactiveTasks.markCancelled(input.scope, task.id);
      continue;
    }
    const settings = await input.repositories.settings.get(input.scope);
    const sentToday = await input.repositories.proactiveTasks.countSentToday(input.scope, now);
    const unansweredCount = await input.repositories.proactiveTasks.unansweredStreak(input.scope);
    if (task.kind !== "reminder" && unansweredCount >= 2) continue;

    const canSend = canSendProactiveMessage(now, {
      quietStart: settings.proactivity.quietStart,
      quietEnd: settings.proactivity.quietEnd,
      sentToday,
      maxPerDay: settings.proactivity.maxPerDay,
      allowQuietHours: task.kind === "reminder" && task.metadata.urgent === true,
    });
    if (!canSend) continue;

    const content = proactiveTaskContent(task);
    const inserted = await input.repositories.messages.createFromProactiveTask(input.scope, {
      taskId: task.id,
      conversationId: task.conversationId,
      content,
    });

    if (inserted) {
      const target = await input.repositories.channels.latestDirectTarget(input.scope);
      if (target && input.sendChannel) {
        try {
          for (const segment of splitAssistantText(content)) {
            await input.sendChannel(target, segment);
          }
        } catch {
          await input.repositories.proactiveTasks.markFailed(input.scope, task.id);
          continue;
        }
      }
    }

    await input.repositories.proactiveTasks.markSent(input.scope, task.id);
  }
}

function isAuthorizedShare(task: DbProactiveTask): boolean {
  const authorization = task.metadata.authorization;
  const sourceId = task.metadata.authorizationSourceId;
  return (
    (authorization === "subscription" || authorization === "scheduled_digest") &&
    typeof sourceId === "string" &&
    sourceId.trim().length > 0
  );
}

function proactiveTaskContent(task: DbProactiveTask): string {
  return task.kind === "share" ? task.content : `提醒一下：${task.content}`;
}
