# 腾讯元宝渠道

腾讯元宝渠道按 QwenPaw `v2.0.0.post3` 的 Protobuf WebSocket 协议接入，但协议、认证和媒体链路已改写为 TypeScript，并进入 DigitalMate 统一渠道事务运行时。它不会启动 QwenPaw Python Runner，也不会维护第二套 Agent 或记忆。

## 接入前提

需要先取得腾讯元宝智能体机器人接入资格，并获得 App ID 与 App Secret。没有真实平台资格或凭据时，Console 应显示 `pending_external` 或凭据/资格错误，不得显示为已在线。

配置项：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用连接 |
| `app_id` | 元宝机器人 App ID |
| `app_secret` | App Secret，只进入加密渠道配置 |
| `api_domain` | REST API 域名，默认 `bot.yuanbao.tencent.com` |
| `accept_bot_messages` | 是否接收其他机器人消息，默认关闭 |
| `bot_prefix` | 回复前缀；前缀必须短于 2800 个 Unicode 字符 |

`filter_thinking` 与 `filter_tool_messages` 始终为 `true`，推理、工具调用、搜索原始结果和内部串接内容不会发送到元宝。

## 网络端点

运行时只连接以下固定协议端点：

```text
wss://bot-wss.yuanbao.tencent.com/wss/connection
https://{api_domain}/api/v5/robotLogic/sign-token
https://{api_domain}/api/resource/genUploadInfo
https://{api_domain}/api/resource/v1/download
```

WebSocket 使用 TLS 校验。签名令牌请求采用北京时区时间戳、16-byte 随机 nonce 和 HMAC-SHA256；错误码 `10099` 最多重试 3 次。令牌在到期前 300 秒进入 single-flight 刷新，停止渠道时会取消刷新计时器。

## 收发与幂等

- 支持 C2C 与群聊；群聊 `TIMCustomElem` 中对当前 Bot 的 `elem_type=1002` 作为 @ 信号。
- 稳定事件 ID 为 `yuanbao:message:{msg_id}`，缺失 `msg_id` 时使用平台 `msg_key`。
- Protobuf push ACK 只在事件、回复路由和允许的附件完成私有落库后发送；平台重投仍由统一事件账本去重。
- 回复目标保存在加密回复句柄所关联的事件事务中；C2C 回复发给原用户，群聊回复发给原 `group_code`。
- 文本按 Unicode code point 切分，每段最多 2800 字符；发送响应使用外层 `msgId` 做 correlation。
- 处理期间使用 private/group heartbeat 的 running/finish 状态；连接 Ping 周期可由服务器 `PingRsp.heartInterval` 调整。
- `4012/4013/4014/4018/4019/4021` 属于不可重连关闭码；`41103/41104/41108` 会先刷新令牌再按退避策略重连。

## 附件与临时凭据

入站附件仍遵守 DigitalMate 固定白名单：JPEG、PNG、WebP、PDF、TXT、MD、JSON、CSV。SVG、HTML、Office、压缩包、音视频和可执行文件不会进入 Agent。

每条消息最多 4 个附件、单文件最多 10 MiB、总计最多 20 MiB。资源 URL 和 `resourceId` 只进入短期加密 locator；元宝 REST 认证头只发送到 API 域名，不转发给 CDN。解析后的 CDN URL 必须为 HTTPS 且属于腾讯受信域名，不跟随重定向。临时 COS Secret ID、Secret Key 与 Security Token 只存在于单次上传调用内存中，不进入日志、API、导出或回复句柄；上传最大 20 MiB。

附件不会授权联网、Skill 或其他工具。只有用户在当前对话中明确授权的能力才可执行。

## 真实平台验收

1. 在 Console 新建腾讯元宝连接并填入真实凭据。
2. 确认 sign-token 成功、AuthBind 返回成功，健康状态变为在线。
3. 分别从 C2C 与群聊发送文本，确认只生成一个稳定事件，群聊 @ 策略生效。
4. 发送 TXT、PDF 和允许的图片，确认文件只通过鉴权接口访问，后台不显示资源 URL 或临时凭据。
5. 发送超过 10 MiB 的单文件与超过 20 MiB 的附件组合，确认在 Agent 执行前拒绝。
6. 发送超过 2800 字符的回复，确认按 code point 分段且每段只发送一次。
7. 断开网络后恢复，确认按退避重连；模拟终止关闭码时确认不再重连。
8. 停用连接，确认 WebSocket、Ping、typing、重连和 token refresh 全部停止。

真实凭据、平台消息正文和临时 COS 密钥不得写入测试 fixture 或验收文档。
