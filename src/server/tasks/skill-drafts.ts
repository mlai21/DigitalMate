import { createTaskSkillDraft, type TaskSkillDraftInput } from "@/server/evolution/skills";

type TaskSkillDraftRepositories = {
  taskRuns: {
    complete(taskRunId: string, outputSummary: string): Promise<unknown> | unknown;
  };
  skills: {
    create(userId: string, draft: ReturnType<typeof createTaskSkillDraft>): Promise<unknown> | unknown;
  };
};

export async function completeTaskWithSkillDraft(
  repositories: TaskSkillDraftRepositories,
  input: TaskSkillDraftInput & {
    userId: string;
    taskRunId: string;
  },
): Promise<void> {
  await repositories.taskRuns.complete(input.taskRunId, input.outputSummary);

  try {
    await repositories.skills.create(input.userId, createTaskSkillDraft(input));
  } catch {
    return;
  }
}
