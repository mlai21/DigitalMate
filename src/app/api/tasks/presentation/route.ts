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
import { summarizeSpreadsheetFile } from "@/server/tasks/csv";
import { buildPresentation, parsePresentationOutline } from "@/server/tasks/presentation";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";
import { resolveDefaultAgentScope } from "@/server/agents/service";
import { isTaskCompletionAmbiguousError } from "@/server/tasks/completion-errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, (repositories) =>
    processPresentationTask(request, user.id, repositories));
}

async function processPresentationTask(
  request: Request,
  userId: string,
  repositories: ReturnType<typeof createRepositories>,
) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "DigitalMate 汇报");
  const outline = String(form.get("outline") ?? "");
  const dataFile = form.get("file");
  const slides = parsePresentationOutline(outline);
  if (slides.length === 0) {
    return NextResponse.json({ error: "missing_outline" }, { status: 400 });
  }

  const scope = await resolveDefaultAgentScope(userId, repositories.agents);
  const inputSummary = `PPT 生成：${title}`;

  const taskRunId = await repositories.taskRuns.create(scope, {
    kind: "presentation",
    inputSummary,
    metadata: {
      slideCount: slides.length,
      ...(isUploadedFile(dataFile) ? { dataFileName: dataFile.name, dataFileSize: dataFile.size } : {}),
    },
  });
  const artifactRoot = defaultArtifactRoot();
  const publishedArtifacts: PublishedTaskArtifact[] = [];
  try {
    const dataSummary = isUploadedFile(dataFile)
      ? await summarizeSpreadsheetFile({
          fileName: dataFile.name,
          mimeType: dataFile.type,
          buffer: Buffer.from(await dataFile.arrayBuffer()),
        })
      : undefined;
    const pptx = await buildPresentation({ title, slides, dataSummary });
    publishedArtifacts.push(await publishTaskArtifact({
      scope,
      repositories,
      root: artifactRoot,
      taskRunId,
      file: pptx,
    }));
    await completeTaskWithSkillDraft(repositories, {
      scope,
      taskRunId,
      kind: "presentation",
      inputSummary,
      outputSummary: "PPT 文件已生成。",
      artifactIds: publishedArtifacts.map((artifact) => artifact.artifactId),
    });
  } catch (error) {
    if (isTaskCompletionAmbiguousError(error)) {
      return NextResponse.json(
        { error: "task_completion_ambiguous" },
        { status: 500 },
      );
    }
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
      source: { taskRunId, taskKind: "presentation" },
    }).catch(() => undefined);
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/tasks"), { status: 303 });
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0 && value.name.trim() !== "";
}
