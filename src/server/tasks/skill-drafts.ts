import { createTaskSkillDraft, type TaskSkillDraftInput } from "@/server/evolution/skills";
import type { AgentScope } from "@/server/agents/types";

type TaskSkillDraftRepositories = {
  taskRuns: {
    complete(scope: AgentScope, taskRunId: string, outputSummary: string): Promise<unknown> | unknown;
  };
  skills: {
    create(userId: string, draft: ReturnType<typeof createTaskSkillDraft>): Promise<unknown> | unknown;
  };
};

export async function completeTaskWithSkillDraft(
  repositories: TaskSkillDraftRepositories,
  input: TaskSkillDraftInput & {
    scope: AgentScope;
    taskRunId: string;
  },
): Promise<void> {
  await repositories.taskRuns.complete(input.scope, input.taskRunId, input.outputSummary);

  try {
    await repositories.skills.create(input.scope.userId, createTaskSkillDraft(input));
  } catch {
    return;
  }
}
