import Link from "next/link";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { SkillStatusActions } from "@/components/admin/status-actions";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { buildLineDiff } from "@/server/skills/diff";

export const dynamic = "force-dynamic";

const sourceLabels: Record<string, string> = {
  manual: "手动创建",
  agent: "Agent 沉淀",
  task: "任务沉淀",
  imported: "GitHub 导入",
};

export default async function SkillsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后管理 Skills。</section>;

  const repositories = createRepositories();
  const [skills, pendingRevisions] = await Promise.all([
    repositories.skills.list(user.id),
    repositories.skillRevisions.listPending(user.id),
  ]);

  return (
    <section className="admin-list">
      <form className="admin-card admin-form" action="/api/admin/skills/create" method="post">
        <h2>沉淀 Skill 草稿</h2>
        <p className="admin-hint">
          也可以<Link href="/admin/skills/import">从 GitHub 导入社区 Skill</Link>（安装前自动安全扫描）。
        </p>
        <label>
          名称
          <input name="name" placeholder="信息整理流程" required />
        </label>
        <label>
          适用场景
          <input name="trigger" placeholder="整理搜索结果并输出摘要" required />
        </label>
        <label>
          步骤
          <textarea name="steps" rows={5} placeholder={"确认目标\n联网搜索\n按来源整理\n输出结论"} required />
        </label>
        <button className="primary-button compact" type="submit">
          创建草稿
        </button>
      </form>

      {pendingRevisions.length > 0 ? (
        <article className="admin-card">
          <h2>待确认的自动修订（{pendingRevisions.length}）</h2>
          <p className="admin-hint">高频使用的 Skill 会由后台结合实际使用情况提出增量修订，确认后才生效。</p>
          {pendingRevisions.map((revision) => (
            <div className="admin-card memory-card" key={revision.id}>
              <div>
                <span className="tag tag-accent">修订建议</span>
                <p>{revision.skillName}</p>
                <small>修订理由：{revision.reason}</small>
                <pre className="skill-diff">
                  {buildLineDiff(revision.currentContent, revision.proposedContent).map((line, index) => (
                    <span className={`diff-${line.type}`} key={index}>
                      {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                      {line.text}
                    </span>
                  ))}
                </pre>
              </div>
              <form action="/api/admin/skills/revisions" method="post">
                <input type="hidden" name="revisionId" value={revision.id} />
                <ConfirmSubmitButton
                  className="primary-button compact"
                  confirmMessage="确定应用这次修订吗？应用后 Skill 内容会更新为修订版。"
                  name="decision"
                  value="applied"
                >
                  应用修订
                </ConfirmSubmitButton>
                <ConfirmSubmitButton
                  className="danger-button"
                  confirmMessage="确定拒绝这次修订吗？拒绝后当前内容保持不变。"
                  name="decision"
                  value="rejected"
                >
                  拒绝
                </ConfirmSubmitButton>
              </form>
            </div>
          ))}
        </article>
      ) : null}

      {skills.length === 0 ? <article className="admin-card">还没有 Skill 草稿。</article> : null}
      {skills.map((skill) => {
        const scanVerdict =
          skill.scanReport && typeof skill.scanReport === "object"
            ? (skill.scanReport as { verdict?: string }).verdict
            : undefined;
        return (
          <article className="admin-card memory-card" key={skill.id}>
            <div>
              <div className="skill-meta">
                <span className="tag">{skill.status}</span>
                <span className="tag">{sourceLabels[skill.source] ?? skill.source}</span>
                <span className="tag">v{skill.version}</span>
                <span className="tag">使用 {skill.usageCount} 次</span>
                {scanVerdict ? (
                  <span className={scanVerdict === "safe" ? "tag" : "tag tag-error"}>扫描：{scanVerdict}</span>
                ) : null}
              </div>
              <p>{skill.name}</p>
              <small>{skill.trigger}</small>
              {skill.sourceUrl ? (
                <small>
                  来源：
                  <a href={skill.sourceUrl} target="_blank" rel="noreferrer">
                    {skill.sourceUrl}
                  </a>
                </small>
              ) : null}
              <pre className="skill-content">{skill.content}</pre>
            </div>
            <SkillStatusActions skillId={skill.id} status={skill.status} />
          </article>
        );
      })}
    </section>
  );
}
