# 微信 iLink 渠道

微信渠道按 QwenPaw `v2.0.0.post3` 的 iLink 协议接入，但协议收发已改写为 TypeScript，并进入 DigitalMate 统一渠道事务运行时。它不会启动 QwenPaw Python Runner，也不会维护第二套 Agent、记忆或上下文文件。

## 接入条件与扫码登录

该渠道需要微信 iLink 机器人内测资格。Console 沿用 QwenPaw 的扫码交互：

1. 后端向微信申请二维码，返回 5 分钟有效的匿名轮询令牌；
2. Console 展示二维码，并轮询 `waiting`、`scanned`、`confirmed` 或 `expired`；
3. 确认后，Bot Token 使用稳定操作 ID 写入 DigitalMate 的加密渠道配置；短暂写入失败会在同一会话内重试，不要求重新扫码；
4. 只有配置事务成功后才销毁二维码会话，接口只返回 `bot_token: "configured"`，不会把明文 Token 交给浏览器。

轮询令牌只以 HMAC 摘要作为服务端索引，微信二维码值、Bot Token 和扫码凭据不会写入公开 API、日志或消息表。没有内测资格或凭据被拒绝时，Console 显示 `wechat_ilink_eligibility_required`，不得显示为已在线。

## 配置

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用连接 |
| `bot_token` | 扫码确认后写入的 Bot Token，只进入加密渠道配置 |
| `base_url` | 默认 `https://ilinkai.weixin.qq.com`，仅允许微信官方 HTTPS 域名 |
| `message_merge_enabled` | 保留 QwenPaw 配置能力；当前一份已持久化回复固定合并为一条微信消息 |
| `message_merge_delay_ms` | 保留后续兼容能力，当前不额外延迟统一 Delivery |
| `bot_prefix` | 回复前缀，与完整回复一起冻结为同一条平台消息 |

QwenPaw Console 中的 `bot_token_file` 和 `media_dir` 字段为了页面兼容仍可见，但 DigitalMate 不允许从明文 Token 文件读取凭据，也不把微信媒体写入外部目录。`filter_thinking` 与 `filter_tool_messages` 始终为 `true`。

## 协议与连接

运行时只访问以下固定端点：

```text
https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status
https://ilinkai.weixin.qq.com/ilink/bot/getupdates
https://ilinkai.weixin.qq.com/ilink/bot/sendmessage
https://ilinkai.weixin.qq.com/ilink/bot/getconfig
https://ilinkai.weixin.qq.com/ilink/bot/sendtyping
https://novac2c.cdn.weixin.qq.com/c2c/download
```

每次请求都生成新的十进制 uint32 `X-WECHAT-UIN` 并做 Base64 编码，同时使用 `AuthorizationType: ilink_bot_token`。`getupdates` 使用 `channel_version: 2.0.1` 和 45 秒长轮询；`ret=-1` 表示本轮无消息并继续保留游标，`ret=-2` 表示凭据失效并停止重连。其他网络错误按 5 秒起、120 秒封顶退避。

## 入站、隐私与幂等

- 只处理 `message_type=1` 的用户消息。
- 优先使用 `context_token` 的 SHA-256 摘要生成稳定事件 ID；数据库中不保存明文 Token。缺少 Token 时才使用发送者与平台 `msg_id`。
- 微信载荷没有可靠时间戳时，平台重投的本地接收时间不会参与负载冲突判断，因此同一事件只执行一次。
- `context_token` 作为回复能力进入 AES-GCM 加密 reply handle；统一事件落库和附件私有化完成后才接受消息。
- 一份已持久化回复连同 `bot_prefix` 只调用一次 `sendmessage`。网络中断发生在请求发出后时，结果标记为不确定且不自动重发，避免一条回复在微信出现两次。
- `ret=-2` 会把加密 reply handle 持久标记为失效，同时清理内存缓存；服务重启和后续主动任务都不会再次选择该令牌。

当前仅承诺单聊能力。虽然上游载荷保留 `group_id` 字段，Console 与清单不会把未经真实平台验收的微信群能力标记为可用。

## 正在输入与主动消息

首次发送正在输入状态前，通过 `getconfig` 用当前 `context_token` 获取 `typing_ticket`，票据在内存中缓存 24 小时。处理期间每 5 秒发送一次 `status=1`，结束时只发送一次 `status=2`；停用连接会清理全部计时器。

提醒和后台任务只能从数据库选择该联系人最近一次未过期、未失效的加密 reply handle，因此服务重启后仍可恢复。没有句柄或平台返回 `ret=-2` 时直接失败，不退化成无授权发送，也不会从记忆猜测目标或权限。

## 附件

入站图片和文件只接受 JPEG、PNG、WebP、PDF、TXT、MD、JSON、CSV。视频只转换为 `[video]` 文本标记；SVG、HTML、Office、压缩包、音频和可执行文件不会进入 Agent 附件上下文。

每条消息最多 4 个附件、单文件最多 10 MiB、总计最多 20 MiB。微信 CDN 的 `encrypted_query_param` 与 AES Key 只进入 15 分钟有效的加密 locator；下载只访问固定微信 CDN、不跟随重定向，随后用 AES-128-ECB 解密并写入自有私有附件存储。绑定完成后 locator 与临时缓存立即清理，公开事件、管理 API 和聊天 UI 不返回下载参数、AES Key、文件字节或存储路径。

附件不会授权联网、Skill 或其他工具，也不会解冻 P2 文件任务。

## 人工冒烟

1. 使用有 iLink 资格的微信扫码，确认状态依次为等待、已扫码、已确认，页面只显示已配置。
2. 刷新 Console 和重启服务，确认 Bot Token 仍可用且任何 API 都不返回明文。
3. 发送文本，确认事件只执行一次、微信只收到一条完整回复，前缀没有重复。
4. 在相同 `context_token` 下重投原消息，确认不重复下载附件、不重复执行 Agent。
5. 发送 TXT、PDF 与允许的图片，确认进入私有附件存储；尝试 SVG、Office 和超限文件，确认在 Agent 执行前拒绝。
6. 断开网络后恢复，确认长轮询退避重连且游标连续；模拟 `ret=-2` 时确认停止重连。
7. 在发送请求发出后模拟断线，确认系统不自动重发结果不确定的消息。
8. 观察正在输入状态，确认每 5 秒续期并在处理结束时关闭。
9. 让二维码超过 5 分钟或重复使用已确认的轮询令牌，确认返回 `expired`。
10. 停用连接，确认长轮询、正在输入和退避计时器全部停止。

真实 Bot Token、上下文令牌、平台消息正文和媒体 AES Key 不得写入测试 fixture 或验收文档。
