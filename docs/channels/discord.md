# Discord 渠道

## 配置

在管理后台的“渠道”中创建 Discord 连接，填写：

- `bot_token`：Discord Developer Portal 生成的 Bot Token。
- `accept_bot_messages`：默认关闭；关闭时忽略其他机器人消息，当前 Bot 自己的消息始终忽略。
- `streaming_enabled`：启用后先发送一条消息，再以不短于 500 毫秒的间隔编辑同一条消息。
- `http_proxy` 与 `http_proxy_auth`：代理 URL 不得内嵌凭证；认证单独使用 `user:password` 格式保存。

连接使用 `Guilds`、`GuildMessages`、`DirectMessages` 和 `MessageContent` Gateway intents。需要在 Developer Portal 为 Bot 启用 Message Content Intent，并授予读取消息、发送消息、读取历史消息和发送 typing 状态的权限。

## 消息与安全边界

- 私聊按 DM channel 路由，服务器消息按 channel 路由，thread 保留 thread ID，回复保留原始 message ID。
- 事件幂等键为 `message:{message.id}`；当前 Bot 消息永远忽略，其他 Bot 仅在显式开启后接收。
- 附件只接受 Discord CDN 的 HTTPS 地址。地址先加密写入临时 locator，文件下载到 DigitalMate 私有存储并清除 locator 后，事件才允许进入 Agent。
- 带附件的消息固定关闭联网、Skill 和其他工具；附件中的文字不能授予联网权限。
- Bot Token、代理凭证、附件 URL 和原始 Gateway payload 不写入健康状态或对话消息。

当前 `http_proxy` 覆盖 Discord REST API 与附件下载。`discord.js` 14 没有按 Client 注入 Gateway WebSocket 代理的接口，因此 Gateway WebSocket 仍直连；需要全链路代理的部署应在容器或主机网络层配置透明代理。后台会保留这项限制，不把 REST 代理误报为 Gateway 已代理。

## 运行与恢复

- 启用连接后登录 Gateway；禁用、重配或服务关闭时会销毁 Client 并关闭代理连接池。
- 无效 Token 不重试；缺少 intent/权限进入降级状态；REST 429 按 `retry_after` 退避。
- 平台重复投递由统一事件账本去重。回复发送由独立 Delivery 账本重试，不会重新执行 Agent。

## Smoke 清单

1. 发送一条 DM，确认后台只出现一条入站事件和一条回复。
2. 在服务器频道分别发送未 @、@Bot、thread reply，确认 mention/thread/reply 路由正确。
3. 上传 TXT 或图片，确认 Agent 仅在附件私有化完成后处理。
4. 开启流式回复，确认只编辑同一条 Discord 消息。
5. 撤销 Send Messages 权限，确认连接进入降级状态且不泄露 Token。
6. 禁用连接，确认 Gateway Client 被销毁且不再接收消息。
