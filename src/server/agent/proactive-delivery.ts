import { canSendProactiveMessage } from "@/server/agent/reminders";
import { splitAssistantText } from "@/server/agent/streaming";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { DbProactiveTask } from "@/server/db/repositories";

type ProactiveDeliveryRepositories = {
  proactiveTasks: {
    due(now?: Date): Promise<DbProactiveTask[]>;
    countSentToday(userId: string, now?: Date): Promise<number>;
    unansweredStreak(userId: string): Promise<number>;
    markSent(taskId: string): Promise<void> | void;
    markCancelled(taskId: string): Promise<void> | void;
    markFailed(taskId: string): Promise<void> | void;
  };
  settings: {
    get(userId: string): Promise<{
      proactivity: {
        quietStart: string;
        quietEnd: string;
        maxPerDay: number;
      };
    }>;
  };
  messages: {
    createFromProactiveTask(input: {
      taskId: string;
      userId: string;
      conversationId: string;
      content: string;
    }): Promise<boolean> | boolean;
  };
  channels: {
    latestDirectTarget(userId: string): Promise<NormalizedChannelMessage | null>;
  };
};

export async function processDueProactiveTasks(input: {
  repositories: ProactiveDeliveryRepositories;
  sendChannel?: (target: NormalizedChannelMessage, text: string) => Promise<unknown> | unknown;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const tasks = await input.repositories.proactiveTasks.due(now);

  for (const task of tasks) {
    if (task.kind === "share" && !isAuthorizedShare(task)) {
      await input.repositories.proactiveTasks.markCancelled(task.id);
      continue;
    }
    const settings = await input.repositories.settings.get(task.userId);
    const sentToday = await input.repositories.proactiveTasks.countSentToday(task.userId, now);
    const unansweredCount = await input.repositories.proactiveTasks.unansweredStreak(task.userId);
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
    const inserted = await input.repositories.messages.createFromProactiveTask({
      taskId: task.id,
      userId: task.userId,
      conversationId: task.conversationId,
      content,
    });

    if (inserted) {
      const target = await input.repositories.channels.latestDirectTarget(task.userId);
      if (target && input.sendChannel) {
        try {
          for (const segment of splitAssistantText(content)) {
            await input.sendChannel(target, segment);
          }
        } catch {
          await input.repositories.proactiveTasks.markFailed(task.id);
          continue;
        }
      }
    }

    await input.repositories.proactiveTasks.markSent(task.id);
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
