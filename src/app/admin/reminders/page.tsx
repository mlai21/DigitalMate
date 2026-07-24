import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { getCurrentUser } from "@/server/auth/current-user";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看提醒。</section>;

  const reminders = await withFreshUserDataLease(user.id, async (repositories) => {
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    return repositories.proactiveTasks.list(scope);
  });

  return (
    <section className="admin-list">
      {reminders.length === 0 ? <article className="admin-card">还没有提醒任务。</article> : null}
      {reminders.map((task) => (
        <article className="admin-card" key={task.id}>
          <span className="tag">{task.status}</span>
          <p>{task.content}</p>
          <small>{task.scheduledAt.toLocaleString("zh-CN")}</small>
        </article>
      ))}
    </section>
  );
}
