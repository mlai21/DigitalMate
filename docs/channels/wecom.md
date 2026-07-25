# 企业微信渠道

企业微信渠道使用 `@wecom/aibot-node-sdk@1.0.7` 建立智能机器人 WebSocket 长连接，支持单聊、群聊、欢迎语、流式文本、主动消息和白名单附件。所有入站消息仍先进入 DigitalMate 统一 Ingress、访问控制与执行账本；SDK 只负责协议收发，不接触 Agent、记忆或模型。

## 接入条件

需要在企业微信侧取得智能机器人接入资格，并获得 `Bot ID` 与 `Secret`。扫码创建机器人时，如果企业微信询问是否授权机器人能力，应选择“暂不授权”；选择“确认授权”可能导致机器人创建者以外的成员无法使用。

后台会区分三类稳定状态：

- Bot ID 或 Secret 被拒绝：`credential_invalid`；
- 账号尚无智能机器人资格：`runtime_prerequisite_missing`，连接标记为阻塞，不自动重试；
- 机器人已有资格但缺少具体权限：`permission_denied`。

平台返回的原始错误文字、Secret 和回调载荷不会进入健康状态或日志。

## 配置

| 字段 | 说明 |
| --- | --- |
| `bot_id` | 企业微信智能机器人 ID |
| `secret` | 长连接认证 Secret，只进入加密渠道配置 |
| `welcome_text` | 用户当天首次进入单聊时发送的欢迎语；留空不发送 |
| `share_session_in_group` | 开启时同一群成员共享群会话；关闭时按群 ID 与发送者隔离上下文 |
| `max_reconnect_attempts` | 最大重连次数；`-1` 表示无限重连 |
| `streaming_enabled` | 使用同一个企业微信 stream ID 累计更新回复 |
| `media_dir` | 为 QwenPaw 配置兼容保留；DigitalMate 实际附件统一写入自有私有附件存储，不允许渠道指定任意落盘目录 |

`filter_thinking` 与 `filter_tool_messages` 在清单和运行时都被强制为 `true`，企业微信消息不会展示推理过程、工具调用或内部串接结果。`enter_chat` 也先以平台事件写入统一幂等账本；只有首次持久化成功且访问控制允许时才发送欢迎语，平台重投不会重复问候，也不会触发 Agent。

## 入站、去重与会话

SDK 完成认证后连接才标记为健康。消息回调使用企业微信原生 `msgid` 生成外部事件 ID：

```text
wecom:message:{msgid}
```

统一 Ingress 完成持久化或确认重复后，企业微信回调处理才结束。SDK 不会在持久化前直接调用 Agent，也不会在适配层维护第二套记忆。

单聊会话使用发送者 `userid`。群聊在 `share_session_in_group=true` 时使用 `chatid`；关闭时使用 `chatid:userid` 隔离成员上下文。智能机器人群消息由平台在机器人会话语境中投递，因此规范化事件标记为已提及，并继续经过 DigitalMate 的群聊开关、允许列表和访问控制。

回调 `req_id` 是短期回复能力，只进入十分钟有效的加密 reply handle；公开事件、管理 API 和日志只保留非敏感的 chat ID、sender ID 与 message ID。

## 流式与主动发送

普通被动回复通过回调 `req_id` 调用 `replyStream`。启用流式后，同一 Delivery 派生一个稳定 stream ID：

- 中间帧使用 SDK 非阻塞发送；上一帧尚未收到平台 ACK 时可以跳过，避免堆积；
- 最终帧始终发送并等待 ACK；
- 后续帧沿用同一个外部消息 ID，不创建第二条可见回复，也不再次执行 Agent。

没有回调句柄的明确提醒或定时任务使用 `sendMessage` 主动发送 Markdown。普通聊天、历史搜索、附件内容或记忆都不能自行创建主动任务；只有已持久化授权来源的任务才能进入发送队列。

## 附件与媒体

第一期只把图片以及 PDF/TXT/MD/JSON/CSV 文件交给现有附件白名单。语音只使用企业微信提供的 ASR 文本；视频、Office、压缩包和可执行文件不会扩大当前附件能力。

企业微信入站媒体的下载 URL 与独立 `aeskey` 只进入四分钟有效的加密 attachment locator。运行时只接受企业微信 HTTPS 媒体域名，调用 SDK 下载并在内存完成 AES-256-CBC 解密，再进入 DigitalMate 私有附件存储；绑定成功后清除 locator。公开接口和对话 UI 不返回 URL、密钥、存储路径、提取文本或供应商载荷。

出站媒体使用 SDK 的 WebSocket 三阶段分片接口：

```text
init → chunk（单片不超过 512 KiB）→ finish
```

单文件上限按 SDK 的 100 个分片约束固定为 50 MiB。当前聊天 Delivery 仍以文本为主；该上传能力保留给后续已批准的白名单媒体发送，不解冻 P2 文件任务。

## 停止与回滚

禁用、改配、认证失败或服务关闭时都会移除 SDK 监听器并调用 `disconnect()`，包括尚处于认证或重连阶段的连接。`max_reconnect_attempts=-1` 只表示运行期间无限重连，不会阻止显式停止。已经持久化但尚未发送的 Delivery 保留，重新启用连接后可按统一重试规则继续。

## 人工冒烟

1. 使用有资格的 Bot ID 与 Secret 连接，确认只有收到 `authenticated` 后显示已连接。
2. 使用无资格账号、错误 Secret 和缺权限机器人，确认分别显示阻塞、凭据错误和权限错误。
3. 在单聊发送文字，确认事件 ID 为 `wecom:message:{msgid}`，回复只出现一次。
4. 在群聊中 @ 机器人，分别切换 `share_session_in_group`，确认群共享与成员隔离符合配置。
5. 触发 `enter_chat`，确认仅在 `welcome_text` 非空时发送欢迎语。
6. 开启流式回复，确认中间帧和最终帧更新同一条消息，最终帧不会因 ACK 未返回而跳过。
7. 发送图片和 TXT/PDF，确认 URL 与 AES key 不出现在 UI/日志，附件进入私有存储。
8. 尝试视频、Office、压缩包与非企业微信媒体域名，确认不会进入 Agent 附件上下文。
9. 发送一条已明确授权的主动任务，确认使用目标 userid/chatid；普通消息不得派生后台主动发送。
10. 在无限重连期间禁用渠道，确认 WebSocket、重连和所有监听器都被停止。
