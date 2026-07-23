import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { recordEventReflection } from "@/server/evolution/event-reflection";
import { redirectUrl } from "@/server/http/redirect";
import {
  createArtifactFileLocator,
  defaultArtifactRoot,
  writeArtifactFile,
} from "@/server/tasks/artifacts";
import { runSandboxTask } from "@/server/tasks/sandbox";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";
import { resolveDefaultAgentScope } from "@/server/agents/service";

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
  const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
  const inputSummary = `沙箱执行：${script.slice(0, 80)}`;
  const releaseMutationLock = await repositories.userDataMutations.acquireLock(user.id);

  try {
    const taskRunId = await repositories.taskRuns.create(scope, {
      kind: "sandbox",
      inputSummary,
      metadata: { image },
    });
    let workdir: string | undefined;
    try {
      workdir = await mkdtemp(path.join(os.tmpdir(), "digitalmate-sandbox-"));
      const result = await runSandboxTask({
        image,
        workdir,
        script,
        memoryMb: 256,
        cpus: 1,
        network: false,
      });
      const output = [`stdout:\n${result.stdout || "(empty)"}`, `stderr:\n${result.stderr || "(empty)"}`].join("\n\n");
      const stored = createArtifactFileLocator({
        userId: user.id,
        taskRunId,
        fileName: "sandbox-output.txt",
        mimeType: "text/plain; charset=utf-8",
      });
      await repositories.taskArtifacts.create(scope, { taskRunId, ...stored });
      await writeArtifactFile({
        root: defaultArtifactRoot(),
        userId: user.id,
        taskRunId,
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        buffer: Buffer.from(output),
      });
      await completeTaskWithSkillDraft(repositories, {
        scope,
        taskRunId,
        kind: "sandbox",
        inputSummary,
        outputSummary: "沙箱任务已执行，输出文件已生成。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repositories.taskRuns.fail(scope, taskRunId, message);
      await recordEventReflection(repositories, {
        scope,
        event: "task_failure",
        summary: `${inputSummary} 失败：${message}`,
        source: { taskRunId, taskKind: "sandbox" },
      }).catch(() => undefined);
    } finally {
      if (workdir) {
        await rm(workdir, { recursive: true, force: true });
      }
    }
  } finally {
    await releaseMutationLock();
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/tasks"), { status: 303 });
}
