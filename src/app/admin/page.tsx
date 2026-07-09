import Link from "next/link";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) return <AdminEmpty message="需要登录后查看后台。" />;

  const repositories = createRepositories();
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
  ] = await Promise.all([
    repositories.conversations.list(user.id),
    repositories.memories.list(user.id),
    repositories.toolLogs.list(user.id),
    repositories.llmUsage.list(user.id),
    repositories.proactiveTasks.list(user.id),
    repositories.channels.listDecisions(user.id),
    repositories.reflections.list(user.id),
    repositories.skills.list(user.id),
    repositories.taskRuns.list(user.id),
    repositories.toolRegistrations.list(user.id),
  ]);

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
