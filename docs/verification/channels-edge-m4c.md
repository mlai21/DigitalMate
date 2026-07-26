# M4-C 四个特殊渠道与 17 渠道完整性验收

验收日期：2026-07-27

固定上游基线：QwenPaw `v2.0.0.post3`
固定上游提交：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`

## 结论与状态口径

OneBot v11、iMessage、Voice/Twilio 和 SIP 已完成本地实现、统一渠道事务、
受限节点或公网 Gateway 边界、固定上游对齐审计与自动化回归。四个渠道的
代码状态均为 `automated_verified`。

本轮没有使用真实 QQ 自动化伴生服务、macOS Messages 设备、Twilio
ConversationRelay 号码、SIP PBX、LiveKit trunk 或 DashScope 账号执行
外部 smoke，因此四个渠道的外部状态均为 `pending_external`。这表示实现
和自动化合同已完成，不表示真实平台已经可用，也不得写成
`smoke_verified`。

| 渠道 | 运行位置 | 自动化 | 外部总体 | 关键待外部条件 |
| --- | --- | --- | --- | --- |
| OneBot v11 | 中心公网 Gateway | `automated_verified` | `pending_external` | NapCat、go-cqhttp 或 Lagrange；独立测试 QQ；平台风控评估 |
| iMessage | macOS 受限节点 | `automated_verified` | `pending_external` | 已登录 Messages 的 Mac；完全磁盘访问；`imsg`；真实一对一消息 |
| Voice / Twilio | 中心公网 Gateway | `automated_verified` | `pending_external` | 稳定公网 HTTPS；Twilio 号码；ConversationRelay 资格与真实通话 |
| SIP | 受限媒体节点 | `automated_verified` | `pending_external` | UDP/PBX 或 LiveKit trunk；DashScope STT/TTS；防火墙与真实通话 |

## 17 渠道完整性

清单、Console schema、运行时注册快照和 QwenPaw 对齐账本必须精确等于
以下 17 项：

`dingtalk`、`discord`、`feishu`、`imessage`、`mattermost`、`matrix`、
`mqtt`、`onebot`、`qq`、`sip`、`slack`、`telegram`、`voice`、
`wechat`、`wecom`、`xiaoyi`、`yuanbao`。

`registerBuiltInChannelAdapters` 统一注册七个标准渠道、八个中心协议/Gateway
渠道和两个节点代理，并在注册后执行完整性断言。自动化合同同时比较
`CHANNEL_TYPES`、`CHANNEL_MANIFESTS`、注册表结果、生产
`createManagedAdapter` 的穷尽 switch 和固定 17 项集合；缺一项、多一项、
重复注册或生产分支回退为默认不可用都会失败。

对齐审计还会验证固定上游除 `console` 外的 17 个渠道目录、DigitalMate
manifest、注册表与生产 switch 快照、每个渠道的源文件集合哈希、继承后
配置字段、上游测试、本地 Adapter 或 runner、测试与文档的内容摘要、密钥
字段和有意差异。运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require-all
```

## 上游合同与本地补齐

| 渠道 | QwenPaw unit | QwenPaw contract | DigitalMate 补齐证据 |
| --- | --- | --- | --- |
| OneBot v11 | 已映射 | `missing_upstream` | `onebot.test.ts` 覆盖三种实现 fixture、Bearer、私聊/群聊/@、segment、echo、任务上限、watchdog 与平台风险状态 |
| iMessage | 已映射 | 已映射 | `imessage.test.ts` 覆盖 macOS/FDA/`imsg` 前置、只读游标、回声过滤、附件租约、发送结果未知与群聊拒绝 |
| Voice / Twilio | 已映射 | 已映射 | `voice.test.ts` 覆盖签名、TwiML、一次 token、final-only 转写、并发、幂等、barge-in、终态与零音频持久化 |
| SIP | `missing_upstream` | `missing_upstream` | `sip.test.ts` 覆盖 registrar、SIP/RTP、Digest、STT/TTS、超时、并发、pyVoIP 与 LiveKit 双后端 |

`missing_upstream` 只表示固定 QwenPaw 版本没有对应测试文件。DigitalMate
没有跳过这些行为，而是用本地协议合同补齐，并把源集合 SHA-256 与测试
缺口固定记录在 `qwenpaw-channel-parity.md`。

## 特殊渠道自动化边界

### OneBot v11

- 公网入口只接受固定 connection 路径和正确 Bearer Token；帧上限 1 MiB。
- 支持私聊、群聊、群聊 `@`、图片和文件；音频与视频不进入主模型。
- API `echo`、30 秒超时、500 个并发事件上限和 10 秒 watchdog 均有合同。
- 没有真实伴生 socket 时后台保持 `blocked: companion_service_required`。
- OneBot 依赖非官方 QQ 自动化，真实验收必须使用独立测试账号并确认封号、
  限频和平台规则风险。

### iMessage

- 节点只读查询启动游标之后的 `chat.db` 行，不回放历史，不读取本人消息。
- 完全磁盘访问、`sqlite3`、`imsg`、附件白名单和大小上限都在节点侧校验。
- 中心只接收规范化事件与私有附件 locator；节点没有数据库、模型、记忆、
  搜索、Skill、工具或调度权限。
- 当前只承诺一对一会话，群聊明确拒绝；没有健康的 macOS 节点时后台保持
  `blocked: macos_node_required`。

### Voice / Twilio

