# 七个标准 IM 渠道实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M4-A：在统一运行时上实现 Telegram、Discord、Slack、Mattermost、飞书、钉钉和 QQ 官方机器人，并达到 QwenPaw `v2.0.0.post3` 的配置与核心交互覆盖。

**架构：** 每个渠道由小型 config/normalize/transport/index 模块组成并复用 M3 合同测试；长连接由 Connection Manager 托管，平台事件一律进入 Ingress。平台 SDK 只存在于 Adapter 内，任何平台发送、输入状态或 streaming 都消费既有 Delivery。

**技术栈：** TypeScript、Telegram Bot HTTP API、Discord Gateway、Slack Socket Mode、Mattermost WebSocket/REST、飞书 WebSocket/OpenAPI、钉钉 Stream、QQ Gateway/HTTP、Vitest。

---

## 文件结构

**创建：**

- `src/server/channels/testing/contract.ts`：所有渠道必须通过的统一 Adapter 合同。
- `src/server/channels/testing/fixtures.ts`：确定性 clock、fake socket、fake HTTP、连接和事件 fixture。
- `src/server/channels/adapters/telegram/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/discord/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/slack/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/mattermost/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/feishu/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/dingtalk/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/qq/{config,normalize,transport,index}.ts`
- `tests/unit/channels/adapters/{telegram,discord,slack,mattermost,feishu,dingtalk,qq}.test.ts`
- `tests/fixtures/channels/{telegram,discord,slack,mattermost,feishu,dingtalk,qq}/*.json`：脱敏入站、ACK、发送、限流和错误样本。
- `docs/channels/{telegram,discord,slack,mattermost,feishu,dingtalk,qq}.md`：配置、权限、网络、限制和 smoke 清单。
- `docs/verification/channels-standard-m4a.md`：七渠道自动化和外部验收状态。
- `docs/verification/qwenpaw-channel-parity.md`：固定上游源文件、配置、测试到 DigitalMate 实现的逐渠道对照账本。
- `scripts/qwenpaw-console/audit-channel-parity.mjs`：校验上游身份、引用文件哈希、渠道集合和账本证据。

**修改：**

- `package.json`、`package-lock.json`：固定平台 SDK/协议依赖。
- `src/server/channels/runtime/registry.ts`：注册七个 Adapter 工厂。
- `src/server/channels/manifests/catalog.ts`：以实现约束校准字段、secret、capability 和 prerequisite。
- `src/agent-service/index.ts`：不改业务逻辑，只通过 registry 启动新增连接。
- `docker-compose.yml`、`.env.example`：只加入代理/网络级默认值，不为每条连接复制 secret env。
- `patches/qwenpaw-console/0004-api-compat.patch`：Channels 卡片显示准确 health、blocked prerequisite 和只读 filter。

### 任务 1：建立七渠道统一合同和固定依赖

**文件：**
- 创建：`src/server/channels/testing/contract.ts`
- 创建：`src/server/channels/testing/fixtures.ts`
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`tests/unit/channels/adapter-boundary.test.ts`

- [ ] **步骤 1：编写失败的合同 harness 自测**

```ts
export function defineChannelContract(input: ChannelContractInput) {
  describe(`${input.type} ChannelAdapter contract`, () => {
    it("validates config and never returns secret values", input.assertConfig);
    it("starts and stops idempotently", input.assertLifecycle);
    it("normalizes direct, group, mention and thread events", input.assertInbound);
    it("uses stable external event ids", input.assertStableIds);
    it("sends persisted deliveries and resolves recipients", input.assertOutbound);
    it("maps rate limit, auth, permission and network health", input.assertHealth);
    it("honors abort and closes sockets/timers", input.assertShutdown);
  });
}
```

