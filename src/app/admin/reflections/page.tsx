import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function ReflectionsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看反思。</section>;

  const reflections = await createRepositories().reflections.list(user.id);

  return (
    <section className="admin-list">
      {reflections.length === 0 ? <article className="admin-card">还没有反思记录。</article> : null}
      {reflections.map((reflection) => (
        <article className="admin-card" key={reflection.id}>
          <span className="tag">{reflection.status}</span>
          <p>做得好：{reflection.positives?.join("、") || "无"}</p>
          <p>需要改进：{reflection.negatives?.join("、") || "无"}</p>
          <p>建议：{reflection.suggestions?.join("、") || "无"}</p>
          <small>{new Date(reflection.created_at).toLocaleString("zh-CN")}</small>
          <form action="/api/admin/reflections/status" method="post">
            <input type="hidden" name="reflectionId" value={reflection.id} />
            <button className="primary-button compact" name="status" value="applied" type="submit">
              应用建议
            </button>
            <button className="danger-button" name="status" value="dismissed" type="submit">
              忽略
            </button>
          </form>
        </article>
      ))}
    </section>
  );
}
