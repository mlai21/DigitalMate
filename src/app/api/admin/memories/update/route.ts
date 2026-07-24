import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";
import type { MemoryKind } from "@/server/agent/memory";
import { resolveDefaultAgentScope } from "@/server/agents/service";

const memoryKinds = new Set<MemoryKind>(["episodic", "profile", "agent_self"]);

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories, signal) => {
    const form = await request.formData();
    const memoryId = String(form.get("memoryId") ?? "");
    const kind = String(form.get("kind") ?? "profile") as MemoryKind;
    const content = String(form.get("content") ?? "");
    const confidence = Number(form.get("confidence") ?? 0.7);
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);

    if (memoryId && memoryKinds.has(kind) && content.trim()) {
      await repositories.memories.update(scope, memoryId, {
        kind,
        content,
        confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7,
      }, signal);
    }

    return NextResponse.redirect(redirectUrl(request, "/admin/memories"), { status: 303 });
  });
}
