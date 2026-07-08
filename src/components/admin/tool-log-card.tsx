export type ToolLogCardData = {
  id: string;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  status: "success" | "error";
  duration_ms: number;
  error?: string | null;
};

export function ToolLogCard({ log }: { log: ToolLogCardData }) {
  return (
    <article className="admin-card tool-log-card">
      <div className="tool-log-header">
        <span className={`tag ${log.status === "error" ? "tag-error" : ""}`}>{log.tool_name}</span>
        <small>
          {log.status} · {log.duration_ms} ms
        </small>
      </div>
      <dl className="tool-log-details">
        <div>
          <dt>输入</dt>
          <dd>{log.input_summary}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{log.output_summary}</dd>
        </div>
        {log.error ? (
          <div>
            <dt>错误</dt>
            <dd className="tool-log-error">{log.error}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
