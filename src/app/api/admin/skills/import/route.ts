import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import { getLlmClient } from "@/server/llm/router";
import { discoverSkillsFromGitHub } from "@/server/skills/import";
import { scanSkillContent } from "@/server/skills/security-scan";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const url = String(form.get("url") ?? "").trim();
  const selectedPaths = form.getAll("paths").map(String).filter(Boolean);

  if (!url || selectedPaths.length === 0) {
    return NextResponse.redirect(redirectUrl(request, `/admin/skills/import?url=${encodeURIComponent(url)}`), { status: 303 });
  }

  const env = readEnv();
  const repositories = createRepositories();
  const settings = await repositories.settings.get(user.id);
  const light = getLlmClient("light", env, settings.modelRouting);

  let installed = 0;
  let blocked = 0;
  try {
    const discovered = await discoverSkillsFromGitHub({ url, token: env.githubToken });
    const selected = discovered.filter((skill) => selectedPaths.includes(skill.path));

    for (const skill of selected) {
      // Rule + LLM scan runs at install time so the stored report reflects
      // the exact installed content. A danger verdict can never be overridden.
      const report = await scanSkillContent(skill.raw, { llm: light.client, model: light.model });
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
    return NextResponse.redirect(redirectUrl(request, `/admin/skills/import?url=${encodeURIComponent(url)}`), { status: 303 });
  }

  const query = `url=${encodeURIComponent(url)}&installed=${installed}&blocked=${blocked}`;
  return NextResponse.redirect(redirectUrl(request, `/admin/skills/import?${query}`), { status: 303 });
}
