import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { ProactivityPresetForm } from "@/components/admin/proactivity-preset-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后修改设置。</section>;

  const settings = await createRepositories().settings.get(user.id);

  return (
    <>
      <header className="admin-page-header">
        <h2>设置</h2>
        <p>人设、主动性边界与拟人节奏参数。</p>
      </header>
      <section className="admin-list">
      <form className="admin-card admin-form" action="/api/admin/settings" method="post">
        <label>
          名字
          <input name="name" defaultValue={settings.persona.name} />
        </label>
        <label>
          语气风格
          <textarea name="style" rows={4} defaultValue={settings.persona.style} />
        </label>
        <label>
          表情习惯
          <input name="emojiHabit" defaultValue={settings.persona.emojiHabit ?? ""} />
        </label>
        <label>
          静默开始
          <input name="quietStart" defaultValue={settings.proactivity.quietStart} />
        </label>
        <label>
          静默结束
          <input name="quietEnd" defaultValue={settings.proactivity.quietEnd} />
        </label>
        <label>
          每日主动消息上限
          <input name="maxPerDay" type="number" min="1" max="20" defaultValue={settings.proactivity.maxPerDay} />
        </label>
        <label>
          群聊每小时插话上限
          <input name="maxPerHour" type="number" min="1" max="10" defaultValue={settings.proactivity.maxPerHour ?? 2} />
        </label>
        <label>
          插话最小间隔（分钟）
          <input
            name="minIntervalMinutes"
            type="number"
            min="1"
            max="240"
            defaultValue={settings.proactivity.minIntervalMinutes ?? 30}
          />
        </label>
        <div className="form-inline-action">
          <span>主动程度档位</span>
          <ProactivityPresetForm />
        </div>
        <label>
          首条回复延迟（毫秒）
          <input
            name="responseDelayMs"
            type="number"
            min="0"
            max="2000"
            defaultValue={settings.cadence.responseDelayMs ?? 480}
          />
        </label>
        <label>
          分段间隔（毫秒）
          <input
            name="segmentDelayMs"
            type="number"
            min="0"
            max="2000"
            defaultValue={settings.cadence.segmentDelayMs ?? 240}
          />
        </label>
        <label>
          单次最多分段
          <input name="maxSegments" type="number" min="1" max="20" defaultValue={settings.cadence.maxSegments ?? 5} />
        </label>
        <p className="model-picker-hint">
          模型路由已移到<a href="/admin/models">「模型」页</a>选择。
        </p>
        <button className="primary-button" type="submit">
          保存
        </button>
      </form>

      <article className="admin-card admin-form">
        <h2>数据自控</h2>
        <p>导出或清空当前用户的对话、记忆、任务、工具日志、渠道记录、反思和用量数据。</p>
        <a className="secondary-link" href="/api/admin/data/export">
          导出个人数据
        </a>
        <form action="/api/admin/data/clear" method="post">
          <ConfirmSubmitButton confirmMessage="确定清空当前用户的全部个人数据吗？这个操作会删除对话、记忆、任务和日志。">
            清空个人数据
          </ConfirmSubmitButton>
        </form>
      </article>
      </section>
    </>
  );
}
