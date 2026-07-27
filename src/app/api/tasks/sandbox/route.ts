import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { runSandboxTask } from "@/server/tasks/sandbox";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";
import { resolveDefaultAgentScope } from "@/server/agents/service";
import { isTaskCompletionAmbiguousError } from "@/server/tasks/completion-errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, (repositories, signal) =>
    processSandboxTask(request, user.id, repositories, signal));
}

async function processSandboxTask(
  request: Request,
  userId: string,
  repositories: ReturnType<typeof createRepositories>,
  signal: AbortSignal,
) {
  const form = await request.formData();
  const script = String(form.get("script") ?? "").trim();
  const image = String(form.get("image") ?? "node:22-alpine").trim() || "node:22-alpine";
  if (!script) {
    return NextResponse.json({ error: "missing_script" }, { status: 400 });
  }

  const scope = await resolveDefaultAgentScope(userId, repositories.agents);
  const inputSummary = `沙箱执行：${script.slice(0, 80)}`;

  const taskRunId = await repositories.taskRuns.create(scope, {
    kind: "sandbox",
    inputSummary,
    metadata: { image },
  });
  const artifactRoot = defaultArtifactRoot();
  const publishedArtifacts: PublishedTaskArtifact[] = [];
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
    publishedArtifacts.push(await publishTaskArtifact({
      scope,
      repositories,
      root: artifactRoot,
      taskRunId,
      file: {
        fileName: "sandbox-output.txt",
        mimeType: "text/plain; charset=utf-8",
        buffer: Buffer.from(output),
      },
    }));
    await completeTaskWithSkillDraft(repositories, {
      scope,
      taskRunId,
      kind: "sandbox",
      inputSummary,
      outputSummary: "沙箱任务已执行，输出文件已生成。",
      artifactIds: publishedArtifacts.map((artifact) => artifact.artifactId),
      signal,
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
      source: { taskRunId, taskKind: "sandbox" },
    }).catch(() => undefined);
  } finally {
    if (workdir) {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  return NextResponse.redirect(
    redirectUrl(request, "/admin-legacy/tasks"),
    { status: 303 },
  );
}
