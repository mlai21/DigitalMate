# Slack 渠道

## 配置

在 Slack App 中启用 Socket Mode 和 Event Subscriptions，并在管理后台填写：

- `bot_token`：以 `xoxb-` 开头的 Bot Token。
- `app_token`：以 `xapp-` 开头且具备 `connections:write` 的 App Token。
- `proxy`：可选代理 URL，Socket Mode WebSocket、Slack Web API 和附件下载共用。
- `require_mention`：群聊默认开启，DM 不要求 @。
- `streaming_enabled`：启用后先调用 `chat.postMessage`，后续通过 `chat.update` 编辑同一条消息。

建议订阅 `message.channels`、`message.groups`、`message.im` 和 `message.mpim`，并授予读取消息、发送消息、读取频道历史和读取文件所需的最小 scopes。

## ACK 与事务边界

Socket Mode envelope 不直接触发 Agent。处理顺序固定为：

1. 规范化并将事件以 `event:{event_id}:{event.ts}` 写入统一事件账本。
2. 账本持久化成功后立即发送协议 ACK。
3. 保存 reply handle；如果有附件，使用加密 locator 获取文件并写入私有存储。
4. 只有所有附件绑定完成，事件才从 `pending_attachments` 进入可执行状态。

数据库失败时不 ACK，让 Slack 重投；ACK 后的 Agent 执行和业务回复由独立账本恢复，不会再次执行同一事件。

## 消息与安全

- DM、频道和 thread 分别保留 channel、`thread_ts` 与消息 `ts`。
- `message_changed`、删除事件、Bot 消息和当前 Bot 自己的消息会被忽略。
- `file_share` 只把 `file_id` 写入加密 locator；Bot Token、私有下载 URL和原始 envelope 不写入对话。
- 带附件的事件固定关闭联网、Skill 与其他工具，附件内容不能授权联网。
- Slack 没有可靠的 Bot typing API，因此该渠道不展示 typing 能力；后台不会模拟或误报。

## 限流与恢复

- 无效 Bot/App Token 不重试。
- 缺少 scope 或未加入频道进入权限降级状态。
- `ratelimited` 按 Slack 返回的 `retryAfter` 退避。
- 禁用、重配或关闭服务时停止 Socket receiver 并关闭代理连接池。
- 同一 App 不同时启用旧 webhook 消费和 Socket Mode 消费。

## Smoke 清单

1. 在 DM 发送一条消息，确认协议 ACK 后只产生一次 Agent 执行。
2. 在频道分别发送未 @、@Bot 和 thread reply，确认 mention/thread 路由正确。
3. 上传 TXT 或图片，确认 ACK 快速返回，但 Agent 仅在附件私有化后运行。
4. 开启流式回复，确认只更新同一条 Slack 消息。
5. 临时撤销 `chat:write`，确认健康状态显示权限降级且不泄露 Token。
6. 禁用连接，确认 Socket Mode 会话关闭且旧 webhook 不消费同一 App。
