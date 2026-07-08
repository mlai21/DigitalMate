import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function InterjectionsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看插话决策。</section>;

  const decisions = await createRepositories().channels.listDecisions(user.id);

  return (
    <section className="admin-list">
      {decisions.length === 0 ? <article className="admin-card">还没有群聊插话决策。</article> : null}
      {decisions.map((decision) => (
        <article className="admin-card" key={decision.id}>
          <span className="tag">{decision.should_interject ? "已插话" : "未插话"}</span>
          <p>
            {decision.channel} · {decision.external_conversation_id}
          </p>
          <p>原因：{decision.reason}</p>
          <small>{new Date(decision.created_at).toLocaleString("zh-CN")}</small>
        </article>
      ))}
    </section>
  );
}
