# SIP / LiveKit 渠道运行节点

SIP 渠道运行在受限 `channel-node` 中，支持本地开发用 UDP SIP/RTP 和生产用 LiveKit 两种媒体后端。节点只负责信令、音频转写与合成；模型、记忆、搜索、Skill、工具和调度全部留在中心服务。

## 私有配置

在 `node.json` 同级目录创建：

```text
channels/sip/<connection_id>.json
```

文件必须是普通文件、权限 `0600`，连接 ID 也必须出现在 `node.json` 的 `connectionIds` 中。字段顺序与 Console 的 QwenPaw SIP 表单一致；四个凭据字段在 Console 中只作为只读的“节点配置”占位，非空值会被中心拒绝。Dev 示例：

```json
{
  "connection_id": "90000000-0000-4000-8000-000000000001",
  "sip_mode": "dev",
  "sip_host": "127.0.0.1",
  "sip_port": 5060,
  "sip_username": "mate",
  "sip_password": "",
  "sip_server": "",
  "sip_transport": "UDP",
  "rtp_port_low": 10000,
  "rtp_port_high": 10009,
  "dashscope_api_key": "sk-...",
  "tts_provider": "aliyun",
  "tts_voice": "longxiaochun_v2",
  "stt_provider": "aliyun",
  "language": "zh-CN",
  "welcome_greeting": "你好，我是 DigitalMate",
  "call_timeout": 120,
  "livekit_url": "",
  "livekit_api_key": "",
  "livekit_api_secret": "",
  "livekit_sip_trunk_id": "",
  "livekit_room_name": "sip-inbound",
  "livekit_output_sample_rate": 24000,
  "max_concurrent_calls": 5
}
```

生产 LiveKit 模式将 `sip_mode` 改为 `livekit`，并在节点私有文件填写 `wss://` URL、API Key、API Secret、SIP Trunk ID 与 room 前缀。对应 trunk 必须且只能匹配一条开启随机后缀的 `individual` dispatch rule，且 `roomPrefix` 与 `livekit_room_name` 相同；节点启动时会验证这一约束。发现房间后还会核对 SIP participant 的 `sip.trunkID` 与 `sip.ruleID`，仅接管和删除属于该 dispatch rule 的房间，避免同前缀业务房间被误处理。每通电话由 LiveKit 创建独立 room，一旦同一 room 出现第二个 SIP participant，节点会立即停止媒体并销毁该 room。

SIP 密码、DashScope 与 LiveKit 密钥只存在于这个私有文件和节点进程内存中；Console 仅显示不可编辑的空占位，不存储密钥，也不通过中心节点协议回传。节点禁止从环境变量读取渠道密钥。

## Dev SIP / RTP

- 未配置 `sip_server` 时，内置 registrar 只能绑定 `127.0.0.1`、`::1` 或 `localhost`，默认 UDP `5060`。软电话应直接呼叫 `sip:mate@127.0.0.1:5060`。
- 配置外部 `sip_server` 时，节点用 `sip_username` 注册，支持 401/407 SIP Digest MD5 challenge；同一启动周期保持稳定的 REGISTER Call-ID 与 From tag，CSeq 单调递增，按服务端期限刷新，正常停止时发送 Expires 0 注销。`sip_host` 必须是可写入 Contact/SDP 的明确地址，不能是 `0.0.0.0`。
- 信令解析与生成固定使用 CRLF，并保留 Via、From、To、Call-ID、CSeq、Contact、Record-Route 和 Route 事务/会话字段。实现覆盖 REGISTER、INVITE、ACK、BYE 与 busy/unsupported media 响应；入站 ACK/BYE 必须匹配两端 tag 和 CSeq，主动挂断按 UAS 收到的 dialog route set 原顺序或远端 Contact 寻址，并兼容 loose/strict route。
- Dev 音频只接受 RTP payload type 0（G.711 µ-law，8 kHz）。RTP 端口只从 `rtp_port_low` 到 `rtp_port_high` 的偶数端口原子租用，挂断、超时和停止时释放。
- RTP 出站每帧 20 ms，即 160-byte µ-law；sequence 每帧加 1，timestamp 每帧加 160。

本机防火墙至少允许配置的 SIP UDP 端口和 RTP UDP 范围。将 Dev 模式部署到公网前必须另外完成 NAT、TLS/SRTP、防火墙与抗滥用评审；当前内置 registrar 不是公网 PBX。

## LiveKit

- 节点启动时先确认配置的 inbound SIP trunk 存在，再连接指定 room。
- 每个 room 创建独立的订阅流与 TTS `AudioSource`，使用 SIP participant 的 `sip.callID` 作为中心 reply handle；没有该属性时退回 participant identity。
- 入站音频统一为 24 kHz 单声道 PCM16；出站固定为 960-byte、20 ms PCM16 帧。
- barge-in 会立即中止当前 TTS 生成并清空该 call 的 LiveKit 音频队列，不删除或重跑中心已经持久化的用户消息、Agent 回复或 Delivery。
- 默认每 2 秒发现配置前缀下的新 room；达到 `max_concurrent_calls` 后，第一路溢出来电会进入中心准入并返回 busy，后续溢出 room 直接销毁。正常停止也会移除 participant 并销毁节点接管的远端 room。

## STT、TTS 与中心事件

- DashScope STT 使用实时 Paraformer WebSocket。节点发送内存中的 PCM；partial 只用于检测说话开始，不进入持久队列。只有 `sentence_end=true` 的非空最终文本会生成中心事件。
- 外部事件 ID 固定为 `<callId>:utterance:<call-instance-id>:<sequence>`；同一 runner 生命周期内重复发现同一 call 不会换实例 ID，runner 重启重接仍在进行的 LiveKit 电话时会生成新的实例 ID，避免与重启前事件碰撞。会话 ID 为 `<callId>`，聊天类型固定为 `direct`，附件永远为空。
- 中心只返回完整文字 Delivery。DashScope CosyVoice 以 raw PCM 流返回，节点重新切成确定性的 20 ms 帧；Dev 编码为 µ-law，LiveKit 保持 PCM16。
- 通话默认 120 秒超时，每连接默认最多 5 路；第 6 路返回 busy。已结束 call 的 Delivery 终止为 `sip_call_not_active`。
- 如果 TTS 在尚未播放任何帧前失败，Delivery 可做有界重试；已经播放过任一帧后结果不确定，禁止自动重试，以免电话里重复播报。

原始音频、PCM/µ-law、base64、partial transcript 和 DashScope/LiveKit 原始 frame 不写入中心 outbox、消息、附件、拒绝记录或健康状态。最终转写也不构成联网、Skill 或工具授权。

## 停止、回滚与验收

在 Console 解绑连接后，中心立即拒绝该 connection 的后续收发并清空关联，
但不会吊销整台节点的证书或停止其他绑定的 transport。runner 会在下次
注册时同步最新绑定；若要求立即停止本地 SIP/LiveKit transport，应停止
runner，或撤销节点证书以断开整台节点。停止 transport 时会关闭
room/socket、清空 TTS 队列并释放 RTP 端口；中心已经持久化的文字账本仍
保留。

仓库自动化覆盖私有配置、CRLF 信令、REGISTER 生命周期与 401/407 鉴权、registrar 转发、dialog ACK/BYE、RTP sequence/timestamp、µ-law golden、端口耗尽、120 秒超时、5 路并发与 busy、LiveKit 独立房间预检/销毁、Dev/LiveKit 共用媒体合同、DashScope final-only、20 ms TTS 与 barge-in。没有真实 SIP 服务、LiveKit trunk 和 DashScope 账号时，外部状态必须保持 `pending_external`。
