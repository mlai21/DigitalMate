import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot, writeArtifactFile } from "@/server/tasks/artifacts";
import { runSandboxTask } from "@/server/tasks/sandbox";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const script = String(form.get("script") ?? "").trim();
  const image = String(form.get("image") ?? "node:22-alpine").trim() || "node:22-alpine";
  if (!script) {
    return NextResponse.json({ error: "missing_script" }, { status: 400 });
  }

  const repositories = createRepositories();
  const inputSummary = `沙箱执行：${script.slice(0, 80)}`;
  const taskRunId = await repositories.taskRuns.create({
    userId: user.id,
    kind: "sandbox",
    inputSummary,
    metadata: { image },
  });
  const workdir = await mkdtemp(path.join(os.tmpdir(), "digitalmate-sandbox-"));

  try {
    const result = await runSandboxTask({
      image,
      workdir,
      script,
      memoryMb: 256,
      cpus: 1,
      network: false,
    });
    const output = [`stdout:\n${result.stdout || "(empty)"}`, `stderr:\n${result.stderr || "(empty)"}`].join("\n\n");
    const stored = await writeArtifactFile({
      root: defaultArtifactRoot(),
      userId: user.id,
      taskRunId,
      fileName: "sandbox-output.txt",
      mimeType: "text/plain; charset=utf-8",
      buffer: Buffer.from(output),
    });
    await repositories.taskArtifacts.create({ userId: user.id, taskRunId, ...stored });
    await completeTaskWithSkillDraft(repositories, {
      userId: user.id,
      taskRunId,
      kind: "sandbox",
      inputSummary,
      outputSummary: "沙箱任务已执行，输出文件已生成。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repositories.taskRuns.fail(taskRunId, message);
    await recordEventReflection(repositories, {
      userId: user.id,
      event: "task_failure",
      summary: `${inputSummary} 失败：${message}`,
      source: { taskRunId, taskKind: "sandbox" },
    }).catch(() => undefined);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/tasks"), { status: 303 });
}
