import { NextResponse } from "next/server";
import { z } from "zod";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
});

type RouteContext = { params: Promise<{ projectId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return withFreshUserDataLease(user.id, async (repositories) => {
    const { projectId } = await context.params;
    const body = updateSchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const project = await repositories.projects.update(scope, projectId, body.data);
    if (!project) {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        updatedAt: project.updatedAt.toISOString(),
      },
    });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return withFreshUserDataLease(user.id, async (repositories) => {
    const { projectId } = await context.params;
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const project = await repositories.projects.get(scope, projectId);
    if (!project) {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }

    await repositories.projects.delete(scope, projectId);
    return NextResponse.json({ ok: true });
  });
}
