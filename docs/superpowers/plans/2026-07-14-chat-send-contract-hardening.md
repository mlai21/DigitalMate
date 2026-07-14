# 聊天发送合同加固实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让带附件的聊天发送以服务端 `accepted` 为提交边界，保证单源、草稿生命周期、附件上传中止、短屏布局与弹层可访问性均可验证。

**架构：** `/api/chat` 在用户消息持久化后立即发送 `accepted`，并在助手消息持久化后以带真实 ID 的 `done` 结束；客户端以是否收到 `accepted` 决定保留或清理输入草稿，并用稳定 `uiId` 与消息拉取对账。附件上传为每个 `localId` 维护独立 `AbortController`；移动端通过限制输入区和附件区内部高度保证消息滚动区与弹层可用。

**技术栈：** Next.js App Router、React 19、TypeScript、Vitest/Testing Library、Playwright、CSS。

---

### 任务 1：定义并验证 SSE 提交协议

**文件：**
- 修改：`src/app/api/chat/route.ts`
- 修改：`tests/unit/chat-route.test.ts`

- [ ] **步骤 1：编写失败的服务端协议测试**

新增断言：首事件为 `{type:"accepted", conversationId, userMessageId}`；正常 `done` 带 `assistantMessageId`；Agent 失败只持久化一个 fallback 助手消息并发送 `chunk + done(degraded)`；fallback 持久化失败也只发送稳定结束事件且不泄露异常。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-route.test.ts`
预期：现有 SSE 缺少 `accepted`/消息 ID，失败路径仍发送 `error`，新增断言失败。

- [ ] **步骤 3：实现最小协议**

用户消息创建后，在流首事件发送 `accepted`；保存助手消息返回值并把 ID 放入 `done`。Agent 异常时把已产生文本与稳定 fallback 合成单条内容，持久化成功后补发 suffix 与 degraded `done`；持久化失败时只发送无助手 ID 的 degraded `done` 并关闭流。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-route.test.ts`
预期：PASS。

### 任务 2：按 accepted 边界处理客户端草稿和对账

**文件：**
- 修改：`src/components/chat/chat-shell.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：编写失败的客户端事务测试**

覆盖：accepted 前 HTTP/SSE 失败返回 false 并保留输入；accepted 后 SSE error/断流返回 true、附件变为 bound 且 `/api/chat` 只调用一次；done 用真实 ID 替换助手 draft 并保留 `uiId`；无助手 ID 时移除 draft 后立即拉取会话消息；即时轮询不会生成重复用户/助手消息；fallback 只显示一条。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：客户端尚不识别 accepted，accepted 后错误仍返回 false 并覆盖服务端文本，新增断言失败。

- [ ] **步骤 3：实现最小客户端状态机**

扩展 SSE 类型；用 `accepted`/`assistantMessageId` 驱动真实 ID 与 `uiId` 更新；accepted 后异常清理助手 draft、拉取 `/api/conversations/:id/messages` 对账并返回 true；accepted 前仍返回 false。轮询继续通过 `mergeMessages` 以 ID/乐观 `uiId` 去重。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：PASS。

### 任务 3：稳定无活动会话的输入草稿

**文件：**
- 修改：`src/components/chat/chat-shell.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：编写失败的生命周期测试**

从无活动会话输入文字和附件，模拟自动创建会话后 accepted 前失败与 accepted 后断流；断言自动 `setActiveConversationId` 不卸载 ChatInput，分别保留或清理草稿。另断言用户主动切换/新建仍重置草稿。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：`key={activeConversationId}` 导致自动创建会话时输入组件卸载，新增断言失败。

- [ ] **步骤 3：实现稳定 draft 版本**

用仅在用户主动选择/新建/删除活动会话时递增的 `composerVersion` 作为 ChatInput key；自动创建的会话只更新活动 ID，不改变版本。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：PASS。

### 任务 4：中止失效附件上传

