import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { summarizeUsageLogs } from "@/server/llm/usage";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看用量。</section>;

  const logs = await createRepositories().llmUsage.list(user.id);
  const summary = summarizeUsageLogs(
    logs.map((log) => ({
      model: String(log.model),
      inputTokens: Number(log.input_tokens),
      outputTokens: Number(log.output_tokens),
      totalTokens: Number(log.total_tokens),
    })),
  );

  return (
    <section className="admin-list">
      <div className="admin-grid">
        <StatCard label="请求数" value={summary.requestCount} />
        <StatCard label="输入 token" value={summary.inputTokens} />
        <StatCard label="输出 token" value={summary.outputTokens} />
        <StatCard label="总 token" value={summary.totalTokens} />
      </div>

      <article className="admin-card">
        <h2>按模型统计</h2>
        {summary.byModel.length === 0 ? <p>还没有模型调用记录。</p> : null}
        {summary.byModel.map((item) => (
          <p key={item.model}>
            {item.model}：{item.requestCount} 次 · {item.totalTokens} token
          </p>
        ))}
      </article>

      {logs.map((log) => (
        <article className="admin-card" key={log.id}>
          <span className="tag">{log.purpose}</span>
          <p>{log.model}</p>
          <small>
            输入 {log.input_tokens} · 输出 {log.output_tokens} · 合计 {log.total_tokens} ·{" "}
            {new Date(log.created_at).toLocaleString("zh-CN")}
          </small>
        </article>
      ))}
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
