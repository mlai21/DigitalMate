# Telegram 渠道

## 连接方式

DigitalMate 默认使用 Telegram Bot API 长轮询，不要求公网回调地址。保存并启用连接后会先调用 `getMe` 验证 Bot Token，再开始串行 `getUpdates`。

为了平滑迁移旧部署，若配置了非空 `webhook_secret`，该连接只接受 Webhook，不会同时启动长轮询。同一 Bot Token 不允许同时由两种模式消费。

## 必填配置

| 字段 | 说明 |
| --- | --- |
| `bot_token` | BotFather 签发的 Bot Token，进入加密配置存储 |

常用可选项：

- `base_url`：自建 Telegram Bot API 代理地址；空值使用官方 API。
- `http_proxy`、`http_proxy_auth`：受控代理配置。
- `show_typing`：是否发送 `sendChatAction`；空值采用渠道默认。
- `streaming_enabled`：先发送一条消息，再通过 `editMessageText` 更新。
- `webhook_secret`：只用于旧 Webhook 模式；非空时禁用长轮询。

## Bot 权限与平台设置

- 私聊不需要额外隐私设置。
- 若要读取群内非命令消息，需要在 BotFather 调整 Group Privacy；否则 Telegram 只转发命令、回复和 @Bot 消息。
- 群聊是否必须 @ 仍由 DigitalMate 的 `require_mention` 与访问控制决定，平台收到消息不等于允许 Agent 回复。

## 事务与安全边界

- `externalEventId` 固定为 `update:{update_id}`。
- polling offset 只在 Ingress 完成持久化后推进；数据库失败会保留原 offset。
- Bot、自发消息和不支持的 update 在 Adapter 内忽略，不调用 Agent。
- Telegram `file_id` 仅作为加密附件 locator 保存，公开事件载荷和管理界面不返回下载地址或 Token。
- 普通消息默认关闭联网；当前或历史附件同时关闭联网、Skill 与其他工具。
- 平台发送只消费已持久化 Delivery；发送重试不会重新运行 Agent。

## 错误与限制

- `401`：凭据无效，停止重试并在 Console 标为凭据错误。
- `403`：权限不足，停止重试。
- `409`：同一 Token 存在另一长轮询消费者，标为降级并退避。
- `429`：遵守平台 `retry_after`。
- 长轮询请求可被停用、重配或服务关停的 AbortSignal 中止。
- 文本使用 Telegram HTML 模式发送，`&`、`<`、`>` 会先转义。

## Smoke 清单

真实凭据验收时逐项记录：

1. 启用连接并确认 `getMe` 成功。
2. 私聊发送文本并收到一次回复。
3. 群聊 @Bot 并在原 topic/thread 收到一次回复。
4. 重放同一 update，确认只执行一次 Agent、只出现一条回复。
5. 重启 Agent 服务，确认从最近持久 update 恢复 offset。
6. 发送允许的图片或文本附件，确认文件地址与 Token 不出现在日志和管理 API。
7. 触发或模拟 `401`、`409`、`429`，确认健康状态和退避准确。
8. 禁用连接，确认长轮询立即结束且不再收发。