自测传入一个故意生成随机 event ID 的 fake adapter，预期 `assertStableIds` 失败；改为固定 ID 后通过，证明 harness 能发现缺陷。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts`

预期：FAIL，contract harness 尚不存在。

- [ ] **步骤 3：实现 fixture 与平台边界断言**

fake HTTP 记录 method/url/headers/body 并可返回 200、401、403、429、500；fake socket 支持 open/message/error/close、ping/pong 和 abort；clock 控制 reconnect 与 polling。合同额外运行 M3 Ingress 重放两次，断言 Adapter 不直接调用 Agent。

- [ ] **步骤 4：固定经审计的依赖版本**

运行：

```bash
npm install --save-exact ws@8.21.1 discord.js@14.27.0 @slack/bolt@5.0.0 @larksuiteoapi/node-sdk@1.71.1 dingtalk-stream-sdk-nodejs@2.0.4
npm install --save-dev --save-exact @types/ws@8.18.1
```

预期：lockfile 固定确切版本；许可证分别为 MIT、Apache-2.0 或上游声明的兼容许可证；`npm audit --omit=dev` 不含 high/critical 未处置项。若 registry 返回版本或许可证与此处不一致，停止本计划并更新规格评审记录，不静默换包。

- [ ] **步骤 5：运行 harness 与边界扫描**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts && npm run typecheck`

预期：PASS。

- [ ] **步骤 6：提交合同和依赖**

```bash
git add src/server/channels/testing tests/unit/channels/adapter-boundary.test.ts package.json package-lock.json
git commit -m "test(P1-13): 建立标准渠道适配合同"
```

**回滚：** 删除未被 Adapter 使用的依赖和 harness；M3 不受影响。

**完成证据：** harness 自测、依赖锁、许可证和 audit 报告。

### 任务 2：实现 Telegram Bot API 长轮询

**文件：**
- 创建：`src/server/channels/adapters/telegram/config.ts`
- 创建：`src/server/channels/adapters/telegram/normalize.ts`
- 创建：`src/server/channels/adapters/telegram/transport.ts`
- 创建：`src/server/channels/adapters/telegram/index.ts`
- 创建：`tests/unit/channels/adapters/telegram.test.ts`
- 创建：`tests/fixtures/channels/telegram/*.json`
- 创建：`docs/channels/telegram.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Telegram 合同**

```ts
defineChannelContract(telegramContract({
  config: { enabled: true, bot_token: "secret", streaming_enabled: true, show_typing: true },
  directFixture: "update-direct.json",
  groupFixture: "update-group-mention.json",
  expectedEventId: "update:90001",
  expectedRecipient: { chatId: "-100123", replyToMessageId: 77 },
}));
```

补充：`getUpdates` offset 只在事件持久化成功后推进；409 polling conflict 进入 degraded 并退避；401 不重试；HTML output 转义；输入状态调用 `sendChatAction`；streaming 用 `sendMessage` 后 `editMessageText`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/telegram.test.ts`

预期：FAIL，Telegram Adapter 未注册。

- [ ] **步骤 3：实现配置与稳定规范化**

```ts
export const telegramConfigSchema = baseChannelConfigSchema.extend({
  bot_token: z.string().min(1),
  base_url: z.string().url().or(z.literal("")),
  http_proxy: z.string().url().or(z.literal("")),
  http_proxy_auth: z.string(),
  show_typing: z.boolean().nullable(),
  streaming_enabled: z.boolean(),
});

export function telegramEventId(update: TelegramUpdate) {
  return `update:${update.update_id}`;
}
```

- [ ] **步骤 4：实现长轮询与发送语义**

Transport 调 `getMe` 验证 token；`getUpdates?timeout=30&allowed_updates=message,edited_message,callback_query`；每个 update 逐个交 Ingress，ACK/commit 后更新内存 offset，重启时 offset 从最近持久事件的 update ID 恢复。下载附件先 `getFile`，平台文件 URL只交加密 locator。主动发送从 `channel_reply_handles` 解析 chat/thread，不从最近 raw payload 猜。

- [ ] **步骤 5：运行合同、重复和关闭测试**

运行：`npm test -- --run tests/unit/channels/adapters/telegram.test.ts tests/integration/channels/end-to-end.test.ts`

预期：PASS；同 update 两轮 polling 只执行一次；stop 中止长轮询；token 不出现在错误和快照。

- [ ] **步骤 6：提交 Telegram**

```bash
git add src/server/channels/adapters/telegram src/server/channels/runtime/registry.ts tests/unit/channels/adapters/telegram.test.ts tests/fixtures/channels/telegram docs/channels/telegram.md
git commit -m "feat(P1-13): 接入 Telegram 长轮询渠道"
```

