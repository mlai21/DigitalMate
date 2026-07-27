import { createTaskSkillDraft, type TaskSkillDraftInput } from "@/server/evolution/skills";
import type { AgentScope } from "@/server/agents/types";

type TaskSkillDraftRepositories = {
  taskRuns: {
    completeWithArtifacts(
      scope: AgentScope,
      taskRunId: string,
      outputSummary: string,
      artifactIds: string[],
      signal?: AbortSignal,
    ): Promise<unknown> | unknown;
  };
  skills: {
    create(
      scope: AgentScope,
      draft: ReturnType<typeof createTaskSkillDraft>,
    ): Promise<unknown> | unknown;
  };
};

export async function completeTaskWithSkillDraft(
  repositories: TaskSkillDraftRepositories,
  input: TaskSkillDraftInput & {
    scope: AgentScope;
    taskRunId: string;
    artifactIds: string[];
    signal?: AbortSignal;
  },
): Promise<void> {
  if (input.signal) {
    await repositories.taskRuns.completeWithArtifacts(
      input.scope,
      input.taskRunId,
      input.outputSummary,
      input.artifactIds,
      input.signal,
    );
  } else {
    await repositories.taskRuns.completeWithArtifacts(
      input.scope,
      input.taskRunId,
      input.outputSummary,
      input.artifactIds,
    );
  }

  try {
    await repositories.skills.create(input.scope, createTaskSkillDraft(input));
  } catch {
    return;
  }
}
