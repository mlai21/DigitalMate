# 显式联网与主动消息防重实现计划

> **面向 AI 代理的工作者：** 在当前会话中按 TDD 顺序内联执行；每个行为先写失败测试并确认失败，再写最少实现。

**目标：** 默认禁止对话与后台任务自行联网；只有用户点亮输入框联网按钮、在文字中明确要求搜索，或由用户明确创建的主题订阅/定时摘要，才允许联网，同时阻止同一主动任务产生重复可见消息。

**架构：** Web 输入框将本轮联网授权作为结构化布尔值提交，服务端以该值和明确搜索措辞作为硬门控，不依赖模型猜测。现有基于任意记忆自动生成主动分享的占位任务停用；主动分享投递必须携带授权来源，并以任务 ID 作为消息幂等键。

**技术栈：** Next.js App Router、React 19、TypeScript、PostgreSQL、Vitest、Testing Library。

---

## 文件职责

- `src/components/chat/chat-input.tsx`：显示并维护“本轮联网”按钮状态，提交后自动复位。
- `src/components/chat/chat-shell.tsx`：把 `searchEnabled` 结构化传给 `/api/chat`。
- `src/app/globals.css`：输入框工具栏、联网关闭态和开启态样式。
- `src/app/api/chat/route.ts`：校验本轮联网授权并传给 Agent。
- `src/server/agent/search-gate.ts`：执行显式授权硬门控。
- `src/server/agent/run-agent.ts`：让模型知道本轮是否已获联网授权，同时保持搜索结果只作内部依据。
- `src/agent-service/index.ts`：停用基于任意记忆自动联网的主动分享占位流程。
- `src/server/agent/proactive-delivery.ts`：拦截无订阅/无定时摘要授权的历史分享任务，并使用幂等写入。
- `src/server/db/schema.sql`、`src/server/db/repositories.ts`：为主动任务消息增加唯一来源键与取消能力。
- `tests/unit/*.test.ts(x)`：覆盖 UI 授权、API 传参、硬门控、后台拦截和幂等性。
- `docs/prd.md`、`AGENTS.md`：固化产品需求和编码红线。

### 任务 1：输入框显式联网授权

- [x] 在 `tests/unit/chat-ui.test.tsx` 添加失败测试：点击“联网搜索”后按钮显示“搜索”，提交参数包含 `{ searchEnabled: true }`，发送后按钮恢复关闭态。
- [x] 运行 `npm test -- tests/unit/chat-ui.test.tsx`，确认因按钮不存在或参数缺失而失败。
- [x] 在 `chat-input.tsx` 使用语义化 `<button type="button" aria-pressed>` 和 `Globe2` 图标实现状态；未开启只显示图标，开启显示“搜索”文字。
- [x] 在 `chat-shell.tsx` 将 `searchEnabled` 写入 `/api/chat` 请求体。
- [x] 在 `globals.css` 增加 44 px 触控目标、暖色关闭态和珊瑚橙开启态。
- [x] 重跑 UI 测试确认通过。

### 任务 2：服务端显式联网硬门控

- [x] 在 `tests/unit/search-gate.test.ts` 添加失败测试：UI 授权直接放行；未授权的天气、新闻和普通问候均拦截；文字明确要求“搜一下”仍放行。
- [x] 在 `tests/unit/chat-route.test.ts` 添加失败测试：`searchEnabled: true` 被传入 `runAgent`，省略时为 `false`。
- [x] 运行两组测试确认失败。
- [x] 扩展 `/api/chat` 请求结构和 `RunAgentInput`，把授权传入硬门控和系统提示。
- [x] 修改 `search-gate.ts`：非 UI 授权且非明确搜索措辞时一律拒绝，不再因为模型认为内容“可能实时”而自动放行。
- [x] 重跑两组测试确认通过。

### 任务 3：冻结未授权后台主动分享

- [x] 在 `tests/unit/proactive-delivery.test.ts` 添加失败测试：无授权元数据的 `share` 被取消且不写消息；`authorization: subscription` 和 `authorization: scheduled_digest` 才允许投递。
- [x] 添加源代码静态回归测试，证明 Agent tick 不再调用基于记忆的 `processProactiveShares`/`searchWeb` 创建分享。
- [x] 运行测试确认失败。
- [x] 从 `src/agent-service/index.ts` 删除自动选取记忆、自动搜索、每 24 小时再建分享任务的链路。
- [x] 在主动投递前校验授权来源；遗留未授权分享调用仓储 `markCancelled`。
- [x] 重跑测试确认通过。

### 任务 4：主动消息幂等

- [x] 在 `tests/unit/schema.test.ts` 添加失败测试：`messages.source_task_id` 存在且有唯一索引。
- [x] 在 `tests/unit/proactive-delivery.test.ts` 添加失败测试：同一任务第二次写入返回未创建，不再次推送渠道消息，但任务仍标记完成。
- [x] 运行测试确认失败。
- [x] 在数据库 schema 增加可空 `source_task_id` 外键和部分唯一索引。
- [x] 在 messages 仓储增加 `createFromProactiveTask`，使用 `ON CONFLICT DO NOTHING RETURNING id`。
- [x] 修改投递器仅在首次写入成功时向 IM 推送。
- [x] 重跑测试确认通过。

### 任务 5：需求与编码约束

- [x] 将 `docs/prd.md` 升级为 v0.7：P0-4、P1-9、5.2、5.4、M1 验收明确“默认不联网、显式授权、后台订阅授权、原始搜索结果不可见、单源消息幂等”。
- [x] 在 `AGENTS.md` 增加联网、后台主动消息和可见输出事务红线。
- [x] 检查功能编号交叉引用一致，确保不引入新的开放歧义。

### 任务 6：完成前验证

- [x] 运行相关单测：`npm test -- tests/unit/chat-ui.test.tsx tests/unit/chat-route.test.ts tests/unit/search-gate.test.ts tests/unit/proactive-delivery.test.ts tests/unit/schema.test.ts`。
- [x] 运行 `npm test`、`npm run typecheck`、`npm run lint`。
- [x] 本地启动并尝试检查输入框；交互与 44 px 触控区域已由组件测试和样式检查覆盖。内置浏览器访问本机预览报 `ERR_INSUFFICIENT_RESOURCES`，未将该环境失败计作视觉验收通过。
- [x] 查看 `git diff --check` 与 `git diff`，确认未修改用户已有图片改动。
