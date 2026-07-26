# M4-B 六个协议与平台专有渠道验收

验收日期：2026-07-26

固定上游基线：QwenPaw `v2.0.0.post3`  
固定上游提交：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`

## 结论与状态口径

MQTT、Matrix、企业微信、小艺、腾讯元宝和微信 iLink 已完成本地
TypeScript Adapter、统一渠道事务、固定上游对齐审计和自动化回归，六个
渠道的自动化状态均为 `automated_verified`。

本轮没有使用真实 Broker、homeserver、平台内测资格、机器人账号或设备
执行外部 smoke，因此六个渠道的外部状态均为 `pending_external`。该状态
表示实现与自动化合同已完成，但不能表述为“真实平台已可用”或
`smoke_verified`。

| 渠道 | 自动化 | 外部总体 | 连接 | 接收 | 回复 | 重复 | 重连 | 拒绝 | 主动发送 | 停用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MQTT | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| Matrix | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 企业微信 | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 小艺 | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 腾讯元宝 | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 微信 iLink | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |

`P` 表示 `pending_external`，不是失败，也不是已通过。

## 上游合同与本地补齐

| 渠道 | QwenPaw 单元测试 | QwenPaw 合同测试 | DigitalMate 证据 |
| --- | --- | --- | --- |
| MQTT | 已映射 | 已映射 | `tests/unit/channels/adapters/mqtt.test.ts` 覆盖 JSON/纯文本、QoS、TLS、主题路由、发布确认、停止与统一运行时边界 |
| Matrix | 已映射 | 已映射 | `tests/unit/channels/adapters/matrix.test.ts` 覆盖登录、同步、DM/房间、回复与提及、编辑、E2EE、限流、设备库隐私与停止 |
| 企业微信 | 已映射 | `missing_upstream` | `tests/unit/channels/adapters/wecom.test.ts` 新增 DM/群聊、会话隔离、持久化后确认、流式、媒体、资格错误、重连与停止合同 |
| 小艺 | 已映射 | `missing_upstream` | `tests/unit/channels/adapters/xiaoyi.test.ts` 新增签名、双 WebSocket、心跳、切换、任务状态、幂等、回复句柄、错误分类与停止合同 |
| 腾讯元宝 | 已映射 | `missing_upstream` | `tests/unit/channels/adapters/yuanbao.test.ts` 新增鉴权、Protobuf、心跳、C2C/群聊、附件、发送关联、重连分类、幂等与停止合同 |
| 微信 iLink | 已映射 | `missing_upstream` | `tests/unit/channels/adapters/wechat.test.ts` 新增二维码、长轮询、游标提交、回复能力、失效语义、typing、附件、主动发送、重连与停止合同 |

这里的 `missing_upstream` 是固定版本中不存在相应测试文件，不表示本地
跳过。固定源目录、源集合哈希、配置字段、测试文件和本地对应物由
`scripts/qwenpaw-console/audit-channel-parity.mjs` 逐项校验，完整账本见
`docs/verification/qwenpaw-channel-parity.md`。

## 自动化覆盖

| 渠道 | 关键合同 |
| --- | --- |
| MQTT | Broker 生命周期、合法 topic、稳定事件 ID、QoS 0 限制、QoS 1/2 持久化后确认、TLS 内存凭据、发布 ACK、禁止附件 |
| Matrix | Access Token/密码登录、sync token、DM/群房间、结构化提及、reply/edit、加密房间、429、加密设备库删除顺序 |
| 企业微信 | SDK 隔离、资格与权限分类、回调持久化顺序、群会话策略、同一 stream、短期回复能力、媒体域名与 AES 解密 |
| 小艺 | 每次连接重新签名、主备双链路、TLS/SNI、心跳与退避、跨链路幂等、取消/清上下文、短期任务回复能力 |
| 腾讯元宝 | Token single-flight、二进制 fixture、Protobuf ACK、消息关联、长文本分段、附件大小与域名、不可重连错误 |
| 微信 iLink | 扫码会话租约、配置写入幂等、串行轮询、批次游标事务、`ret=-2` 持久失效、typing、一次发送、SSRF 边界 |

六个 Adapter 均只负责协议收发和规范化，不直接调用 Agent、搜索、记忆或
消息仓储。所有入站事件继续经过统一访问控制、事件认领和响应事务；平台
重投不会新建来源 ID 或重复执行 Agent。

二维码、访问令牌、签名、`context_token`、临时媒体 URL、上传凭据和回复
能力只进入内存或加密短期存储。验证文档只记录字段名与稳定错误码，不记录
真实值。附件继续受固定白名单、私有存储和“附件不授权联网/Skill/工具”
红线约束。

## 真实环境 smoke

每个渠道只有完成下列八项后，才可把外部状态改为
`smoke_verified`：

| 项目 | 通过标准 |
| --- | --- |
| 1. 连接 | 使用最小权限真实凭据启用；后台进入 `connected`，不显示 secret、token、签名、原始 frame 或附件 URL。 |
| 2. 接收 | 覆盖该渠道承诺的私聊、群聊、设备主题或加密房间；发送者、会话与回复上下文正确。 |
| 3. 回复 | 被动回复到原目标；流式、编辑或分段仍只对应一份完整可见 assistant 消息。 |
| 4. 重复 | 重投同一平台事件；Agent 只执行一次、只写一条 assistant、只产生一组 Delivery。 |
| 5. 重连 | 主动断网后恢复；游标、任务、序号或 session 正确续接，不通过重跑 Agent 恢复发送。 |
| 6. 拒绝 | 制造无效凭据、缺资格、缺权限和限流；后台只显示可操作的脱敏状态，不对不可重试错误循环。 |
| 7. 主动发送 | 使用用户明确创建且持久化授权来源的任务；发送到已持久化目标，不从记忆或最近载荷猜测。 |
| 8. 停用 | 停用后关闭 socket、长轮询、心跳、重连和 typing；不再收发。 |

各渠道还需额外验证：

- MQTT：真实 Broker 的 QoS 0/1/2、持久 session、双向 TLS 和 topic ACL。
- Matrix：目标 homeserver 的 E2EE 设备验证、加密图片、房间权限和重启后
  解密连续性。
- 企业微信：智能机器人资格、非创建者成员使用、欢迎语、流式卡片与媒体
  分块。
- 小艺：A2A 白名单资格、两条固定端点、主备切换、任务取消与一小时回复
  句柄。
- 腾讯元宝：内测资格、C2C/群聊 @、二进制版本、临时对象存储上传与下载。
- 微信 iLink：内测资格、扫码全状态、长轮询恢复、单聊回复、Token 失效后
  重新扫码。微信群能力不在本轮承诺范围内。

## 自动化证据

| 证据 | 结果 |
| --- | --- |
| 六渠道 Adapter 合同 | MQTT、Matrix、企业微信、小艺、腾讯元宝、微信 iLink 六份测试通过 |
| 六 Adapter 聚合注册 | `registerProtocolChannelAdapters` 精确注册六种，重复注册立即失败 |
| 固定上游对齐 | 13 渠道账本核验 tag、commit、源集合哈希、配置、测试与本地证据通过 |
| 上游测试缺口 | 企业微信、小艺、腾讯元宝、微信 iLink 的缺口均有明确本地合同，不以人工说明代替测试 |
| 渠道运行时回归 | 24 个测试文件、345 项测试通过 |
| 全仓回归 | 141 个测试文件、1874 项测试通过 |
| 静态验证 | TypeScript 与 `git diff --check` 通过；Adapter 业务边界扫描无命中 |
| 生产构建 | 隔离 QwenPaw Console 与 Next.js 生产构建通过，34 个页面完成生成或编译 |
| 外部资格 | 未提供，六渠道保持 `pending_external` |

自动化能够证明实现边界与协议状态机在固定 fixture 下成立，但不能替代真实
平台的资格审批、账号策略、网络出口、设备信任、消息渲染和限流验证。

## 刻意保留的差异

- 不引入 QwenPaw 第二套 Agent、记忆、消息或任务数据库；当前只有一套
  DigitalMate 身份与记忆，数据模型仍保留未来多分身扩展能力。
- 不执行 QwenPaw Python Runner；六个渠道均在 TypeScript 常驻 Agent 服务
  内运行。
- Matrix 设备库、微信扫码会话及各渠道短期回复能力按 DigitalMate 的加密、
  租约和物理删除规则存放，不使用上游明文文件路径。
- 企业微信、小艺、腾讯元宝和微信 iLink 的上游缺失合同由 DigitalMate
  补齐；安全收紧与固定上游行为差异已逐项记入渠道文档和对齐账本。
- `filter_thinking` 与 `filter_tool_messages` 强制开启；搜索原始结果、工具
  提示、推理和内部串接消息不会发到任何 IM。
