# 飞书 / Lark 渠道

## 配置

在飞书开放平台创建企业自建应用，启用机器人能力，并在「事件与回调」中选择「使用长连接接收事件」。订阅 `im.message.receive_v1` 后，在管理后台填写：

- `app_id`：以 `cli_` 开头的应用 ID。
- `app_secret`：应用密钥。
- `encrypt_key`、`verification_token`：与开放平台事件配置一致；平台未配置时可留空。
- `domain`：中国大陆飞书选 `feishu`，Lark 选 `lark`。
- `streaming_enabled`：使用 CardKit 卡片流式更新同一条回复。
- `share_session_in_group`：关闭时，同一群内不同成员使用隔离会话；开启时共享群会话。

应用至少需要读取消息、发送消息、获取消息资源和使用 CardKit 的权限。DigitalMate 不再通过旧飞书 Webhook 消费业务事件；旧地址只保留验签和 URL challenge 兼容，避免 WebSocket 与 Webhook 抢占同一消息。

## 连接与路由

启动时先换取 `tenant_access_token`，调用 `/bot/v3/info` 验证应用并取得机器人 `open_id`，随后等待 WebSocket 首次握手成功。SDK 负责断线重连；禁用、重配或关闭服务时会关闭连接并清空内存 Token 缓存。

- 入站事件使用平台 `event_id` 形成幂等键 `event:{event_id}`。
- 私聊按 `chat_id` 路由。
- 群聊默认按 `chat_id:sender_open_id` 隔离；开启共享会话后按 `chat_id` 路由。
- 当前机器人自己发送的消息会被忽略。
- 群消息通过 mention 中的机器人 `open_id` 判断是否被 @，访问策略仍由统一渠道权限层执行。
- `message_id` 只作为 reply handle 的公开路由字段保存，回复通过 `/im/v1/messages/{message_id}/reply` 回到原消息。

## 附件与安全

第一期接收 `image` 和 `file` 消息。`image_key` / `file_key` 与 `message_id` 只进入加密 locator；系统使用 `/im/v1/messages/{message_id}/resources/{key}` 下载到 DigitalMate 私有存储，全部附件绑定成功前事件不可执行。

App Secret、Tenant Token、媒体 key、原始事件和下载响应不会写入对话或健康状态。带附件的消息固定关闭联网、Skill 和其他工具；附件正文不能授予联网权限。

## 发送、CardKit 与错误

- 普通回复发送 `text` 消息。
- 开启流式回复后，先创建 CardKit 2.0 卡片实例，再发送 `interactive` 消息；后续按序更新同一 markdown 元素，最终关闭 `streaming_mode` 并设置摘要。
- Tenant Token 在过期前五分钟刷新，并对并发请求做 single-flight 合并。
- 401 和平台无效 Token 错误不重试；403 标记权限降级；429 读取 `Retry-After` 后退避；网络或握手超时由连接管理器恢复。
- 飞书与 Lark 的 API、WebSocket 域名跟随 `domain` 配置，不混用凭证。

## Smoke 清单

1. 启动连接，确认后台在 WebSocket 首次握手后显示健康。
2. 分别发送私聊、未 @ 群消息和 @Bot 群消息，确认会话与访问策略正确。
3. 切换 `share_session_in_group`，确认同群成员的上下文隔离规则变化。
4. 上传 TXT、PDF 或白名单图片，确认附件私有化完成后仅执行一次 Agent。
5. 开启流式回复，确认只更新同一张 CardKit 卡片并在结束时关闭流式模式。
6. 切换 `domain=lark`，确认请求使用 Lark 域名。
7. 撤销消息或 CardKit 权限，确认后台只显示稳定错误码且不泄露密钥。
