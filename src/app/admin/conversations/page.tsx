import Link from "next/link";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看会话。</section>;

  const repositories = createRepositories();
  const [conversations, projects] = await Promise.all([
    repositories.conversations.listWithStats(user.id),
    repositories.projects.list(user.id),
  ]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <>
      <header className="admin-page-header">
        <h2>会话日志</h2>
        <p>全部渠道的会话列表，点击查看完整消息与工具调用记录。</p>
      </header>
      <section className="admin-list">
        {conversations.length === 0 ? <article className="admin-card">还没有任何会话。</article> : null}
        {conversations.map((conversation) => (
          <Link
            className="admin-card conversation-list-card"
            href={`/admin/conversations/${conversation.id}`}
            key={conversation.id}
          >
            <div className="conversation-list-main">
              <strong className="conversation-list-title">
                {conversation.pinned ? "📌 " : ""}
                {conversation.title}
              </strong>
              <small>
                {conversation.messageCount} 条消息
                {conversation.lastMessageAt
                  ? ` · 最后活跃 ${conversation.lastMessageAt.toLocaleString("zh-CN")}`
                  : ""}
              </small>
            </div>
            <div className="conversation-list-tags">
              <span className="tag">{conversation.channel}</span>
              {conversation.projectId && projectNames.has(conversation.projectId) ? (
                <span className="tag">项目：{projectNames.get(conversation.projectId)}</span>
              ) : null}
            </div>
          </Link>
        ))}
      </section>
    </>
  );
}
