# 渠道统一事务运行时实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M3：建立统一 `ChannelAdapter`、持久入站、单次 Agent 执行、Delivery 队列、连接管理和运行节点协议，并把现有 Telegram/Slack/飞书/钉钉 webhook 迁入该运行时。

**架构：** Adapter 只规范化、ACK、连接与发送；Ingress 在 ACK 前以 `(connection_id, external_event_id)` 入库。Event Worker 原子 claim 事件，使用稳定 `client_turn_id` 和现有消息幂等机制执行一次 Agent；助手完整回复入库后创建唯一 Delivery，Delivery Worker 独立退避发送，不重新调用 Agent。

**技术栈：** TypeScript、PostgreSQL `FOR UPDATE SKIP LOCKED`/advisory lock/LISTEN-NOTIFY、Node.js 22、Vitest、embedded-postgres、WebSocket 协议类型。

---

## 文件结构

**创建：**

- `src/server/channels/runtime/types.ts`：规范化事件、权限信封、回复句柄、Delivery 与健康类型。
- `src/server/channels/runtime/adapter.ts`：`ChannelAdapter<TConfig>` 和运行上下文。
- `src/server/channels/runtime/registry.ts`：17 种 Adapter 工厂注册表；重复或缺失注册直接失败。
- `src/server/channels/runtime/connection-manager.ts`：按连接 start/stop/restart、退避、健康和配置热更新。
- `src/server/channels/runtime/ingress.ts`：持久化优先的入站接受与 ACK 结果。
- `src/server/channels/runtime/access.ts`：DM/group、allowlist、@、mute 和接入申请判定。
- `src/server/channels/runtime/event-repository.ts`：事件、lease、执行 journal 和恢复查询。
- `src/server/channels/runtime/event-worker.ts`：claim accepted/过期 running 事件并执行。
- `src/server/channels/runtime/turn-executor.ts`：统一 Agent turn、附件安全、提醒、插话和一次消息落库。
- `src/server/channels/runtime/execution-journal.ts`：LLM/search/tool 步骤开始、完成和不确定失败记录。
- `src/server/channels/runtime/delivery-repository.ts`：唯一 Delivery、attempt、退避和死信。
- `src/server/channels/runtime/delivery-worker.ts`：只发送已持久化助手回复。
- `src/server/channels/runtime/retry.ts`：指数退避、jitter、Retry-After 和熔断。
- `src/server/channels/runtime/attachment-ingress.ts`：私有下载、白名单、租约和附件上下文门控。
- `src/server/channels/runtime/legacy-env-import.ts`：一次性把现有四渠道 env 配置导入加密连接。
- `src/server/channels/nodes/protocol.ts`：节点注册、心跳、入站、发送、ACK 和错误 frame schema。
- `src/server/channels/nodes/repository.ts`：节点证书指纹、绑定连接、心跳和有界队列。
- `src/server/channels/adapters/webhook/telegram.ts`、`slack.ts`、`feishu.ts`、`dingtalk.ts`：M3 过渡 Adapter，只保留现有 webhook 协议并接统一运行时。
- `tests/unit/channels/adapter-boundary.test.ts`：禁止 Adapter 导入 Agent/记忆/搜索/工具/消息写仓储。
- `tests/unit/channels/ingress.test.ts`：先持久化后 ACK、重复和访问控制。
- `tests/unit/channels/turn-executor.test.ts`：附件、搜索、Skill、工具、提醒和插话红线。
- `tests/unit/channels/delivery-worker.test.ts`：发送重试不调用 Agent。
- `tests/unit/channels/connection-manager.test.ts`：热更新、退避、停止和健康。
- `tests/unit/channels/node-protocol.test.ts`：frame schema 与连接绑定。
- `tests/integration/channels/event-claim.test.ts`：并发、lease、重启和稳定 turn。
- `tests/integration/channels/end-to-end.test.ts`：事件到一条助手消息和 Delivery 的真实 PostgreSQL 链路。
- `docs/verification/channel-runtime-m3.md`：故障注入与红线证据。

**修改：**

- `src/server/db/schema.sql`：新增事件、步骤、回复句柄、Delivery、访问控制和节点表。
- `src/server/db/repositories.ts`：组合渠道专用 repository；旧 `createChannelMessage` 返回执行权后删除。
- `src/server/agent/run-agent.ts`：接受可选 `ExecutionJournal`，工具/搜索/LLM 调用有稳定 step key。
- `src/agent-service/index.ts`：启动/停止 Connection Manager、Event Worker 和 Delivery Worker。
- `src/app/api/webhooks/telegram/route.ts`、`slack/route.ts`、`feishu/route.ts`、`dingtalk/route.ts`：只验证平台请求、调用 Ingress、返回 ACK。
- `src/server/channels/types.ts`：由 runtime 类型重新导出兼容类型。
- 删除：`src/server/channels/dispatch.ts`、`handler.ts`、`normalize.ts`、`outbound.ts`，确认所有行为迁移后不保留双路径。
- `src/server/config/env.ts`、`.env.example`、`docker-compose.yml`：增加 worker、lease、队列和遗留导入参数。
- 现有 `tests/unit/channel-*.test.ts`、`channels.test.ts`、`repositories-channels.test.ts`：迁移到新合同断言。

