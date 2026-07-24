import { NextResponse } from "next/server";
import { z } from "zod";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

export async function GET() {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return withFreshUserDataLease(user.id, async (repositories) => {
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const projects = await repositories.projects.list(scope);
    return NextResponse.json({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        updatedAt: project.updatedAt.toISOString(),
      })),
    });
  });
}

export async function POST(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return withFreshUserDataLease(user.id, async (repositories) => {
    const body = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const project = await repositories.projects.create(scope, body.data);
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
