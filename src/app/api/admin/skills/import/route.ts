import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { redirectUrl } from "@/server/http/redirect";
import { getLlmClient } from "@/server/llm/router";
import { discoverSkillsFromGitHub } from "@/server/skills/import";
import { scanSkillContent } from "@/server/skills/security-scan";
import {
  assertAuthorizedModelRoutes,
  resolveDefaultAgentScope,
} from "@/server/agents/service";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories, signal) => {
    const form = await request.formData();
    signal.throwIfAborted();
    const url = String(form.get("url") ?? "").trim();
    const selectedPaths = form.getAll("paths").map(String).filter(Boolean);

    if (!url || selectedPaths.length === 0) {
      return NextResponse.redirect(redirectUrl(request, `/admin-legacy/skills/import?url=${encodeURIComponent(url)}`), { status: 303 });
    }

    const env = readEnv();
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const settings = await repositories.settings.get(scope);
    await assertAuthorizedModelRoutes(
      scope,
      ["light"],
      settings.modelRouting,
      repositories.agents,
    );
    const light = getLlmClient("light", env, settings.modelRouting);

    let installed = 0;
    let blocked = 0;
    try {
      const discovered = await discoverSkillsFromGitHub({
        url,
        token: env.githubToken,
        signal,
      });
      const selected = discovered.filter((skill) => selectedPaths.includes(skill.path));

      for (const skill of selected) {
        signal.throwIfAborted();
        // Rule + LLM scan runs at install time so the stored report reflects
        // the exact installed content. A danger verdict can never be overridden.
        const report = await scanSkillContent(skill.raw, {
          llm: light.client,
          model: light.model,
          signal,
        });
        signal.throwIfAborted();
        if (report.verdict === "danger") {
          blocked += 1;
          continue;
        }
        await repositories.skills.create(user.id, {
          name: skill.document.name,
          trigger: skill.document.description,
          content: skill.raw,
          status: "pending",
          source: "imported",
          sourceUrl: skill.webUrl,
          scanReport: report,
        });
        installed += 1;
      }
    } catch {
      signal.throwIfAborted();
      return NextResponse.redirect(redirectUrl(request, `/admin-legacy/skills/import?url=${encodeURIComponent(url)}`), { status: 303 });
    }

    const query = `url=${encodeURIComponent(url)}&installed=${installed}&blocked=${blocked}`;
    return NextResponse.redirect(redirectUrl(request, `/admin-legacy/skills/import?${query}`), { status: 303 });
  }, { signal: request.signal, timeoutCode: "skill_import_timeout" });
}
