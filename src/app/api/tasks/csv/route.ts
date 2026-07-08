import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot, writeArtifactFile } from "@/server/tasks/artifacts";
import { buildSpreadsheetSummaryFiles } from "@/server/tasks/csv";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const repositories = createRepositories();
  const inputSummary = `表格汇总：${file.name}`;
  const taskRunId = await repositories.taskRuns.create({
    userId: user.id,
    kind: "spreadsheet",
    inputSummary,
    metadata: { fileName: file.name, size: file.size },
  });

  try {
    const files = await buildSpreadsheetSummaryFiles({
      fileName: file.name,
      mimeType: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    for (const taskFile of files) {
      const stored = await writeArtifactFile({
        root: defaultArtifactRoot(),
        userId: user.id,
        taskRunId,
        fileName: taskFile.fileName,
        mimeType: taskFile.mimeType,
        buffer: taskFile.buffer,
      });
      await repositories.taskArtifacts.create({ userId: user.id, taskRunId, ...stored });
    }
    await completeTaskWithSkillDraft(repositories, {
      userId: user.id,
      taskRunId,
      kind: "spreadsheet",
      inputSummary,
      outputSummary: "表格汇总报告和图表已生成。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repositories.taskRuns.fail(taskRunId, message);
    await recordEventReflection(repositories, {
      userId: user.id,
      event: "task_failure",
      summary: `${inputSummary} 失败：${message}`,
      source: { taskRunId, taskKind: "spreadsheet" },
    }).catch(() => undefined);
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/tasks"), { status: 303 });
}
