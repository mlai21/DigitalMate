# QQ 官方机器人渠道

## 配置

在 QQ 开放平台创建机器人应用，启用需要的消息事件并填写：

- `app_id`：机器人 App ID。
- `client_secret`：机器人 App Secret，只进入加密渠道凭据。
- `markdown_enabled`：优先发送原生 Markdown；平台明确拒绝 Markdown 时降级为纯文本。
- `max_reconnect_attempts`：Gateway 最大重连次数，`-1` 表示不限制。
- `ack_message`：为兼容 QwenPaw 配置保留。DigitalMate 当前不发送额外的可见确认消息，避免同一来源产生“已收到”和最终答复两条消息。

当前使用 QQ 官方固定端点：

- Access Token：`https://bots.qq.com/app/getAppAccessToken`
- OpenAPI：`https://api.sgroup.qq.com`
- Gateway URL：通过 `/gateway` 动态获取，并只接受 QQ 官方 `wss://` 域名。

机器人需要开通单聊、群聊 @、频道私信和频道 @ 消息对应 Intent。缺少 Intent 或发送权限时，连接健康状态会显示可操作的权限错误，不会展示平台原始响应或凭据。

## Gateway 与恢复

Gateway 状态机处理以下 opcode：

- `10 Hello`：按服务器周期启动心跳，并选择 Identify 或 Resume。
- `2 Identify`：声明频道消息、私信、群聊和 C2C Intent。
- `1 Heartbeat` / `11 Heartbeat ACK`：携带最近的 Gateway sequence。
- `6 Resume`：使用已持久化的 session ID 与 sequence 恢复连接。
- `0 Dispatch`：处理 READY、RESUMED 和四类消息事件。
- `7 Reconnect`：按指数退避重新连接。
- `9 Invalid Session`：平台允许时继续 Resume；不允许时清空会话并刷新 Token。

READY 后的 session ID 与最近 sequence 会进入连接健康明细。进程重启时先读取该状态尝试 Resume；无效会话自动回到 Identify。达到 `max_reconnect_attempts` 后连接进入 disconnected，不进行无限重连。

## 消息与幂等

支持四类官方消息：

- `C2C_MESSAGE_CREATE`：QQ 单聊，发送到 `/v2/users/{openid}/messages`。
- `GROUP_AT_MESSAGE_CREATE`：群聊 @，发送到 `/v2/groups/{group_openid}/messages`。
- `AT_MESSAGE_CREATE`：频道 @，发送到 `/channels/{channel_id}/messages`。
- `DIRECT_MESSAGE_CREATE`：频道私信，发送到 `/dms/{guild_id}/messages`。

优先使用 Gateway frame 的平台 event ID；缺失时使用 session ID、sequence 与 message ID 生成稳定事件 ID。被动回复携带原 `msg_id`；C2C 与群聊同时携带 `msg_seq` 和 `msg_type`。

`msg_seq` 取自持久化 Delivery 的分段序号，因此断线或有界重试会复用同一序号，不会因重试生成新的可见回复。主动消息必须带明确的接收者类型与 OpenID，不从普通记忆猜测目标。

## 附件与安全

入站附件的原始 URL 只写入加密 locator。下载器仅允许 HTTPS 的 QQ、QPic 与 GTImg 官方域名，禁用重定向，并在 Agent 执行前把文件绑定到 DigitalMate 私有存储。公开事件摘要不包含 URL、查询参数或附件正文。

带附件的消息固定关闭联网、Skill 和其他工具；附件中的文字也不能成为联网授权。第一期仍只接受 DigitalMate 全局附件白名单中的 JPEG、PNG、WebP、PDF、TXT、MD、JSON 和 CSV。

## Smoke 清单

1. 启动连接，确认 READY 后后台显示 connected，并记录可恢复 sequence。
2. 分别验证 C2C、群聊 @、频道 @ 和频道私信各只执行一次。
3. 断开网络后恢复，确认先尝试 Resume；Invalid Session 后可回到 Identify。
4. 验证被动回复包含原 `msg_id`，重试复用 `msg_seq`。
5. 分别验证 Markdown 成功和平台明确拒绝后的纯文本降级。
6. 上传白名单图片或文件，确认私有化完成后才执行 Agent。
7. 创建明确目标的主动提醒，分别验证 C2C、群聊、频道与频道私信路由。
8. 临时移除 Intent 或发送权限，确认后台显示权限错误且不泄露 App Secret、Token 或平台响应正文。