### 任务 1：定义 Adapter 与规范化事件边界

**文件：**
- 创建：`src/server/channels/runtime/types.ts`
- 创建：`src/server/channels/runtime/adapter.ts`
- 创建：`src/server/channels/runtime/registry.ts`
- 修改：`src/server/channels/types.ts`
- 创建：`tests/unit/channels/adapter-boundary.test.ts`

- [ ] **步骤 1：编写失败的接口与依赖边界测试**

```ts
it("ChannelAdapter 只暴露平台职责", () => {
  const keys: Array<keyof ChannelAdapter<Record<string, unknown>>> = [
    "manifest", "validateConfig", "start", "stop", "health",
    "normalizeInbound", "acknowledge", "send", "resolveRecipient",
  ];
  expect(keys).toHaveLength(9);
});

it("Adapter 源码不能导入 DigitalMate 大脑", async () => {
  const violations = await scanImports("src/server/channels/adapters", [
    "@/server/agent/run-agent", "@/server/agent/tools/web-search",
    "@/server/evolution", "@/server/skills", "repositories.messages",
  ]);
  expect(violations).toEqual([]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts`

预期：FAIL，新类型和扫描目录尚不存在。

- [ ] **步骤 3：定义完整 Adapter 合同**

```ts
export interface ChannelAdapter<TConfig extends Record<string, unknown>> {
  readonly manifest: ChannelManifest<TConfig>;
  validateConfig(config: unknown): TConfig;
  start(context: ChannelRuntimeContext<TConfig>): Promise<void>;
  stop(reason: "disabled" | "reconfigure" | "shutdown"): Promise<void>;
  health(): Promise<ChannelHealth>;
  normalizeInbound(payload: unknown, context: InboundContext): Promise<NormalizedChannelEvent | null>;
  acknowledge(payload: unknown, result: IngressResult): Promise<PlatformAcknowledgement>;
  send(delivery: ChannelDelivery, context: SendContext<TConfig>): Promise<SendResult>;
  typing?(recipient: ResolvedRecipient, active: boolean): Promise<void>;
  streaming?(delivery: ChannelDelivery, state: StreamingState): Promise<SendResult>;
  resolveRecipient(target: ChannelRecipient): Promise<ResolvedRecipient>;
}
```

- [ ] **步骤 4：定义规范化事件与权限信封**

```ts
export type NormalizedChannelEvent = {
  connectionId: string;
  agentId: string;
  channelType: ChannelType;
  externalEventId: string;
  externalConversationId: string;
  externalSenderId: string;
  chatType: "direct" | "group";
  mentioned: boolean;
  text: string;
  thread: { externalThreadId?: string; replyToEventId?: string };
  attachments: readonly InboundAttachmentDescriptor[];
  occurredAt: Date;
  receivedAt: Date;
  permission: PermissionEnvelope;
  rawSummary: Record<string, string | number | boolean | null>;
  replyHandle?: UnsealedReplyHandle;
};

export type PermissionEnvelope = Readonly<{
  webSearch: false;
  backgroundNetwork: false;
  tools: false;
  skills: "none" | "explicit_slash";
  attachmentsPresent: boolean;
  explicitSkillName?: string;
}>;
```

IM 普通文字永远不会把 `webSearch` 或 `backgroundNetwork` 设为 true；斜杠 Skill 只在无当前/历史附件时由 turn executor 二次批准。

- [ ] **步骤 5：实现强类型 registry**