**回滚：** 单独 disable Telegram connection；旧 webhook Adapter 在迁移稳定期可保留代码但不能与 polling 同时启用同一 token。

**完成证据：** token 验证、offset、DM/group/@、附件 locator、typing、streaming、409/401 和 stop 测试。

### 任务 3：实现 Discord Gateway

**文件：**
- 创建：`src/server/channels/adapters/discord/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/discord.test.ts`
- 创建：`tests/fixtures/channels/discord/*.json`
- 创建：`docs/channels/discord.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Discord 合同**

```ts
defineChannelContract(discordContract({
  expectedEventId: "message:1200456",
  ignoreBotAuthor: true,
  intents: ["Guilds", "GuildMessages", "DirectMessages", "MessageContent"],
  streamingMode: "edit-reply",
}));
```

测试 DM、guild、@bot、thread、reply、bot/self ignore、proxy、attachment metadata、typing、429 retry_after 和 invalid token。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/discord.test.ts`

预期：FAIL，Discord Adapter 未实现。

- [ ] **步骤 3：实现配置与事件映射**

```ts
export const discordConfigSchema = baseChannelConfigSchema.extend({
  bot_token: z.string().min(1),
  http_proxy: z.string(),
  http_proxy_auth: z.string(),
  accept_bot_messages: z.boolean(),
  streaming_enabled: z.boolean(),
});
```

事件 ID 为 `message:${message.id}`，conversation 为 thread ID 或 channel ID，sender 为 author ID；只有 `accept_bot_messages=true` 且不是当前 bot 才接受其他 bot 消息。

- [ ] **步骤 4：实现 discord.js 生命周期和发送**

