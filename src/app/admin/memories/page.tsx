import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function MemoriesPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看记忆。</section>;

  const memories = await createRepositories().memories.list(user.id);

  return (
    <section className="admin-list">
      {memories.length === 0 ? <article className="admin-card">还没有长期记忆。</article> : null}
      {memories.map((memory) => (
        <article className="admin-card memory-card" key={memory.id}>
          <form className="memory-edit-form" action="/api/admin/memories/update" method="post">
            <input type="hidden" name="memoryId" value={memory.id} />
            <label>
              类型
              <select name="kind" defaultValue={memory.kind}>
                <option value="profile">profile</option>
                <option value="episodic">episodic</option>
                <option value="agent_self">agent_self</option>
              </select>
            </label>
            <label>
              内容
              <textarea name="content" rows={3} defaultValue={memory.content} />
            </label>
            <label>
              置信度
              <input name="confidence" type="number" min="0" max="1" step="0.01" defaultValue={memory.confidence} />
            </label>
            <button className="primary-button" type="submit">
              保存
            </button>
          </form>
          <div className="memory-actions">
            <small>创建于 {memory.createdAt.toLocaleString("zh-CN")}</small>
            <form action="/api/admin/memories/delete" method="post">
              <input type="hidden" name="memoryId" value={memory.id} />
              <ConfirmSubmitButton confirmMessage="确定删除这条记忆吗？删除后不会再用于后续对话。">
                删除
              </ConfirmSubmitButton>
            </form>
          </div>
        </article>
      ))}
    </section>
  );
}
