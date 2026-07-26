# Voice / Twilio 渠道

Voice 渠道使用 Twilio Programmable Voice 的 ConversationRelay 接入电话。Twilio 在自己的媒体层完成实时 STT/TTS，DigitalMate 只接收最终转写文本并返回待合成的文字。

## 外部前置条件

- 已开通 Twilio 账号、Programmable Voice 号码和 ConversationRelay 使用资格。
- 已同意 Twilio ConversationRelay 相关 AI/ML 条款。
- `PUBLIC_BASE_URL` 指向稳定、公开可达的 HTTPS 根地址；Caddy 将 `/channel-gateway/voice/*` 转发到 Agent Service 的渠道网关。
- Twilio Account SID、Auth Token、电话号码和 Phone Number SID 均已在 Console 的 Channels → Voice 中配置。
- 网络允许 Agent Service 调用 Twilio REST API。启用或更新配置时，DigitalMate 会在 30 秒超时内更新号码的 incoming voice URL 与 status callback。

缺少公网 HTTPS、账号、号码或 ConversationRelay 资格时，渠道应显示 `blocked` 或 `degraded`，不能伪装为已连接。没有真实账号和公网入口的仓库验收状态为 `pending_external`。

## 公网端点

对连接 ID `<connection-id>`，系统只开放以下固定端点：

- `POST /channel-gateway/voice/<connection-id>/incoming`
- `POST /channel-gateway/voice/<connection-id>/status`
- `WSS /channel-gateway/voice/<connection-id>/relay?token=<single-use-token>`

incoming 与 status 必须通过 `X-Twilio-Signature` 校验，签名输入包含实际 query。incoming 为每通电话生成 32 字节一次性 relay token，中心只保存其 SHA-256 摘要；同一尚未消费的 CallSid 重试会得到同一 token。token 两分钟过期，在 WebSocket 握手成功授权时即消费；终态或过期 CallSid 会保留 24 小时的有界重放 tombstone。WebSocket 握手还会校验 Twilio 签名，并在 accept 与 setup 阶段再次检查连接、过期和终态。

HTTP body 与 WebSocket frame 均限制为 1 MiB，网关空闲连接 60 秒后关闭。达到 `max_concurrent_calls` 时返回 busy TwiML，不再分配 relay token。

## ConversationRelay 行为

- TwiML 使用经过校验的 TTS/STT provider、voice、language 和欢迎语；所有 XML 属性都会转义。
- WebSocket 必须先发送 `setup`，其 `callSid` 必须和 incoming webhook 预留的电话一致。
- 只接受 `prompt.last=true` 的最终转写；partial prompt、DTMF、供应商内部帧和未知帧不会进入 Agent。
- 外部事件 ID 固定为 `<callSid>:prompt:<sequence>`，会话 ID 使用 `callSid`，因此重试不会重新运行同一轮 Agent。
- Agent 的完整答复按确定性 Unicode 分块发送为 `text` frame，最后发送空 token 且 `last=true`。
- `interrupt` 只停止当前 TTS 发送周期；已经持久化的用户消息、Agent 回复与 Delivery 不删除、不重跑。
- status callback 进入终态后关闭 relay session 并释放并发名额。
- 禁用、重配、token 过期或终态会同时撤销 pending、authorized、pre-setup 与 active 状态；关闭前已经排队但尚未执行的 prompt 会被丢弃。

## 数据与权限边界

- Twilio 原始音频不下载、不落盘、不进入聊天附件，也不进入主模型。
- 入站事件的 `attachments` 永远为空；raw summary 只保存 call SID、号码、序号、语言和 final 状态，不保存音频、base64、partial transcript 或供应商原始帧。
- 语音转写本身不授权联网、Skill、工具或后台任务；每个 Voice turn 的搜索、工具和 Skill 权限均为关闭。
- Auth Token 只进入加密 secret 存储和运行时内存；管理 API、健康状态、审计与日志不得回显。
- 号码审计只应展示配置状态与尾四位。

## 停止与恢复

禁用或重配 Voice 会停止现有 relay session，但保留已经持久化的文字事件和回复。发送时通话已经结束会返回可重试的发送失败；系统只重试 Delivery，不重新执行 Agent。

回滚时在 Console 禁用 Voice，并在 Twilio 控制台将号码 webhook 恢复到此前地址。启用失败不会删除已保存的凭据。

## 验收

仓库内测试覆盖签名篡改、TwiML 转义、一次性 token、最终转写、并发上限、prompt 幂等 ID、打断、status 终态、webhook 配置与零音频持久化。真实平台仍需使用测试号码完成 incoming call、STT、TTS、barge-in 和挂断回调验收。