Client 由 AbortSignal 驱动 login/destroy；ready 后 connected；invalid intents/permission 标 blocked 或 degraded。发送使用 `channel.send({content,reply})`，typing 使用 `sendTyping()`；streaming 创建一条消息并按最小 500ms 间隔 edit，最终内容来自 Delivery 完整正文。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/discord.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/discord src/server/channels/runtime/registry.ts tests/unit/channels/adapters/discord.test.ts tests/fixtures/channels/discord docs/channels/discord.md
git commit -m "feat(P1-13): 接入 Discord Gateway 渠道"
```

**回滚：** disable Discord connection 并销毁 client；不影响其他 Adapter。

**完成证据：** intents、DM/guild/thread/reply、bot ignore、typing/edit、proxy、429 和权限健康测试。

### 任务 4：实现 Slack Socket Mode

**文件：**
- 创建：`src/server/channels/adapters/slack/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/slack.test.ts`
- 创建：`tests/fixtures/channels/slack/*.json`
- 创建：`docs/channels/slack.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Slack 合同**

```ts
defineChannelContract(slackContract({
  expectedEventId: "event:Ev123:1712345.100",
  requiredSecrets: ["bot_token", "app_token"],
  groupRequiresMentionByDefault: true,
  streamingMode: "chat.update",
}));
```

覆盖 Socket Mode envelope ACK 在 3 秒内、event_id + event.ts 稳定 ID、DM/channel/thread、message_changed 忽略、bot_id 忽略、file_share locator、typing 明确不支持、chat.postMessage/update、ratelimited retry-after。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/slack.test.ts`

预期：FAIL，Slack Socket Adapter 未实现。

- [ ] **步骤 3：实现配置和 ACK 分层**

```ts
export const slackConfigSchema = baseChannelConfigSchema.extend({
  bot_token: z.string().startsWith("xoxb-"),
  app_token: z.string().startsWith("xapp-"),
  proxy: z.string().url().nullable(),
  streaming_enabled: z.boolean(),
  require_mention: z.boolean().default(true),
});
```

Socket envelope 的协议 ACK 可在事件 durable insert 后立即发；业务回复永远走 Delivery。`externalEventId` 优先 `event_id`，附加 `event.ts` 防止多 message envelope 混淆。

- [ ] **步骤 4：实现 Bolt 生命周期与发送**

使用 `App` + `SocketModeReceiver`，禁用 Bolt 内置 processBeforeResponse 业务处理，只在 listener 中调用 Ingress。thread reply 保留 `thread_ts`；streaming 先 post 再 update；Slack 不提供可靠 typing API，manifest `typing=false` 且 Console 显示准确降级。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/slack.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/slack src/server/channels/runtime/registry.ts tests/unit/channels/adapters/slack.test.ts tests/fixtures/channels/slack docs/channels/slack.md
git commit -m "feat(P1-13): 接入 Slack Socket Mode 渠道"
```

**回滚：** stop Socket receiver 并 disable connection；M3 webhook route 不与 Socket Mode 同时消费同一 App。

**完成证据：** 3 秒 ACK、event dedup、thread、file locator、chat.update、429 和 typing 降级测试。

### 任务 5：实现 Mattermost WebSocket 与 REST

**文件：**
- 创建：`src/server/channels/adapters/mattermost/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/mattermost.test.ts`
- 创建：`tests/fixtures/channels/mattermost/*.json`
- 创建：`docs/channels/mattermost.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Mattermost 合同**

```ts
defineChannelContract(mattermostContract({
  expectedEventId: "post:post-123",
  websocketPath: "/api/v4/websocket",
  restPostPath: "/api/v4/posts",
  threadFollowWithoutMention: true,
}));
```

覆盖 posted event、DM/team channel、root_id thread、@username、self user ignore、重连 sequence、typing endpoint、文件 metadata、401/403/429。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/mattermost.test.ts`

预期：FAIL，Adapter 未实现。

- [ ] **步骤 3：实现配置和 WebSocket 鉴权**

配置含 `url`、`bot_token`、`show_typing`、`thread_follow_without_mention`。启动先 GET `/api/v4/users/me` 获取 bot user ID/username，再连接 `/api/v4/websocket` 并发送 bearer authentication challenge；事件 ID 使用 post ID。

- [ ] **步骤 4：实现 REST 发送和 thread 规则**

Delivery POST `/api/v4/posts`，body 含 channel_id、message、root_id；typing POST `/api/v4/users/{user}/channels/{channel}/typing`。已在 bot 发言 thread 中且配置允许时可不再次 @，但仍经过 group access policy。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/mattermost.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/mattermost src/server/channels/runtime/registry.ts tests/unit/channels/adapters/mattermost.test.ts tests/fixtures/channels/mattermost docs/channels/mattermost.md
git commit -m "feat(P1-13): 接入 Mattermost 渠道"
```

**回滚：** 关闭该 WebSocket 和 connection。

**完成证据：** user discovery、WS auth、DM/channel/thread/@、typing、file metadata 和错误测试。

### 任务 6：实现飞书 WebSocket 与 OpenAPI

**文件：**
- 创建：`src/server/channels/adapters/feishu/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/feishu.test.ts`
- 创建：`tests/fixtures/channels/feishu/*.json`
- 创建：`docs/channels/feishu.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的飞书合同**

```ts
defineChannelContract(feishuContract({
  expectedEventId: "event:9f8e7d",
  domains: ["feishu", "lark"],
  messageTypes: ["text", "image", "file"],
  streamingMode: "cardkit",
}));
```

覆盖 event_id、p2p/group、mention、share_session_in_group、encrypt/verification token、tenant token cache、CardKit streaming、media key locator、domain 切换、OpenAPI code 非 0。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/feishu.test.ts`

预期：FAIL，飞书 Adapter 未实现。

- [ ] **步骤 3：实现配置与事件映射**

配置严格包含 `app_id`、`app_secret`、`encrypt_key`、`verification_token`、`domain`、`streaming_enabled`、`share_session_in_group`。使用 SDK WebSocketClient；external event ID 为 header.event_id，消息 ID放 reply handle；群聊 conversation 依据 share flag 选择 chat_id 或 `chat_id:sender_open_id`。

- [ ] **步骤 4：实现 token cache、发送和 CardKit**

tenant token 在过期前 5 分钟刷新且 single-flight；文本通过 `/im/v1/messages`，reply 用 `/im/v1/messages/{message_id}/reply`；streaming card 建立 card instance 后节流更新，最终完成态关闭 streaming。平台 media token只进入加密 locator。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/feishu.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/feishu src/server/channels/runtime/registry.ts tests/unit/channels/adapters/feishu.test.ts tests/fixtures/channels/feishu docs/channels/feishu.md
git commit -m "feat(P1-13): 接入飞书长连接渠道"
```

**回滚：** stop WebSocketClient 并 disable connection；token cache 清空。

**完成证据：** 双 domain、token single-flight、p2p/group/session、reply/CardKit、media 和 code 错误测试。

### 任务 7：实现钉钉 Stream 与 AI Card

**文件：**
- 创建：`src/server/channels/adapters/dingtalk/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/dingtalk.test.ts`
- 创建：`tests/fixtures/channels/dingtalk/*.json`
- 创建：`docs/channels/dingtalk.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的钉钉合同**

```ts
defineChannelContract(dingtalkContract({
  expectedEventId: "message:msg-1001",
  messageTypes: ["text", "markdown", "ai_card"],
  requiresExitIpForMedia: true,
}));
```

覆盖 Stream ACK、conversationType、at sender、robot_code、sessionWebhook 加密 handle、AI Card template/key、streaming、endpoint、出口 IP blocked health、限流。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/dingtalk.test.ts`

预期：FAIL，钉钉 Stream Adapter 未实现。

- [ ] **步骤 3：实现配置与 Stream client**

配置逐项对应 `client_id`、`client_secret`、`message_type`、`cron_message_type`、`card_template_id`、`card_template_key`、`robot_code`、`card_auto_layout`、`at_sender_on_reply`、`streaming_enabled`、`endpoint`。使用固定 `dingtalk-stream-sdk-nodejs@2.0.4`，callback 内先 Ingress durable commit 再返回成功 ACK。

- [ ] **步骤 4：实现三种发送路径**

优先使用 Stream reply context；sessionWebhook 只以加密 reply handle 存储且随平台过期；主动消息使用 robot_code OpenAPI。markdown 对平台保留格式，AI Card streaming 对同一 card 实例更新；出口 IP拒绝映射 blocked 并给出可操作说明。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/dingtalk.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/dingtalk src/server/channels/runtime/registry.ts tests/unit/channels/adapters/dingtalk.test.ts tests/fixtures/channels/dingtalk docs/channels/dingtalk.md
git commit -m "feat(P1-13): 接入钉钉 Stream 渠道"
```

**回滚：** stop Stream client；过期 reply handles 由租约清理。

**完成证据：** ACK、DM/group、at、三发送路径、Card streaming、secret handle 和 IP blocked 测试。

### 任务 8：实现 QQ 官方机器人 Gateway

**文件：**
- 创建：`src/server/channels/adapters/qq/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/qq.test.ts`
- 创建：`tests/fixtures/channels/qq/*.json`
- 创建：`docs/channels/qq.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 QQ 合同**

```ts
defineChannelContract(qqContract({
  expectedEventId: "event:READY-seq-501-message-88",
  intents: ["DIRECT_MESSAGE", "GROUP_AT_MESSAGE", "C2C_MESSAGE"],
  markdownEnabled: true,
  maxReconnectAttempts: 100,
}));
```

覆盖 access token、gateway URL、Hello/Identify/Heartbeat/Resume、sequence、session ID、DM/group/@、msg_id 被动回复、主动发送、markdown、ack_message、IP/permission blocked 和最大重连。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/qq.test.ts`

预期：FAIL，QQ Adapter 未实现。

- [ ] **步骤 3：实现配置与 Gateway 状态机**

配置包含 `app_id`、`client_secret`、`markdown_enabled`、`max_reconnect_attempts`、`ack_message`。token single-flight；连接官方 gateway 后处理 opcode 10/0/7/9/11，持久化 session ID 与 sequence 到 connection health detail 用于 Resume；event ID 使用平台 event id，缺失时用 `session_id:sequence:message_id`。

- [ ] **步骤 4：实现被动与主动发送**

被动回复携带原 msg_id 与递增 msg_seq，主动发送使用明确 recipient；markdown 只在平台配置允许时发送，否则纯文本降级。重连超过配置次数进入 disconnected，不死循环。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/qq.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/qq src/server/channels/runtime/registry.ts tests/unit/channels/adapters/qq.test.ts tests/fixtures/channels/qq docs/channels/qq.md
git commit -m "feat(P1-13): 接入 QQ 官方机器人渠道"
```

**回滚：** stop Gateway 并 disable connection；session/sequence 保留用于重新启用。

**完成证据：** token、Gateway opcode、resume、DM/group、reply/active、markdown 和重连上限测试。

### 任务 9：M4-A 七渠道总验证

**文件：**
- 创建：`docs/verification/channels-standard-m4a.md`
- 创建：`docs/verification/qwenpaw-channel-parity.md`
- 创建：`scripts/qwenpaw-console/audit-channel-parity.mjs`
- 修改：`src/server/channels/runtime/registry.ts`
- 修改：`tests/unit/admin-compat-channels.test.ts`

- [ ] **步骤 1：断言七个 Adapter 全部注册**

```ts
expect(registry.registeredTypes()).toEqual(expect.arrayContaining([
  "telegram", "discord", "slack", "mattermost", "feishu", "dingtalk", "qq",
]));
```

- [ ] **步骤 2：运行七渠道合同和运行时回归**

```bash
npm test -- --run tests/unit/channels/adapters/telegram.test.ts tests/unit/channels/adapters/discord.test.ts tests/unit/channels/adapters/slack.test.ts tests/unit/channels/adapters/mattermost.test.ts tests/unit/channels/adapters/feishu.test.ts tests/unit/channels/adapters/dingtalk.test.ts tests/unit/channels/adapters/qq.test.ts
npm test -- --run tests/unit/channels tests/integration/channels
```

预期：全部 PASS。

- [ ] **步骤 3：建立固定上游渠道对照账本**

`audit-channel-parity.mjs` 先调用 M1 `verifySnapshot()`，并拒绝不是 tag `v2.0.0.post3` / commit `fef7e64d984f4332d0b84a343cd209bd3ea5d316` 的引用。它只读取 `vendor/qwenpaw-console/reference/src/qwenpaw/app/channels`、两份固定配置文件及 `reference/tests/{unit,contract}/channels`，为每个渠道记录上游源文件集合 SHA-256、配置字段、unit/contract 测试文件、DigitalMate manifest/Adapter/测试/文档、刻意差异及状态。

先写入 Telegram、Discord、Slack、Mattermost、飞书、钉钉、QQ 七行；上游没有某类测试时必须写 `missing_upstream` 并列出本地补齐测试，不能留空。运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require telegram,discord,slack,mattermost,feishu,dingtalk,qq
```

预期：PASS；七行 source hash 与 vendor `SHA256SUMS` 一致，配置字段都有决定，DigitalMate 文件均存在，未知/重复渠道或空证据退出 1。

- [ ] **步骤 4：记录真实平台状态，不伪报可用**

`docs/verification/channels-standard-m4a.md` 对每个渠道记录 `automated_verified`、`pending_external` 或 `smoke_verified`。没有凭据时只能是 `pending_external`；文档列出连接、收、回、重复、重连、拒绝、主动发送、停用八项 smoke。

- [ ] **步骤 5：运行全仓验证和依赖边界扫描**

```bash
npm run typecheck
npm test
npm run build
node scripts/qwenpaw-console/audit-channel-parity.mjs --require telegram,discord,slack,mattermost,feishu,dingtalk,qq
rg -n "runAgent|web-search|repositories\.memories|repositories\.messages" src/server/channels/adapters
git diff --check
```

预期：前三项 PASS；Adapter 边界扫描无命中。

- [ ] **步骤 6：里程碑提交**

```bash
git add docs/verification/channels-standard-m4a.md docs/verification/qwenpaw-channel-parity.md scripts/qwenpaw-console/audit-channel-parity.mjs src/server/channels/runtime/registry.ts tests/unit/admin-compat-channels.test.ts
git commit -m "chore(P1-13): 完成七个标准渠道 M4-A 验收"
```

**回滚：** 七个 connection 可独立 disable；M3 事件、消息和 Delivery 不回滚。

**完成证据：** 七份操作文档、七份合同测试和状态准确的 smoke 矩阵。