- incoming、status 和 relay 均校验 Twilio 签名；relay token 单次使用并在
  两分钟后过期。
- 只把 `prompt.last=true` 的最终转写交给 Agent；原始音频、partial
  transcript 和供应商原始 frame 不落盘。
- CallSid 与 prompt sequence 构成稳定来源 ID；重试只恢复 Delivery，不
  重跑 Agent。
- 缺少稳定公网 HTTPS 或 Twilio 配置时后台保持
  `blocked: public_https_required`；真实验收还需来电、STT、TTS、
  barge-in 和挂断回调。

### SIP / LiveKit

- Dev 后端覆盖 UDP SIP、RTP G.711 µ-law、REGISTER、INVITE、ACK、BYE、
  Digest、端口租约、超时和并发。
- 生产后端覆盖 LiveKit trunk、dispatch rule、独立 room、SIP participant
  归属、STT/TTS 和 barge-in。
- SIP、DashScope 与 LiveKit 凭据只保存在权限 `0600` 的节点私有配置中，
  不进入 Console 中心密钥库或节点协议。
- 没有健康媒体节点时后台保持 `blocked: media_node_required`。Dev
  registrar 不是公网 PBX；公网部署前仍需 NAT、TLS/SRTP、防火墙和抗滥用
  评审。

## 节点安全与生命周期

- enrollment token 只显示一次、十分钟失效，中心只保存摘要；下载包加密，
  客户端私钥不通过普通管理接口回显。
- enrollment CA 与 Gateway 服务端信任根必须是不同公钥、互不成链的独立
  自签根；配置还会验证 enrollment 私钥确实属于 enrollment 根证书。
- mTLS 会话按证书和数据库中较早的到期时间关闭；证书吊销、轮换和过期会
  阻止新连接并终止对应旧会话。
- 解绑只撤销该 connection 的收发授权并清空中心关联，不吊销节点证书，也
  不停止节点为其他 connection 保持心跳或重连。runner 在下一次注册同步
  绑定集合；需要立刻停止整台节点时必须撤销证书或停止 runner。
- 所有节点、证书、绑定、连接、outbox 和管理操作都同时受 `user_id` 与
  `agent_id` 约束；节点只能访问当前绑定的 connection。
- 断线只重放未 ACK 的持久帧与 Delivery receipt，不重新执行 Agent，也不
  猜测发送结果。

## 真实环境 smoke 清单

每个渠道只有完成适用的下列项目后，才可把外部状态改为
`smoke_verified`：

| 项目 | 通过标准 |
| --- | --- |
| 1. 启用 | 使用最小权限真实凭据或节点启用；后台从准确的 blocked 状态进入 connected，任何 secret、私钥、音频和原始 frame 均不可见。 |
| 2. 接收 | 在真实平台接收承诺范围内的私聊、群聊或通话；发送者、会话、来源 ID 与最终转写正确。 |
| 3. 回复 | 回复回到原会话或原通话；分段、TTS 或重连仍只对应一条完整可见 assistant 消息。 |
| 4. 重复 | 重投同一事件或 webhook；Agent 只执行一次、只写一条 assistant、只产生一组 Delivery。 |
| 5. 重连 | 中断 socket、节点或媒体连接后恢复；sequence、游标、CallSid、call instance 与 receipt 正确续接。 |
| 6. 拒绝 | 制造错误 token、证书、权限、资格、号码、trunk 或媒体配置；后台只返回脱敏且可操作的状态。 |
| 7. 停用 | 禁用或解绑后该 connection 不再被中心收发；撤销证书或停止 runner 后整台节点停止会话、心跳与重连。已持久化文字账本仍保留。 |
| 8. 回滚 | OneBot 撤销 token，iMessage 停节点，Twilio 恢复号码 webhook，SIP 注销/删除节点 room；其他 13 渠道和 Web 不受影响。 |

## 自动化证据

| 证据 | 结果 |
| --- | --- |
| 四特殊渠道与节点合同 | 9 个测试文件、154 项测试通过 |
| 全渠道单元与集成合同 | 33 个测试文件、448 项测试通过 |
| 17 项集合合同 | manifest、Console schema、注册表、生产 Adapter switch 和重复注册保护通过 |
| 固定上游对齐 | `--require-all` 核验 17 个渠道、tag、commit、上游与本地证据哈希、字段、测试与文档通过 |
| 对齐审计回归 | 1 个测试文件、167 项测试通过 |
| 受限节点构建 | 独立依赖安装与 TypeScript 构建通过 |
| 全仓回归 | 157 个测试文件、2078 项测试通过 |
| 生产构建 | QwenPaw Console 与 Next.js 生产构建通过，34 个页面完成生成或编译 |
| 外部资格 | 未提供；四个渠道保持 `pending_external` |

## 产品边界

- 当前仍只有一个启用中的 DigitalMate 身份与一套记忆。节点不创建第二套
  Agent、记忆、消息或任务数据库；现有 `user_id + agent_id` 作用域保留
  未来第二分身/第二记忆能力。
- 语音最终转写、iMessage 附件和任意 IM 消息都不自动授权联网、Skill、
  工具或后台任务。
- Adapter 与 runner 不直接调用 Agent、搜索、记忆或消息仓储；全部入站
  事件继续经过统一访问控制、幂等认领和响应事务。
- 工具、思考、搜索原始结果、内部提示、平台原始 frame、音频和本机路径
  不得出现在用户可见消息或公开管理接口中。