**文件：**
- 修改：`src/components/chat/attachment-picker.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：编写失败的 AbortController 测试**

验证每个上传请求收到独立 signal；移除和卸载会 abort；AbortError 不显示失败；被替换或忽略 abort 后迟到成功仍只 DELETE 一次。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：当前请求没有 signal 且移除/卸载不 abort，新增断言失败。

- [ ] **步骤 3：实现 localId 控制器注册表**

每次上传先 abort 同 localId 旧控制器，再把新 signal 传给 fetch；移除、卸载时 abort；仅当前控制器可更新卡片，迟到成功调用幂等草稿删除。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：PASS。

### 任务 5：改为可访问的 disclosure 弹层

**文件：**
- 修改：`src/components/chat/attachment-picker.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`
- 修改：`tests/e2e/chat-scroll.spec.ts`

- [ ] **步骤 1：编写失败的键盘/ARIA 测试**

断言触发器含 `aria-haspopup="dialog"`、`aria-controls`、`aria-expanded`；面板为具名 dialog；打开后首项获焦，Tab 可到第二项，Escape 关闭并恢复触发器焦点，外点关闭。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：当前残缺 menu 语义和焦点行为使断言失败。

- [ ] **步骤 3：实现普通 disclosure/dialog popover**

使用稳定 `useId` 关联触发器和面板，面板内使用普通按钮；打开 effect 聚焦首项；Escape 关闭并恢复触发器；保留外点与 Skill 互斥。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：PASS。

### 任务 6：短屏布局与无私有 React E2E

**文件：**
- 修改：`src/app/globals.css`
- 修改：`tests/e2e/chat.spec.ts`
- 修改：`tests/e2e/chat-scroll.spec.ts`
- 修改：`tests/e2e/fixtures/chat/src/main.tsx`

- [ ] **步骤 1：编写失败的真实浏览器测试**

删除 `__reactProps$` hack。使用启用的 Vite ChatShell fixture，经正常 `+` 点击打开弹层；在 375×667 和 375×568 下真实上传 4 个附件、输入 8 行、制造新消息，断言弹层完全在 viewport，且不与新消息按钮和输入框相交；断言消息区仍可滚动。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test:e2e:scroll -- --grep "short mobile"`
预期：当前单列附件区使短屏弹层越界或遮挡，新增断言失败。

- [ ] **步骤 3：实现移动端内部滚动布局**

短屏下附件区保持两列并限制高度、内部滚动；textarea 使用 viewport 相关 max-height 和自身滚动；composer 限制最大高度，继续由 ResizeObserver 更新消息底部留白。

- [ ] **步骤 4：运行浏览器测试验证通过**

运行：`npm run test:e2e:scroll -- --grep "short mobile"`
预期：PASS。

### 任务 7：全量验证与提交

**文件：** 本计划涉及的全部文件。

- [ ] **步骤 1：运行完整验证**

运行：`npm test`、`npm run test:e2e`、`npm run typecheck`、`npm run build`、改动文件 ESLint、`git diff --check`。预期全部通过；若全仓 lint 仅剩任务前已有的 `src/app/home/reveal.tsx:27`，如实记录而不修改无关文件。

- [ ] **步骤 2：提交**

```bash
git add <本计划涉及文件>
git commit -m "fix(P0-10): 建立附件发送接受协议"
```

### 任务 8：把 turn 幂等下沉到 PostgreSQL

**文件：**
- 修改：`src/server/db/schema.sql`
- 修改：`src/server/db/repositories.ts`
- 修改：`tests/unit/repositories-attachments.test.ts`

- [x] **步骤 1：编写失败的真实 PostgreSQL 测试**

在 embedded PostgreSQL fixture 中先执行 `client_turn_id`/payload hash 迁移，再覆盖：同一 turn 并发创建只产生一个 user；附件已经绑定后的相同 turn 重试返回原 user 与原附件；同 turn 不同 payload 抛出 `client_turn_conflict`；并发 assistant 正常/降级竞争只保留一个。

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/repositories-attachments.test.ts`
预期：FAIL，仓储没有 turn API，schema 没有唯一部分索引。

- [x] **步骤 3：实现迁移和事务 API**

给 `messages` 增加 nullable `client_turn_id uuid` 和内部 payload hash，建立 `(user_id, client_turn_id, role) WHERE client_turn_id IS NOT NULL` 唯一索引。新增 `createIdempotentUserTurn`、`createIdempotentAssistantTurn`、`findByClientTurn`；使用事务内 `INSERT ... ON CONFLICT ... DO NOTHING`，existing 分支核对 conversation/content/hash/附件绑定，assistant 返回 `{message, created}`。

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/repositories-attachments.test.ts`
预期：PASS。

