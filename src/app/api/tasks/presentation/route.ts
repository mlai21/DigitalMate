import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot, writeArtifactFile } from "@/server/tasks/artifacts";
import { summarizeSpreadsheetFile } from "@/server/tasks/csv";
import { buildPresentation, parsePresentationOutline } from "@/server/tasks/presentation";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const title = String(form.get("title") ?? "DigitalMate 汇报");
  const outline = String(form.get("outline") ?? "");
  const dataFile = form.get("file");
  const slides = parsePresentationOutline(outline);
  if (slides.length === 0) {
    return NextResponse.json({ error: "missing_outline" }, { status: 400 });
  }

  const repositories = createRepositories();
  const inputSummary = `PPT 生成：${title}`;
  const taskRunId = await repositories.taskRuns.create({
    userId: user.id,
    kind: "presentation",
    inputSummary,
    metadata: {
      slideCount: slides.length,
      ...(isUploadedFile(dataFile) ? { dataFileName: dataFile.name, dataFileSize: dataFile.size } : {}),
    },
  });

  try {
    const dataSummary = isUploadedFile(dataFile)
      ? await summarizeSpreadsheetFile({
          fileName: dataFile.name,
          mimeType: dataFile.type,
          buffer: Buffer.from(await dataFile.arrayBuffer()),
        })
      : undefined;
    const pptx = await buildPresentation({ title, slides, dataSummary });
    const stored = await writeArtifactFile({
      root: defaultArtifactRoot(),
      userId: user.id,
      taskRunId,
      fileName: pptx.fileName,
      mimeType: pptx.mimeType,
      buffer: pptx.buffer,
    });
    await repositories.taskArtifacts.create({ userId: user.id, taskRunId, ...stored });
    await completeTaskWithSkillDraft(repositories, {
      userId: user.id,
      taskRunId,
      kind: "presentation",
      inputSummary,
      outputSummary: "PPT 文件已生成。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repositories.taskRuns.fail(taskRunId, message);
    await recordEventReflection(repositories, {
      userId: user.id,
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
