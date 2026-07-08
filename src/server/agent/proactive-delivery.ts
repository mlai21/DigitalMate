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
    create(input: {
      userId: string;
      conversationId: string;
      role: "assistant";
      content: string;
    }): Promise<unknown> | unknown;
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
    await input.repositories.messages.create({
      userId: task.userId,
      conversationId: task.conversationId,
      role: "assistant",
      content,
    });

    const target = await input.repositories.channels.latestDirectTarget(task.userId);
    if (target && input.sendChannel) {
      for (const segment of splitAssistantText(content)) {
        await input.sendChannel(target, segment);
      }
    }

    await input.repositories.proactiveTasks.markSent(task.id);
  }
}

function proactiveTaskContent(task: DbProactiveTask): string {
  return task.kind === "share" ? task.content : `提醒一下：${task.content}`;
}