### 任务 9：路由按 turn 恢复而非重复执行

**文件：**
- 修改：`src/app/api/chat/route.ts`
- 修改：`tests/unit/chat-route.test.ts`

- [x] **步骤 1：编写失败的路由测试**

请求必须含 UUID `clientTurnId`；重复请求已有 assistant 时只输出 accepted、完整 chunk、done 且不调用 Agent；已有 user 无 assistant 时继续执行；history 排除当前 turn；提醒、跟进和 post-turn 只在 assistant `created=true` 时执行；controller 已关闭不进入 fallback；Agent 失败若 assistant 已被并发请求写入则回放既有内容。

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-route.test.ts`
预期：FAIL，当前请求没有 turn ID，重试会再次创建消息并运行 Agent。

- [x] **步骤 3：实现恢复协议**

规范化正文、附件、Skill、搜索和会话后生成内部 payload hash；仓储冲突返回稳定 409。SSE 的 accepted/done 都携带 `clientTurnId`；已有 assistant 直接回放。正常和 fallback 都调用 idempotent assistant insert。Agent 执行前通过独立小连接池持有 PostgreSQL turn advisory lock，等待者 try-lock 轮询且不得占用业务连接；锁内二次检查 assistant，保证重叠请求不重复执行 Agent/搜索/工具。用 `safeEnqueue`/`safeClose` 吞掉 reader cancel/closed controller，消息落库后发送失败不得转入 fallback。

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-route.test.ts`
预期：PASS。

### 任务 10：客户端草稿持有稳定 clientTurnId

**文件：**
- 修改：`src/components/chat/chat-input.tsx`
- 修改：`src/components/chat/chat-shell.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [x] **步骤 1：编写失败的草稿/重试测试**

验证失败重试复用同一 UUID；正文、附件、Skill 或搜索被用户编辑后换新 UUID；API body 必须携带 ID。accepted 前失败移除该 turn 的乐观 user/assistant，只由输入框保留唯一草稿并显示失败；accepted 后清草稿。补无活动会话 accepted 后断流，以及 accepted 事件丢失后两次 HTTP 仍只有一个可见 turn 的测试。

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：FAIL，ChatInput 不持有 turn ID，accepted 前失败会在消息区留下 user/错误泡。

- [x] **步骤 3：实现稳定草稿 ID 与 UI 回滚**

ChatInput 初始化草稿 UUID；每次用户编辑重新生成，submit false 不变，submit true 清理后生成新值。ChatShell 以 clientTurnId 生成稳定乐观 `uiId`，accepted 前 catch 删除两条乐观消息并返回 false；accepted/done/poll 用真实 ID 合并并折叠已由轮询恢复的同 ID 消息。

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：PASS。

### 任务 11：附件弹层选择后恢复焦点

**文件：**
- 修改：`src/components/chat/attachment-picker.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [x] **步骤 1：编写失败的焦点测试**

模拟文件选择完成，断言 dialog 关闭、`aria-expanded=false`，焦点回到“添加附件”触发器。

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/chat-ui.test.tsx`
预期：FAIL，当前 selection 关闭后焦点仍停在隐藏 file input。

- [x] **步骤 3：实现选择完成焦点恢复并验证通过**

`handleInputChange` 关闭弹层后聚焦触发器，再运行同一测试文件，预期 PASS。

### 任务 12：完整验证与第二次提交

**文件：** 上述全部文件。

- [x] **步骤 1：执行验证门禁**

运行：`npm test`、embedded PostgreSQL 测试、`npm run test:e2e`、`npm run typecheck`、`npm run build`、改动文件 ESLint、`git diff --check`。公开消息序列化测试继续断言没有 `clientTurnId`/payload hash。

- [x] **步骤 2：提交**

```bash
git add src/server/db/schema.sql src/server/db/repositories.ts src/app/api/chat/route.ts src/components/chat/chat-input.tsx src/components/chat/chat-shell.tsx src/components/chat/attachment-picker.tsx tests docs/superpowers/plans/2026-07-14-chat-send-contract-hardening.md
git commit -m "fix(P0-10): 建立聊天轮次数据库幂等"
```
