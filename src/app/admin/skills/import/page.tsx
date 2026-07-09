import Link from "next/link";
import { getCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { discoverSkillsFromGitHub, type DiscoveredSkill } from "@/server/skills/import";
import { scanSkillContentWithRules } from "@/server/skills/security-scan";

export const dynamic = "force-dynamic";

type ImportSearchParams = {
  url?: string;
  installed?: string;
  blocked?: string;
};

export default async function SkillImportPage({ searchParams }: { searchParams: Promise<ImportSearchParams> }) {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后导入 Skills。</section>;

  const params = await searchParams;
  const url = (params.url ?? "").trim();
  const installed = Number(params.installed ?? 0);
  const blocked = Number(params.blocked ?? 0);

  let skills: DiscoveredSkill[] = [];
  let error: string | null = null;
  if (url) {
    try {
      skills = await discoverSkillsFromGitHub({ url, token: readEnv().githubToken });
      if (skills.length === 0) error = "这个链接下没有找到可解析的 SKILL.md 文件。";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "读取 GitHub 链接失败。";
    }
  }

  return (
    <section className="admin-list">
      <form className="admin-card admin-form" method="get" action="/admin/skills/import">
        <h2>从 GitHub 导入 Skill</h2>
        <p className="admin-hint">
          支持仓库、目录或 SKILL.md 文件链接（兼容 agentskills.io 标准）。安装前会做安全扫描，判定危险的 Skill 无法安装；安装后仍需在
          <Link href="/admin/skills"> Skills 页</Link>确认启用。
        </p>
        <label>
          GitHub 链接
          <input name="url" placeholder="https://github.com/owner/repo" defaultValue={url} required />
        </label>
        <button className="primary-button compact" type="submit">
          发现 Skill
        </button>
      </form>

      {installed > 0 || blocked > 0 ? (
        <article className="admin-card">
          {installed > 0 ? `已安装 ${installed} 个 Skill 草稿（待确认启用）。` : null}
          {blocked > 0 ? ` ${blocked} 个 Skill 因安全扫描判定为危险，已被拦截。` : null}
        </article>
      ) : null}

      {error ? <article className="admin-card">{error}</article> : null}

      {skills.length > 0 ? (
        <form className="admin-card admin-form" method="post" action="/api/admin/skills/import">
          <h2>发现 {skills.length} 个 Skill</h2>
          <input type="hidden" name="url" value={url} />
          <div className="skill-import-list">
            {skills.map((skill) => {
              const findings = scanSkillContentWithRules(skill.raw);
              const hasDanger = findings.some((finding) => finding.severity === "danger");
              return (
                <label className="skill-import-item" key={skill.path}>
                  <input type="checkbox" name="paths" value={skill.path} disabled={hasDanger} defaultChecked={!hasDanger} />
                  <div>
                    <p>
                      {skill.document.name}
                      {hasDanger ? <span className="tag tag-error">危险，禁止安装</span> : null}
                      {!hasDanger && findings.length > 0 ? <span className="tag">有警告</span> : null}
                    </p>
                    <small>{skill.document.description}</small>
                    <small className="skill-import-path">{skill.path}</small>
                    {findings.map((finding) => (
                      <small key={`${finding.rule}-${finding.detail}`} className="skill-import-finding">
                        {finding.severity === "danger" ? "危险" : "警告"}：{finding.detail}
                      </small>
                    ))}
                  </div>
                </label>
              );
            })}
          </div>
          <button className="primary-button compact" type="submit">
            安装选中的 Skill
          </button>
        </form>
      ) : null}
    </section>
  );
}