```ts
export class ChannelAdapterRegistry {
  readonly #factories = new Map<ChannelType, ChannelAdapterFactory>();
  register(type: ChannelType, factory: ChannelAdapterFactory) {
    if (this.#factories.has(type)) throw new Error(`duplicate_channel_adapter:${type}`);
    this.#factories.set(type, factory);
  }
  create(type: ChannelType, dependencies: AdapterDependencies) {
    const factory = this.#factories.get(type);
    if (!factory) throw new Error(`channel_adapter_not_registered:${type}`);
    return factory(dependencies);
  }
}
```

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts && npm run typecheck`

预期：PASS。

```bash
git add src/server/channels/runtime/types.ts src/server/channels/runtime/adapter.ts src/server/channels/runtime/registry.ts src/server/channels/types.ts tests/unit/channels/adapter-boundary.test.ts
git commit -m "feat(P1-13): 定义渠道适配器安全边界"
```

**回滚：** 新类型尚未接生产入口，可整提交回滚。

**完成证据：** TypeScript 接口测试和静态导入边界扫描。

### 任务 2：建立持久事件、执行 journal 与 Delivery schema

**文件：**
- 修改：`src/server/db/schema.sql`
- 创建：`src/server/channels/runtime/event-repository.ts`
- 创建：`src/server/channels/runtime/delivery-repository.ts`
- 创建：`src/server/channels/nodes/repository.ts`
- 修改：`tests/unit/schema.test.ts`
- 创建：`tests/integration/channels/event-claim.test.ts`

- [ ] **步骤 1：编写失败的真实数据库测试**

```ts
it("并发接受同一外部事件只创建一行", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    events.accept(scope, normalizedEvent),
  ));
  expect(results.filter((value) => value.created)).toHaveLength(1);
  expect(new Set(results.map((value) => value.event.id))).toHaveLength(1);
});

