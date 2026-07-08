import { SkillStatusActions } from "@/components/admin/status-actions";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后管理 Skills。</section>;

  const skills = await createRepositories().skills.list(user.id);

  return (
    <section className="admin-list">
      <form className="admin-card admin-form" action="/api/admin/skills/create" method="post">
        <h2>沉淀 Skill 草稿</h2>
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

      {skills.length === 0 ? <article className="admin-card">还没有 Skill 草稿。</article> : null}
      {skills.map((skill) => (
        <article className="admin-card memory-card" key={skill.id}>
          <div>
            <span className="tag">{skill.status}</span>
            <p>{skill.name}</p>
            <small>{skill.trigger}</small>
            <pre className="skill-content">{skill.content}</pre>
          </div>
          <SkillStatusActions skillId={skill.id} status={skill.status} />
        </article>
      ))}
    </section>
  );
}
