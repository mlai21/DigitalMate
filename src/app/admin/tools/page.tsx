import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { ToolLogCard } from "@/components/admin/tool-log-card";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看工具日志。</section>;

  const logs = await createRepositories().toolLogs.list(user.id);

  return (
    <section className="admin-list">
      {logs.length === 0 ? <article className="admin-card">还没有工具调用记录。</article> : null}
      {logs.map((log) => (
        <ToolLogCard key={log.id} log={log} />
      ))}
    </section>
  );
}
