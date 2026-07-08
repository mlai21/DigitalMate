import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import type { MemoryKind } from "@/server/agent/memory";

const memoryKinds = new Set<MemoryKind>(["episodic", "profile", "agent_self"]);

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const memoryId = String(form.get("memoryId") ?? "");
  const kind = String(form.get("kind") ?? "profile") as MemoryKind;
  const content = String(form.get("content") ?? "");
  const confidence = Number(form.get("confidence") ?? 0.7);

  if (memoryId && memoryKinds.has(kind) && content.trim()) {
    await createRepositories().memories.update(user.id, memoryId, {
      kind,
      content,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7,
    });
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/memories"), { status: 303 });
}