it("并发 worker 只 claim 一次", async () => {
  const claims = await Promise.all(Array.from({ length: 8 }, () => events.claimNext("worker-a")));
  expect(claims.filter(Boolean)).toHaveLength(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/integration/channels/event-claim.test.ts tests/unit/schema.test.ts`

预期：FAIL，事件和 Delivery 表不存在。

- [ ] **步骤 3：创建事件和执行步骤表**

```sql
CREATE TABLE IF NOT EXISTS channel_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES digital_agents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  channel_type text NOT NULL,
  external_event_id text NOT NULL,
  external_conversation_id text NOT NULL,
  external_sender_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct','group')),
  normalized_payload jsonb NOT NULL,
  permission_envelope jsonb NOT NULL,
  client_turn_id uuid NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','running','completed','failed')),
  claim_owner text,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  failure_code text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (connection_id, external_event_id),
  UNIQUE (user_id, agent_id, client_turn_id)
);

CREATE TABLE IF NOT EXISTS channel_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES channel_inbound_events(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('llm','search','tool','persist_reply','schedule','delivery')),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed','failed','ambiguous')),
  output jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (event_id, step_key)
);
```

- [ ] **步骤 4：创建回复、附件、访问和发送表**

创建 `channel_event_attachments`（加密 source locator、MIME、size、租约、绑定的私有 attachment ID）、`channel_reply_handles`（公开地址 + AES-GCM secret 部分 + 过期时间）、`channel_deliveries`（event/message/connection 唯一、正文快照、状态、next_attempt_at）、`channel_delivery_attempts`（attempt no、segment no、脱敏平台结果）、`channel_access_rules`、`channel_access_requests`、`channel_runtime_nodes`、`channel_node_bindings`、`channel_node_outbox`。`channel_deliveries` 对 `(connection_id, assistant_message_id)` 建唯一索引。创建 `channel_runtime_nodes` 后再给 `channel_connections.runtime_node_id` 增加外键，引用节点主键并使用 `ON DELETE SET NULL`；迁移测试先验证既有非空值均能解析，避免静默丢绑定。

`channel_execution_steps.output` 和 `channel_delivery_attempts` 的平台结果必须经过结构化脱敏器，只保留 allowlist 字段，序列化后最大 64 KiB；禁止保存 secret、临时令牌、二维码内容、完整供应商原始载荷或模型请求。执行步骤仅在管理员审计 API 中可读，绝不进入聊天消息。

- [ ] **步骤 5：实现稳定 turn ID 与原子 claim**

```ts
export function channelClientTurnId(connectionId: string, externalEventId: string): string {
  const bytes = createHash("sha256").update(`${connectionId}\0${externalEventId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}
```

claim 使用 `FOR UPDATE SKIP LOCKED`，选择 `accepted` 或 lease 已过期的 `running`；同一事务更新 owner、lease、attempts 并返回事件。完成/失败更新必须带 `claim_owner`，防止旧 worker 覆盖新 lease。

- [ ] **步骤 6：运行数据库测试并提交**

运行：`npm test -- --run tests/integration/channels/event-claim.test.ts tests/unit/schema.test.ts`

预期：PASS；并发八次仅一行、一个 claim；不同 connection 可使用相同 external ID；稳定 turn UUID 始终相同。

```bash
git add src/server/db/schema.sql src/server/channels/runtime/event-repository.ts src/server/channels/runtime/delivery-repository.ts src/server/channels/nodes/repository.ts tests/unit/schema.test.ts tests/integration/channels/event-claim.test.ts
git commit -m "feat(P1-13): 建立渠道事件与发送事务账本"
```

**回滚：** 表为增量结构；应用可停止 worker，事件保留，不删除未发送 Delivery。

**完成证据：** 唯一约束、SKIP LOCKED、lease 接管、稳定 turn 和 Delivery 唯一测试。

### 任务 3：实现持久化优先 Ingress 与访问控制

**文件：**
- 创建：`src/server/channels/runtime/access.ts`
- 创建：`src/server/channels/runtime/ingress.ts`
- 创建：`tests/unit/channels/ingress.test.ts`

- [ ] **步骤 1：编写失败的先落库后 ACK 测试**

```ts
it("只有事件提交成功才 ACK accepted", async () => {
  const order: string[] = [];
  const ingress = createIngress({
    acceptEvent: async () => { order.push("persist"); return { created: true, event }; },
    acknowledge: async () => { order.push("ack"); return ack; },
  });
  await ingress.accept(payload);
  expect(order).toEqual(["persist", "ack"]);
});

it("重复事件只 ACK 不创建第二执行", async () => {
  const result = await ingress.accept(payload);
  expect(result).toMatchObject({ created: false, duplicate: true });
  expect(enqueueWorker).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/ingress.test.ts`

预期：FAIL，Ingress 尚不存在。

- [ ] **步骤 3：实现访问决策**

判定顺序固定为：连接 disabled/deleted → DM/group disabled → bot/self event → allowlist/deny → require mention → pending approval。被拒绝事件也保存脱敏诊断但状态直接 failed，绝不进入 Agent；需要确认时创建唯一 `channel_access_request` 并在 Inbox 展示。

- [ ] **步骤 4：实现 Ingress 事务**

```ts
export async function acceptInbound(input: AcceptInboundInput): Promise<IngressResult> {
  const normalized = await input.adapter.normalizeInbound(input.payload, input.context);
  if (!normalized) {
    const ignored: IngressResult = { kind: "ignored" };
    await input.adapter.acknowledge(input.payload, ignored);
    return ignored;
  }
  const access = await input.access.evaluate(normalized);
  const accepted = await input.events.accept(input.scope, normalized, access);
  const result: IngressResult = accepted.created
    ? { kind: access.allowed ? "accepted" : "rejected", eventId: accepted.event.id }
    : { kind: "duplicate", eventId: accepted.event.id };
  await input.adapter.acknowledge(input.payload, result);
  return result;
}
```

平台 ACK 失败只记录连接健康，不删除已持久化事件；重复回调不尝试“恢复”，由 Worker 扫描 accepted/running lease。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/ingress.test.ts`

预期：PASS；持久化失败不 ACK 成功；重复、拒绝、待审批都不 enqueue 第二执行。

```bash
git add src/server/channels/runtime/access.ts src/server/channels/runtime/ingress.ts tests/unit/channels/ingress.test.ts
git commit -m "fix(P1-13): 保证渠道事件落库后再确认"
```

**回滚：** 停止 webhook/连接入口；已接受事件保留给恢复工具，不回退到进程内 `setTimeout`。

**完成证据：** 操作顺序、重复、访问拒绝、pending approval 和 ACK 失败测试。

### 任务 4：实现附件私有化与工具安全门控

**文件：**
- 创建：`src/server/channels/runtime/attachment-ingress.ts`
- 创建：`tests/unit/channels/turn-executor.test.ts`
- 修改：`src/server/attachments/validation.ts`
- 修改：`src/server/attachments/storage.ts`

- [ ] **步骤 1：编写失败的附件红线测试**

```ts
it("当前或历史附件使搜索、Skill 和工具调用均为 0", async () => {
  await executor.execute(eventWithAttachment, { historyHasAttachment: true });
  expect(search).not.toHaveBeenCalled();
  expect(skillLookup).not.toHaveBeenCalled();
  expect(toolInvoke).not.toHaveBeenCalled();
});

it.each(["image/svg+xml", "text/html", "application/zip", "audio/mpeg", "video/mp4"])(
  "拒绝渠道附件 %s", async (mimeType) => {
    await expect(downloadInboundAttachment(descriptor(mimeType))).rejects.toThrow("attachment_type_not_allowed");
  },
);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/turn-executor.test.ts`

预期：FAIL，渠道附件下载和历史门控尚不存在。

- [ ] **步骤 3：实现白名单、租约和私有下载**

只接受 JPEG/PNG/WebP/PDF/TXT/MD/JSON/CSV；先根据 manifest 限制 HEAD/metadata size，再流式下载到临时私有文件，验证 magic bytes 与 MIME 后原子移入 `ATTACHMENT_STORAGE_DIR`。平台 URL/token 以加密 locator 短期保存，绑定成功立即清除；错误响应不包含 URL、path、文本或 base64。

- [ ] **步骤 4：实现统一 attachment tool guard**

Event Worker 在运行前查询当前 event attachments 和最近 12 条历史消息 attachments，传给 `runAgent`：

```ts
const attachmentToolGuard = currentAttachments.length > 0 || historicalAttachments.length > 0;
const explicitSkillIds = attachmentToolGuard ? [] : await resolveExplicitSkills(event);
const searchGate = createSearchGate({ userMessage: event.text, userEnabled: false, aggressiveness });
```

Voice/SIP 的 audio descriptor 不进入此函数；它们的 Adapter 只能提交转写文本与 `attachments: []`。

- [ ] **步骤 5：运行附件和聊天回归**

运行：`npm test -- --run tests/unit/channels/turn-executor.test.ts tests/unit/attachment-validation.test.ts tests/unit/chat-route.test.ts`

预期：PASS；当前/历史附件的 search/Skill/tool 都是 0。

- [ ] **步骤 6：提交附件边界**

```bash
git add src/server/channels/runtime/attachment-ingress.ts src/server/attachments/validation.ts src/server/attachments/storage.ts tests/unit/channels/turn-executor.test.ts
git commit -m "feat(P1-13): 统一渠道附件与工具安全边界"
```

**回滚：** 可临时让渠道拒绝全部附件；不得回退为公开 URL 直传模型。

**完成证据：** 白名单、magic bytes、size、租约、路径隐私和工具 0 调用测试。

### 任务 5：实现一次 Agent turn 与崩溃恢复合同

**文件：**
- 创建：`src/server/channels/runtime/execution-journal.ts`
- 创建：`src/server/channels/runtime/turn-executor.ts`
- 创建：`src/server/channels/runtime/event-worker.ts`
- 修改：`src/server/agent/run-agent.ts`
- 修改：`tests/unit/channels/turn-executor.test.ts`
- 修改：`tests/integration/channels/end-to-end.test.ts`

- [ ] **步骤 1：编写失败的单执行与崩溃测试**

```ts
it("Agent 开始后崩溃不再次调用 LLM", async () => {
  await expect(worker.runOne({ crashAfter: "llm_started" })).rejects.toThrow("fault_injected");
  await expireLease(eventId);
  await worker.runOne();
  expect(llm.stream).toHaveBeenCalledTimes(1);
  expect(await assistantMessages(clientTurnId)).toHaveLength(1);
  expect((await assistantMessages(clientTurnId))[0].content).toContain("没能完整回复");
});

it("八个 worker 对同一事件只运行一次 Agent", async () => {
  await Promise.all(Array.from({ length: 8 }, () => worker.runOne()));
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(await assistantMessages(clientTurnId)).toHaveLength(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/turn-executor.test.ts tests/integration/channels/end-to-end.test.ts`

预期：FAIL，Worker 和 journal 尚不存在。

- [ ] **步骤 3：给 Agent 调用增加 journal 接口**

```ts
export interface ExecutionJournal {
  begin(step: { key: string; kind: "llm" | "search" | "tool"; requestHash: string }): Promise<"run" | "reuse" | "ambiguous">;
  complete(stepKey: string, output: unknown): Promise<void>;
  fail(stepKey: string, code: string): Promise<void>;
  read<T>(stepKey: string): Promise<T | null>;
}
```

`runAgent` 为每轮 LLM 使用 `llm:${round}`，搜索使用 `search:${round}:${sha256(query)}`，工具使用 `tool:${round}:${index}:${sha256(name+canonicalArgs)}`。`reuse` 读取已完成输出；`ambiguous` 不重放外部副作用并返回稳定工具失败结果。

- [ ] **步骤 4：复用消息 turn claim**

Turn Executor 先 `createIdempotentUserTurn(scope, clientTurnId, payloadHash)`，再取得 advisory lock 并调用 `claimClientTurnExecution`。若 claim 已经开始且没有 assistant，创建现有 Web 合同相同的稳定降级助手消息，不再次运行 Agent。正常完成使用 `createIdempotentAssistantTurn`；提醒/跟进、反思和 Delivery 只在 `assistantTurn.created` 时创建。

- [ ] **步骤 5：实现 Worker lease 处理**

```ts
export async function processClaimedEvent(claim: ClaimedEvent, deps: EventWorkerDeps) {
  try {
    const result = await deps.turnExecutor.execute(claim);
    await deps.events.complete(claim, result.assistantMessageId);
  } catch (error) {
    const code = toStableChannelError(error);
    await deps.events.fail(claim, code);
    throw error;
  }
}
```

事件在 assistant 和唯一 Delivery 同一事务创建后才标 completed；进程在 commit 后崩溃，恢复只发现 completed/queued delivery，不再运行 Agent。

- [ ] **步骤 6：运行故障注入矩阵**

运行：`npm test -- --run tests/unit/channels/turn-executor.test.ts tests/integration/channels/end-to-end.test.ts`

预期：PASS；故障点覆盖 accept 后、claim 后、LLM started 后、assistant insert 后、delivery insert 后；每点都只有一个 user、一个 assistant、最多一个 LLM 和一个 Delivery。

- [ ] **步骤 7：提交执行链**

```bash
git add src/server/channels/runtime/execution-journal.ts src/server/channels/runtime/turn-executor.ts src/server/channels/runtime/event-worker.ts src/server/agent/run-agent.ts tests/unit/channels/turn-executor.test.ts tests/integration/channels/end-to-end.test.ts
git commit -m "fix(P1-13): 保证渠道 Agent 单次执行与恢复"
```

**回滚：** 停止 Event Worker；保留 accepted 事件。不得恢复旧 handler 直接调用 Agent。

**完成证据：** 五故障点、八 worker 并发、journal reuse/ambiguous 和单助手消息测试。

### 任务 6：实现只重试发送的 Delivery Worker

**文件：**
- 创建：`src/server/channels/runtime/retry.ts`
- 创建：`src/server/channels/runtime/delivery-worker.ts`
- 创建：`tests/unit/channels/delivery-worker.test.ts`

- [ ] **步骤 1：编写失败的发送重试测试**

```ts
it("发送失败三次只调用一次 Agent", async () => {
  send.mockRejectedValueOnce(rateLimited(2)).mockRejectedValueOnce(new Error("network")).mockResolvedValue(ok);
  await deliveryWorker.drainUntilIdle(clock);
  expect(send).toHaveBeenCalledTimes(3);
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(await assistantMessages(clientTurnId)).toHaveLength(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/delivery-worker.test.ts`

预期：FAIL，Delivery Worker 尚不存在。

- [ ] **步骤 3：实现退避函数**

```ts
export function nextRetryAt(input: { attempt: number; now: Date; retryAfterMs?: number; random: number }) {
  const exponential = Math.min(300_000, 1_000 * 2 ** Math.max(0, input.attempt - 1));
  const withJitter = Math.round(exponential * (0.8 + input.random * 0.4));
  return new Date(input.now.getTime() + Math.max(input.retryAfterMs ?? 0, withJitter));
}
```

- [ ] **步骤 4：实现发送、分段和死信**

Worker claim queued/retry Delivery，读取已经持久化的 `body`，按 cadence 生成确定性 segments；每个 segment 有 `(delivery_id, segment_no, attempt_no)` 记录。平台支持 streaming 时只更新同一平台消息；不支持时可分段发送，但数据库仍只有一条 assistant。达到 8 次或不可重试凭据错误进入 dead_letter；人工“重新发送”只把同一 Delivery 重新排队。

- [ ] **步骤 5：运行发送测试并提交**

运行：`npm test -- --run tests/unit/channels/delivery-worker.test.ts`

预期：PASS；Retry-After 优先；stop 后无新发送；死信可重排但不调用 Agent。

```bash
git add src/server/channels/runtime/retry.ts src/server/channels/runtime/delivery-worker.ts tests/unit/channels/delivery-worker.test.ts
git commit -m "feat(P1-13): 分离渠道回复生成与发送重试"
```

**回滚：** 停止 Delivery Worker，queued/dead-letter 数据保留；不删除助手消息。

**完成证据：** 限流、网络、凭据、分段、死信和人工重排测试。

### 任务 7：实现连接管理、热更新和健康状态

**文件：**
- 创建：`src/server/channels/runtime/connection-manager.ts`
- 创建：`tests/unit/channels/connection-manager.test.ts`
- 修改：`src/server/admin/compat/handlers/channels.ts`
- 修改：`src/server/admin/compat/register-core.ts`

- [ ] **步骤 1：编写失败的生命周期测试**

```ts
it("revision 更新只重启目标连接", async () => {
  await manager.startAll();
  await manager.onConfigChanged({ connectionId: connectionA, revision: 2 });
  expect(adapters.get(connectionA)?.stop).toHaveBeenCalledWith("reconfigure");
  expect(adapters.get(connectionA)?.start).toHaveBeenCalledTimes(2);
  expect(adapters.get(connectionB)?.start).toHaveBeenCalledTimes(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/connection-manager.test.ts`

预期：FAIL，manager 尚不存在。

- [ ] **步骤 3：实现幂等 start/stop 与 LISTEN-NOTIFY**

Manager 启动时读取 enabled connections；每连接只有一个 state machine。配置事务 commit 后 `pg_notify('channel_config_changed', JSON)`；Manager 验证 revision 变大，先等 stop 完成再用新 config start。新凭据失败保持新 config 并标 degraded，不静默恢复旧 secret。

- [ ] **步骤 4：实现统一健康映射**

Adapter 原始错误映射为 `credential_invalid`、`permission_denied`、`network_unreachable`、`rate_limited`、`runtime_prerequisite_missing`；详情去除 token、URL query 和平台原始 body。Console health 返回最近连接/事件/错误、重连次数和下次尝试时间。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/connection-manager.test.ts tests/unit/admin-compat-channels.test.ts`

预期：PASS；并发 start/stop 幂等；只重启目标；旧 revision 忽略；shutdown 等待所有 adapter stop。

```bash
git add src/server/channels/runtime/connection-manager.ts src/server/admin/compat/handlers/channels.ts src/server/admin/compat/register-core.ts tests/unit/channels/connection-manager.test.ts
git commit -m "feat(P1-13): 管理渠道热更新与健康状态"
```

**回滚：** 关闭所有连接后停止 manager；数据库配置和健康历史保留。

**完成证据：** lifecycle、revision、degraded、redaction、退避和 graceful shutdown 测试。

### 任务 8：定义受限渠道运行节点协议

**文件：**
- 创建：`src/server/channels/nodes/protocol.ts`
- 创建：`src/server/channels/nodes/repository.ts`
- 创建：`tests/unit/channels/node-protocol.test.ts`

- [ ] **步骤 1：编写失败的 frame 和绑定测试**

```ts
it("节点不能替未绑定连接发送事件", async () => {
  const frame = parseNodeFrame({ type: "inbound", connectionId: unboundId, sequence: 7, payload: {} });
  await expect(authorizeNodeFrame(node, frame)).rejects.toThrow("node_connection_not_bound");
});

it("协议中不存在 Agent、memory、search 或 tool 指令", () => {
  expect(NODE_FRAME_TYPES).toEqual(["register", "registered", "heartbeat", "inbound", "inbound_ack", "send", "send_result", "error"]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/node-protocol.test.ts`

预期：FAIL，协议尚不存在。

- [ ] **步骤 3：实现严格 Zod frame schema**

所有 frame 含 `protocolVersion:1`、`nodeId`、单调 `sequence`、`sentAt`；register 提交证书指纹和 supported channel types；中心只下发已绑定 connection 的 send；inbound 使用相同事件 Ingress。未知字段和未知 type 拒绝，payload 上限 1 MiB。

- [ ] **步骤 4：实现有界 outbox**

每节点最多 1000 条或 50 MiB，先到期先失败；节点离线时 Delivery 进入 `waiting_node`，不生成第二回复。heartbeat 超过 45 秒标 disconnected，超过 24 小时仍保留 Delivery 但不无限增加 outbox。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/node-protocol.test.ts`

预期：PASS；越权连接、重放 sequence、超大 frame、过期心跳和队列上限均拒绝。

```bash
git add src/server/channels/nodes/protocol.ts src/server/channels/nodes/repository.ts tests/unit/channels/node-protocol.test.ts
git commit -m "feat(P1-13): 定义受限渠道运行节点协议"
```

**回滚：** 不启动节点 gateway 即可；表和绑定记录保留。

**完成证据：** frame 白名单、连接绑定、sequence、防重放、大小和队列测试。

### 任务 9：把现有四渠道迁移到统一运行时

**文件：**
- 创建：`src/server/channels/adapters/webhook/telegram.ts`
- 创建：`src/server/channels/adapters/webhook/slack.ts`
- 创建：`src/server/channels/adapters/webhook/feishu.ts`
- 创建：`src/server/channels/adapters/webhook/dingtalk.ts`
- 创建：`src/server/channels/runtime/legacy-env-import.ts`
- 修改：`src/app/api/webhooks/telegram/route.ts`
- 修改：`src/app/api/webhooks/slack/route.ts`
- 修改：`src/app/api/webhooks/feishu/route.ts`
- 修改：`src/app/api/webhooks/dingtalk/route.ts`
- 修改：`src/agent-service/index.ts`
- 删除：`src/server/channels/dispatch.ts`
- 删除：`src/server/channels/handler.ts`
- 删除：`src/server/channels/normalize.ts`
- 删除：`src/server/channels/outbound.ts`
- 修改：现有 `tests/unit/channel-handler.test.ts`、`channel-outbound.test.ts`、`channel-webhook-routes.test.ts`、`channels.test.ts`、`repositories-channels.test.ts`

- [ ] **步骤 1：改写失败的 webhook 合同测试**

```ts
it.each(["telegram", "slack", "feishu", "dingtalk"])(
  "%s webhook 只持久化与 ACK，不直接运行 Agent", async (channel) => {
    const response = await postSignedFixture(channel);
    expect(response.status).toBeLessThan(300);
    expect(events.accept).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channel-webhook-routes.test.ts`

预期：FAIL，现有 route 使用 `scheduleChannelMessageHandling` 直接触发 Agent。

- [ ] **步骤 3：实现四个过渡 Adapter**

保留现有签名验证和 payload 解析语义，但输出新的 `NormalizedChannelEvent`，`rawSummary` 只保留 event type、平台 message ID 和必要布尔值；DingTalk `sessionWebhook` 进入加密 reply handle，不写 raw payload。每个 route 等待 `events.accept` commit 后立即返回平台 ACK。

- [ ] **步骤 4：导入现有环境配置一次**

启动时若默认分身对应 channel type 没有 connection，读取现有四渠道 env，使用 M2 secret service 创建 disabled connection；只有显式 `CHANNEL_IMPORT_LEGACY_ENABLED=1` 才启用。导入审计来源为 `legacy_env_import`，日志只写字段是否存在。

- [ ] **步骤 5：接入 Agent service 生命周期**

```ts
const channelRuntime = await startChannelRuntime({ repositories, env, shutdown: shutdown.signal });
try {
  await runSchedulerLoop(repositories, shutdown.signal);
} finally {
  await channelRuntime.stop();
}
```

`startChannelRuntime` 依次启动 manager、event worker、delivery worker；停止顺序为停止接收 → 释放未开始 lease → 等待正在提交事务 → 停 delivery → 关连接。

- [ ] **步骤 6：删除旧双写路径并运行静态扫描**

运行：`rg -n "scheduleChannelMessageHandling|handleChannelMessage|sendChannelMessage|setTimeout\(.*processChannel" src`

预期：无命中；所有 webhook 只依赖 Ingress。

- [ ] **步骤 7：运行四渠道与 Agent service 回归**

运行：`npm test -- --run tests/unit/channel-webhook-routes.test.ts tests/unit/channels tests/unit/agent-service-shutdown.test.ts tests/integration/channels/end-to-end.test.ts`

预期：PASS；同一 webhook 重放八次只运行一次 Agent、写一条 assistant、创建一个 Delivery。

- [ ] **步骤 8：提交迁移**

```bash
git add src/server/channels/runtime/legacy-env-import.ts src/server/channels/adapters/webhook src/server/channels/dispatch.ts src/server/channels/handler.ts src/server/channels/normalize.ts src/server/channels/outbound.ts src/server/db/repositories.ts src/app/api/webhooks/telegram/route.ts src/app/api/webhooks/slack/route.ts src/app/api/webhooks/feishu/route.ts src/app/api/webhooks/dingtalk/route.ts src/agent-service/index.ts src/server/config/env.ts .env.example docker-compose.yml tests/unit/channel-webhook-routes.test.ts tests/unit/channels.test.ts tests/unit/repositories-channels.test.ts tests/unit/channel-handler.test.ts tests/unit/agent-service-shutdown.test.ts tests/integration/channels/end-to-end.test.ts
git commit -m "fix(P1-13): 迁移现有四渠道到事务运行时"
```

**回滚：** 停止四个连接或 agent service；不能恢复已删除的直接 Agent 路径。已接收事件可在修复后由 Worker 继续。

**完成证据：** 四平台签名、ACK 时限、重复八次、重启、graceful shutdown 和无旧路径扫描。

### 任务 10：M3 故障注入与产品红线总验证

**文件：**
- 创建：`docs/verification/channel-runtime-m3.md`
- 修改：本计划涉及测试夹具。

- [ ] **步骤 1：运行事务与故障注入套件**

```bash
npm test -- --run tests/unit/channels tests/integration/channels
npm test -- --run tests/unit/channel-webhook-routes.test.ts tests/unit/proactive-delivery.test.ts tests/unit/search-gate.test.ts tests/unit/chat-route.test.ts
```

预期：全部 PASS。

- [ ] **步骤 2：逐项记录强制红线结果**

在 `docs/verification/channel-runtime-m3.md` 记录并附测试名：普通问候 0 搜索；未授权实时问题 0 搜索；当前/历史附件 0 搜索/Skill/工具；遗留无授权分享 0 投递；同一主动任务 1 可见消息；同一外部事件 1 Agent/1 assistant/1 Delivery；搜索原始结果不写 messages；群聊插话遵守频率/静默/退避；跨 agent 无读取。

- [ ] **步骤 3：运行全仓验证与边界扫描**

```bash
npm run typecheck
npm test
npm run build
rg -n "runAgent|web-search|repositories\.memories|repositories\.messages" src/server/channels/adapters
git diff --check
```

预期：前三项 PASS；Adapter 扫描无命中；`git diff --check` 无输出。

- [ ] **步骤 4：里程碑提交**

```bash
git add docs/verification/channel-runtime-m3.md
git commit -m "chore(P1-13): 完成渠道事务运行时 M3 验收"
```

**回滚：** 所有连接可单独禁用；Web 首页继续工作；事件与 Delivery 账本保留。

**完成证据：** `docs/verification/channel-runtime-m3.md`、自动化报告和静态边界扫描。
