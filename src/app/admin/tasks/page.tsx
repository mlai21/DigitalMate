import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后查看任务。</section>;

  const repositories = createRepositories();
  const [taskRuns, artifacts] = await Promise.all([
    repositories.taskRuns.list(user.id),
    repositories.taskArtifacts.list(user.id),
  ]);
  const artifactsByTask = new Map<string, typeof artifacts>();
  for (const artifact of artifacts) {
    const list = artifactsByTask.get(artifact.task_run_id) ?? [];
    list.push(artifact);
    artifactsByTask.set(artifact.task_run_id, list);
  }

  return (
    <section className="admin-list">
      <article className="admin-card admin-form">
        <h2>代码沙箱</h2>
        <form action="/api/tasks/sandbox" method="post">
          <label>
            镜像
            <input name="image" defaultValue="node:22-alpine" />
          </label>
          <label>
            脚本
            <textarea name="script" rows={5} defaultValue={"node -e \"console.log('hello DigitalMate')\""} />
          </label>
          <button className="primary-button compact" type="submit">
            在沙箱执行
          </button>
        </form>
      </article>

      <article className="admin-card admin-form">
        <h2>表格汇总</h2>
        <form action="/api/tasks/csv" method="post" encType="multipart/form-data">
          <label>
            CSV / Excel 文件
            <input
              name="file"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
            />
          </label>
          <button className="primary-button compact" type="submit">
            生成汇总报告
          </button>
        </form>
      </article>

      <article className="admin-card admin-form">
        <h2>PPT 生成</h2>
        <form action="/api/tasks/presentation" method="post" encType="multipart/form-data">
          <label>
            标题
            <input name="title" defaultValue="DigitalMate 汇报" />
          </label>
          <label>
            大纲
            <textarea
              name="outline"
              rows={8}
              defaultValue={"本周进展\n- 完成聊天 MVP\n- 接入长期记忆\n\n下周计划\n- 验证 IM 渠道\n- 完善任务能力"}
            />
          </label>
          <label>
            数据素材（可选）
            <input
              name="file"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            />
          </label>
          <button className="primary-button compact" type="submit">
            生成 PPTX
          </button>
        </form>
      </article>

      {taskRuns.length === 0 ? <article className="admin-card">还没有任务运行记录。</article> : null}
      {taskRuns.map((task) => (
        <article className="admin-card" key={task.id}>
          <span className="tag">{task.status}</span>
          <p>{task.input_summary}</p>
          {task.output_summary ? <p>{task.output_summary}</p> : null}
          {task.error ? <p className="form-error">{task.error}</p> : null}
          <small>
            {task.kind} · {new Date(task.created_at).toLocaleString("zh-CN")}
          </small>
          {(artifactsByTask.get(task.id) ?? []).map((artifact) => (
            <p key={artifact.id}>
              <a className="secondary-link" href={`/api/tasks/artifacts/${artifact.id}`}>
                下载 {artifact.file_name}
              </a>
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}
