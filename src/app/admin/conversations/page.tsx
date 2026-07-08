import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看会话。</section>;

  const repositories = createRepositories();
  const conversation = await repositories.conversations.getOrCreateDefault(user.id);
  const messages = await repositories.messages.list(conversation.id);

  return (
    <section className="admin-list">
      {messages.length === 0 ? <article className="admin-card">当前还没有会话消息。</article> : null}
      {messages.map((message) => (
        <article className="admin-card" key={message.id}>
          <span className="tag">{message.role}</span>
          <p>{message.content}</p>
          <small>{message.createdAt.toLocaleString("zh-CN")}</small>
        </article>
      ))}
    </section>
  );
}
