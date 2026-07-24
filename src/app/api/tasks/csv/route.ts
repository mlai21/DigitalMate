import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import type { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot } from "@/server/tasks/artifacts";
import {
  discardPublishedTaskArtifacts,
  publishTaskArtifact,
  type PublishedTaskArtifact,
} from "@/server/tasks/artifact-publisher";
import { buildSpreadsheetSummaryFiles } from "@/server/tasks/csv";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, (repositories) =>
    processSpreadsheetTask(request, user.id, repositories));
}

async function processSpreadsheetTask(
  request: Request,
  userId: string,
  repositories: ReturnType<typeof createRepositories>,
) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const scope = await resolveDefaultAgentScope(userId, repositories.agents);
  const inputSummary = `表格汇总：${file.name}`;

  const taskRunId = await repositories.taskRuns.create(scope, {
    kind: "spreadsheet",
    inputSummary,
    metadata: { fileName: file.name, size: file.size },
  });
  const artifactRoot = defaultArtifactRoot();
  const publishedArtifacts: PublishedTaskArtifact[] = [];
  try {
    const files = await buildSpreadsheetSummaryFiles({
      fileName: file.name,
      mimeType: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    for (const taskFile of files) {
      publishedArtifacts.push(await publishTaskArtifact({
        scope,
        repositories,
        root: artifactRoot,
        taskRunId,
        file: taskFile,
      }));
    }
    await completeTaskWithSkillDraft(repositories, {
      scope,
      taskRunId,
      kind: "spreadsheet",
      inputSummary,
      outputSummary: "表格汇总报告和图表已生成。",
      artifactIds: publishedArtifacts.map((artifact) => artifact.artifactId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await discardPublishedTaskArtifacts({
      scope,
      repositories,
      root: artifactRoot,
      artifacts: publishedArtifacts,
    });
    await repositories.taskRuns.fail(scope, taskRunId, message);
    await recordEventReflection(repositories, {
      scope,
      event: "task_failure",
      summary: `${inputSummary} 失败：${message}`,
      source: { taskRunId, taskKind: "spreadsheet" },
    }).catch(() => undefined);
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/tasks"), { status: 303 });
}
