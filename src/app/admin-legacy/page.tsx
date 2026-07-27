import Link from "next/link";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { getCurrentUser } from "@/server/auth/current-user";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) return <AdminEmpty message="需要登录后查看后台。" />;

  const [
    conversations,
    memories,
    toolLogs,
    usageLogs,
    reminders,
    interjectionDecisions,
    reflections,
    skills,
    taskRuns,
    toolRegistrations,
  ] = await withFreshUserDataLease(user.id, async (repositories) => {
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    return Promise.all([
      repositories.conversations.list(scope),
      repositories.memories.list(scope),
      repositories.toolLogs.list(scope),
      repositories.llmUsage.list(scope),
      repositories.proactiveTasks.list(scope),
      repositories.channels.listDecisions(scope),
      repositories.reflections.list(scope),
      repositories.skills.list(user.id),
      repositories.taskRuns.list(scope),
      repositories.toolRegistrations.list(user.id),
    ]);
  });

  return (
    <section className="admin-grid">
      <StatCard label="会话" value={conversations.length} />
      <StatCard label="记忆" value={memories.length} />
      <StatCard label="工具调用" value={toolLogs.length} />
      <StatCard label="模型调用" value={usageLogs.length} />
      <StatCard label="提醒" value={reminders.length} />
      <StatCard label="插话决策" value={interjectionDecisions.length} />
      <StatCard label="反思" value={reflections.length} />
      <StatCard label="Skills" value={skills.length} />
      <StatCard label="任务" value={taskRuns.length} />
      <StatCard label="工具注册" value={toolRegistrations.length} />
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="admin-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AdminEmpty({ message }: { message: string }) {
  return (
    <section className="admin-card admin-empty">
      <span>{message}</span>
      <Link className="setup-notice-action" href="/login">
        去登录
      </Link>
    </section>
  );
}
