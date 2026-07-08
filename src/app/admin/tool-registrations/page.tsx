import { ToolRegistrationStatusActions } from "@/components/admin/status-actions";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function ToolRegistrationsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后管理工具注册。</section>;

  const tools = await createRepositories().toolRegistrations.list(user.id);

  return (
    <section className="admin-list">
      <article className="admin-card admin-form">
        <h2>注册新工具草稿</h2>
        <form action="/api/admin/tool-registrations/create" method="post">
          <label>
            名称
            <input name="name" placeholder="xlsx_summary" required />
          </label>
          <label>
            说明
            <input name="description" placeholder="汇总电子表格并输出 Markdown 报告" required />
          </label>
          <label>
            类型
            <select name="kind" defaultValue="script">
              <option value="script">沙箱脚本</option>
              <option value="mcp">MCP 工具</option>
            </select>
          </label>
          <label>
            命令
            <textarea name="command" rows={4} placeholder="node tools/xlsx-summary.js" required />
          </label>
          <label>
            MCP 工具名
            <input name="mcpToolName" placeholder="search_docs" />
          </label>
          <button className="primary-button compact" type="submit">
            创建待确认草稿
          </button>
        </form>
      </article>

      {tools.length === 0 ? <article className="admin-card">还没有待确认工具。</article> : null}
      {tools.map((tool) => (
        <article className="admin-card memory-card" key={tool.id}>
          <div>
            <span className="tag">{tool.status}</span>
            <p>{tool.name}</p>
            <small>{tool.description}</small>
            <small>{tool.kind === "mcp" ? `MCP：${tool.mcp_tool_name || tool.name}` : "沙箱脚本"}</small>
            <pre className="skill-content">{tool.command}</pre>
          </div>
          <ToolRegistrationStatusActions toolId={tool.id} status={tool.status} />
        </article>
      ))}
    </section>
  );
}
