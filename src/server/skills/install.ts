import { discoverSkillsFromGitHub, parseGitHubUrl, type DiscoveredSkill, type FetchLike } from "@/server/skills/import";
import { scanSkillContent, type ScanReport } from "@/server/skills/security-scan";
import type { SkillDraft } from "@/server/evolution/skills";
import type { LlmClient } from "@/server/llm/types";

export type InstalledSkillSummary = {
  name: string;
  description: string;
  status: "enabled" | "pending";
  verdict: ScanReport["verdict"];
  content: string;
};

export type SkillInstallOutcome = {
  installed: InstalledSkillSummary[];
  blocked: Array<{ name: string; reason: string }>;
  /** Other discovered skills that were not auto-installed (e.g. examples). */
  others: Array<{ name: string; path: string }>;
};

type InstallRepositories = {
  skills: {
    create(userId: string, draft: SkillDraft): Promise<unknown> | unknown;
  };
};

const MAX_AUTO_INSTALL = 5;

/**
 * Installs skills behind a GitHub link on behalf of an explicit user request
 * in chat. The explicit request counts as the user confirmation required by
 * the PRD for `safe` scan verdicts (installed enabled right away); `warning`
 * skills stay pending for admin review and `danger` skills are never
 * installed.
 */
export async function installSkillsFromGitHub(input: {
  url: string;
  userId: string;
  repositories: InstallRepositories;
  scanner?: { llm: LlmClient; model: string };
  token?: string;
  fetchFn?: FetchLike;
}): Promise<SkillInstallOutcome> {
  const parsed = parseGitHubUrl(input.url);
  if (!parsed) throw new Error("不是有效的 GitHub 链接。");

  const discovered = await discoverSkillsFromGitHub({ url: input.url, token: input.token, fetchFn: input.fetchFn });
  if (discovered.length === 0) {
    return { installed: [], blocked: [], others: [] };
  }

  const { primary, others } = pickPrimarySkills(discovered, parsed.path);

  const outcome: SkillInstallOutcome = {
    installed: [],
    blocked: [],
    others: others.map((skill) => ({ name: skill.document.name, path: skill.path })),
  };

  for (const skill of primary.slice(0, MAX_AUTO_INSTALL)) {
    const report = await scanSkillContent(
      skill.raw,
      input.scanner ? { llm: input.scanner.llm, model: input.scanner.model } : undefined,
    );
    if (report.verdict === "danger") {
      outcome.blocked.push({
        name: skill.document.name,
        reason: report.findings[0]?.detail ?? report.llm?.reason ?? "安全扫描判定为危险",
      });
      continue;
    }

    // Explicit chat request = user confirmation, so safe skills go live
    // immediately; warnings still require review in the admin console.
    const status = report.verdict === "safe" ? "enabled" : "pending";
    await input.repositories.skills.create(input.userId, {
      name: skill.document.name,
      trigger: skill.document.description,
      content: skill.raw,
      status,
      source: "imported",
      sourceUrl: skill.webUrl,
      scanReport: report,
    });

    outcome.installed.push({
      name: skill.document.name,
      description: skill.document.description,
      status,
      verdict: report.verdict,
      content: skill.raw,
    });
  }

  return outcome;
}

/**
 * A repo often carries one primary SKILL.md at its root (or at the linked
 * directory) plus example/demo skills deeper in the tree. Auto-install only
 * the shallowest level and report the rest so the user can pick them
 * explicitly.
 */
function pickPrimarySkills(
  discovered: DiscoveredSkill[],
  linkedPath: string,
): { primary: DiscoveredSkill[]; others: DiscoveredSkill[] } {
  const prefix = linkedPath ? `${linkedPath.replace(/\/$/, "")}/` : "";
  const depth = (skill: DiscoveredSkill) => skill.path.slice(prefix.length).split("/").length;
  const minDepth = Math.min(...discovered.map(depth));
  const primary = discovered.filter((skill) => depth(skill) === minDepth);
  const others = discovered.filter((skill) => depth(skill) !== minDepth);
  return { primary, others };
}
