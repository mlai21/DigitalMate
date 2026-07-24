import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";
import { createToolRegistrationDraft } from "@/server/tasks/tools";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const command = String(form.get("command") ?? "").trim();
    const kind = String(form.get("kind") ?? "script") === "mcp" ? "mcp" : "script";
    const mcpToolName = String(form.get("mcpToolName") ?? "").trim();

    if (name && description && command) {
      await repositories.toolRegistrations.create(
        user.id,
        createToolRegistrationDraft({
          name,
          description,
          command,
          kind,
          mcpToolName: kind === "mcp" ? mcpToolName || name : undefined,
        }),
      );
    }

    return NextResponse.redirect(redirectUrl(request, "/admin/tool-registrations"), { status: 303 });
  });
}
