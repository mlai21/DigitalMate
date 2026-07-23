import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { defaultArtifactRoot, readArtifactFile } from "@/server/tasks/artifacts";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ artifactId: string }> }) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { artifactId } = await context.params;
  const repositories = createRepositories();
  const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
  const artifact = await repositories.taskArtifacts.get(scope, artifactId);
  if (!artifact) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const buffer = await readArtifactFile(defaultArtifactRoot(), artifact.storage_path);
  const body = new Uint8Array(buffer);
  return new Response(body, {
    headers: {
      "content-type": artifact.mime_type,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.file_name)}`,
      "cache-control": "private, no-store",
    },
  });
}
