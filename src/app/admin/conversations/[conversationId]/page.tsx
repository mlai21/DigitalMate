import Link from "next/link";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看会话。</section>;

  const { conversationId } = await params;
  const repositories = createRepositories();
  const conversation = await repositories.conversations.getForUser(user.id, conversationId);
  if (!conversation) {
    return (
      <section className="admin-card">
        会话不存在或已删除。<Link href="/admin/conversations">返回会话列表</Link>
      </section>
    );
  }

  const [messages, toolLogs] = await Promise.all([
    repositories.messages.listAllForAudit(conversationId),
    repositories.toolLogs.listByConversation(user.id, conversationId),
  ]);

  const timeline = [
    ...messages.map((message) => ({
      kind: "message" as const,
      createdAt: message.createdAt,
      message,
    })),
    ...toolLogs.map((log) => ({
      kind: "tool" as const,
      createdAt: log.created_at as Date,
      log,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return (
    <>
      <header className="admin-page-header">
        <h2>{conversation.title}</h2>
        <p>
          渠道 {conversation.channel} · 共 {messages.length} 条消息、{toolLogs.length} 次工具调用 ·{" "}
          <Link href="/admin/conversations">返回会话列表</Link>
        </p>
      </header>
      <section className="admin-list">
        {timeline.length === 0 ? <article className="admin-card">这个会话还没有内容。</article> : null}
        {timeline.map((entry) =>
          entry.kind === "message" ? (
            <article className="admin-card" key={`message-${entry.message.id}`}>
              <div className="conversation-log-meta">
                <span className="tag">{entry.message.role}</span>
                {!entry.message.visibleToUser ? <span className="tag tag-error">对用户隐藏</span> : null}
                <small>{entry.createdAt.toLocaleString("zh-CN")}</small>
              </div>
              <p>{entry.message.content}</p>
            </article>
          ) : (
            <article className="admin-card" key={`tool-${String(entry.log.id)}`}>
              <div className="conversation-log-meta">
                <span className="tag">工具 {String(entry.log.tool_name)}</span>
                <span className={`tag${entry.log.status === "error" ? " tag-error" : ""}`}>{String(entry.log.status)}</span>
                <small>
                  {entry.createdAt.toLocaleString("zh-CN")} · {Number(entry.log.duration_ms)}ms
                </small>
              </div>
              <dl className="tool-log-details">
                <div>
                  <dt>输入</dt>
                  <dd>{String(entry.log.input_summary)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{String(entry.log.output_summary)}</dd>
                </div>
                {entry.log.error ? (
                  <div>
                    <dt>错误</dt>
                    <dd className="tool-log-error">{String(entry.log.error)}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          ),
        )}
      </section>
    </>
  );
}
