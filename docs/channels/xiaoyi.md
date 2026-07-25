# 小艺 A2A 渠道

小艺渠道按 QwenPaw `v2.0.0.post3` 的 A2A 协议接入，但协议收发已改写为 TypeScript，并进入 DigitalMate 统一渠道运行时。它不会启动 QwenPaw Python Runner，也不会维护第二套 Agent、记忆或任务记录。

## 接入条件

需要先取得华为小艺智能体 A2A 接入资格，并获得 Access Key、Secret Key 和 Agent ID。Console 会区分以下状态：

- AK、SK 或签名被拒绝：`credential_invalid`；
- 当前账号或 Agent 尚无 A2A 接入资格：`runtime_prerequisite_missing`；
- 已有资格但缺少具体操作权限：`permission_denied`；
- 两条连接均不可用：`disconnected`；任意一条仍可用时保持健康。

错误详情、SK、签名和原始平台载荷不会写入健康状态或公开日志。

## 配置

| 字段 | 说明 |
| --- | --- |
| `ak` | 小艺 A2A Access Key |
| `sk` | 小艺 A2A Secret Key，只进入加密渠道配置 |
| `agent_id` | 已获授权的小艺 Agent ID |
| `task_timeout_ms` | 单个 A2A 任务回复句柄有效期，默认 3,600,000 毫秒（1 小时） |

公共渠道字段继续生效。`filter_thinking` 与 `filter_tool_messages` 在清单和运行时中强制为 `true`，不会向小艺发送推理、工具调用或内部串接结果。

## 鉴权与双连接

运行时同时连接两个上游固定端点：

```text
wss://hag.cloud.huawei.com/openclaw/v1/ws/link
wss://116.63.174.231/openclaw/v1/ws/link
```

每次建立或重建连接时都生成新的毫秒时间戳，并按以下规则计算请求头：

```text
x-sign = Base64(HMAC-SHA256(SK, timestamp_ms))
```

请求包含 `x-access-key`、`x-sign`、`x-ts` 和 `x-agent-id`。主链路与备用链路分别发送初始化帧和每 30 秒一次的心跳，也分别按 1、2、5、10、30、60 秒退避重连，60 秒封顶，每条链路最多尝试 50 次。

备用端点虽然使用 IP 地址，DigitalMate 仍保留 TLS 证书校验，并显式使用 `hag.cloud.huawei.com` 作为 SNI；没有沿用上游参考实现关闭证书校验的做法。禁用、改配或服务关闭时会同时清理两条连接、心跳和重连定时器。

## 入站、去重与任务生命周期

`message/stream` 使用平台 task ID 与请求 message ID 生成稳定事件 ID：

```text
xiaoyi:task:{task_id}:{message_id}
```

因此同一任务经主、备链路重复到达时，统一 Ingress 只持久化并执行一次。事件继续经过访问控制、执行账本和唯一回复事务，不会直接从 WebSocket 调用 Agent。

`sessionId` 作为会话与发送者标识。task ID 与请求 message ID 是短期回复能力，只进入加密 reply handle；句柄按 `task_timeout_ms` 过期。原始请求从哪条链路到达会作为首选回复路由，若该链路断开则自动切换到另一条。

`clearContext` 与 `tasks/cancel` 也先写入统一幂等事件账本，首次通过访问控制后才发送 `cleared` 或 `canceled` 响应；重复帧不会触发第二次响应或 Agent。该行为与上游基线一致：取消帧关闭平台任务状态，不额外引入一套 Agent 中断系统。

## 回复状态机

回复必须沿用原 A2A 请求 ID，不能改成新的随机消息 ID。DigitalMate 将一份已持久化 Delivery 作为同一响应事务发送：

1. 文本按最多 4,000 个 Unicode code point 分片，避免把 emoji 代理对拆开；
2. 每片先写入统一 Delivery 分片状态，再发送一个 `artifact-update`，使用由 Delivery 和偏移量派生的稳定 artifact ID；
3. 所有文本分片完成后，独立的持久化尾分片先发送 `status-update(state=completed)`，再发送上游要求的空文本 `artifact-update(final=true)` 结束任务；
4. 任一重试只会重发当前未完成分片，不会从头追加已经成功的可见文本。

Console 的拟人分段会以累计内容进入这个状态机，适配器只发送新增部分，最终仍只产生一个完整平台回复。传输重试复用原请求 ID 和稳定 artifact ID，不创建第二个 Agent 响应事务。`bot_prefix` 会计入每片 4,000 Unicode code points 的上限。

小艺协议只允许在有效 task reply handle 内回复，不支持任意会话主动发送。提醒或后台任务不会在句柄过期后退化成无授权主动消息。

## 附件

入站 `file` part 只接受现有第一期白名单：

- JPEG、PNG、WebP；
- PDF、TXT、MD、JSON、CSV。

SVG、HTML、Office、压缩包、视频、音频与可执行文件不会进入 Agent 附件上下文。每条消息最多 4 个附件、单文件最多 10 MiB、总计最多 20 MiB；系统会在写入任何私有附件前检查整批实际大小。下载地址必须使用 HTTPS，且主机属于华为、小艺所用华为云或 DBank CDN 域名；不跟随重定向，也不携带 Cookie、Authorization 或渠道凭据。临时下载字节在单次私有存储完成后立即释放，缓存条目数量也受 4 个附件上限约束。

下载内容在内存中限流并经过 DigitalMate 现有文件名、MIME、大小和文件签名校验，随后写入自有私有附件存储。源 URL 只进入 15 分钟有效的加密 locator，绑定私有附件后立即清除；公开事件、管理 API 和对话 UI 不返回 URL、文件字节、存储路径或供应商载荷。附件仍会关闭当前上下文的联网、Skill 与其他工具权限，不解冻 P2 文件任务。

## 人工冒烟

1. 使用有效 AK、SK 与 Agent ID，确认两条 WebSocket 均连接并每 30 秒发送心跳。
2. 分别使用错误 SK、无 A2A 资格账号和缺权限账号，确认状态区分为凭据错误、资格阻塞和权限错误。
3. 从主链路发送文字任务，确认事件 ID 为 `xiaoyi:task:{task_id}:{message_id}`，回复依次出现内容、完成状态和最终帧。
4. 将同一任务同时投递到主、备链路，确认 Agent 只执行一次、平台只收到一份完整回复。
5. 断开主链路，确认备用链路继续服务且主链路独立退避重连；再断开备用链路，确认状态变为断开。
6. 发送超过 4,000 个中文字符并包含 emoji 的回复，确认分片不截断字符且最后正确结束任务。
7. 发送 PNG、PDF 与 TXT，确认进入私有附件存储；尝试 SVG、Office、非华为域名和重定向 URL，确认被拒绝。
8. 发送 `tasks/cancel` 与 `clearContext`，确认重复帧只响应一次且不触发 Agent。
9. 让任务句柄过期后重试发送，确认不会退化为主动消息。
10. 在重连或心跳期间禁用渠道，确认两条 socket 和全部定时器都停止。
