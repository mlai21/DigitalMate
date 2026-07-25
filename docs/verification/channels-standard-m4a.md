# M4-A 七个标准 IM 渠道验收

验收日期：2026-07-26

## 结论与状态口径

Telegram、Discord、Slack、Mattermost、飞书、钉钉和 QQ 已完成本地实现、
统一 Adapter 合同、事务运行时回归与固定 QwenPaw 上游对齐审计，自动化
状态均为 `automated_verified`。

本轮没有获得七个平台的真实机器人凭据、测试组织或可控群聊，因此没有
执行真实平台 smoke；外部状态均为 `pending_external`，不得表述为“已可用”
或 `smoke_verified`。只有八项外部 smoke 全部在对应真实平台通过后，才可
逐渠道把外部状态改为 `smoke_verified`。

| 渠道 | 自动化 | 外部总体 | 连接 | 接收 | 回复 | 重复 | 重连 | 拒绝 | 主动发送 | 停用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Telegram | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| Discord | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| Slack | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| Mattermost | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 飞书 | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| 钉钉 | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |
| QQ | `automated_verified` | `pending_external` | P | P | P | P | P | P | P | P |

`P` 表示 `pending_external`，不是失败，也不是已通过。

## 八项真实平台 smoke

| 项目 | 通过标准 |
| --- | --- |
| 1. 连接 | 用最小权限凭据启用连接；后台进入 `connected`，不显示 secret、token、原始 frame 或附件 URL。 |
| 2. 接收 | 覆盖该平台的私聊、群聊/@ 和 thread 能力；每个外部事件进入正确会话、发送者和回复上下文。 |
| 3. 回复 | 被动回复发到原会话/thread；流式或拟人分段仍只对应一条完整可见 assistant 消息。 |
| 4. 重复 | 重投完全相同的平台事件，确认 Agent 只执行一次、只写一条 assistant、只产生一组 Delivery。 |
| 5. 重连 | 主动断网或关闭 socket 后恢复；offset/session/sequence 按平台协议续接，未完成发送只恢复 Delivery，不重跑 Agent。 |
| 6. 拒绝 | 分别制造无效凭据、缺权限和限流；后台只显示可操作的脱敏健康状态，非重试错误不循环。 |
| 7. 主动发送 | 由用户明确创建提醒或任务并指定已持久化接收者；发送到正确目标，不从记忆或最近 payload 猜目标。 |
| 8. 停用 | 后台停用连接；socket、长轮询、心跳和定时器全部关闭，停用后不再接收或发送。 |

## 各平台外测范围

| 渠道 | 接收与回复范围 | 重连重点 | 主动目标 |
| --- | --- | --- | --- |
| Telegram | DM、群聊 @、reply/thread、白名单附件 | 长轮询 offset、409 conflict、401 | `chat_id` 与可选 reply message |
| Discord | DM、guild @、thread/reply、bot/self ignore | Gateway session/resume、invalid intents | channel/thread |
| Slack | DM、app mention、thread、Socket envelope ACK | Socket Mode reconnect、429 `retry_after` | channel/thread |
| Mattermost | DM、channel @、root post/thread follow | WebSocket reconnect、REST 401/403/429 | channel/root post |
| 飞书 | p2p、群聊 @、reply、CardKit 分段 | 长连接 reconnect、租户 token 刷新 | `open_id` / `chat_id` |
| 钉钉 | 单聊、群聊 @、Markdown/AI Card | Stream reconnect、callback/卡片限流 | conversation/user |
| QQ | C2C、群聊 @、频道 @、频道私信 | Gateway Resume、Invalid Session、最大重连上限 | user/group/channel/DM |

逐平台权限、网络、附件和操作步骤见 `docs/channels/` 下对应文档。

## 自动化证据

| 证据 | 结果 |
| --- | --- |
| 七渠道 Adapter 合同 | 7 个文件、98 项测试通过 |
| 渠道单元与集成回归 | 18 个文件、209 项测试通过 |
| 七 Adapter 聚合注册 | `admin-compat-channels.test.ts` 断言只注册 7 种，重复注册立即失败 |
| 固定上游对齐 | `audit-channel-parity.mjs` 核验 tag、commit、快照、源集合哈希、配置、测试和本地证据通过 |
| 审计反例 | 未知渠道、重复渠道、空证据和错误源集合哈希均被测试拒绝 |
| 全仓测试 | 135 个测试文件、1725 项测试通过 |
| 静态验证 | TypeScript、ESLint 与 `git diff --check` 通过；Adapter 业务边界扫描无命中 |
| 生产构建 | 隔离 QwenPaw Console 构建与 Next.js 生产构建通过，34 个页面完成生成或编译 |
| 生产依赖审计 | 根项目 high/critical 为 0；保留的 2 个 moderate 来自既有 MCP/Hono 依赖链 |

自动化覆盖的是协议状态机、规范化、幂等、错误映射、关闭和事务边界；它
不能替代真实平台的权限审批、机器人安装、组织策略、网络出口和消息渲染
验证。

## 刻意保留的差异

- DigitalMate 强制过滤工具与思考内容；Adapter 不得直接调用 Agent、搜索、
  记忆或消息仓储。
- 附件先进入自有私有存储，平台下载地址只存在于加密 locator；带附件的
  当前或历史上下文关闭联网、Skill 和其他工具。
- 同一来源只产生一份完整可见回复。QQ 的 `ack_message` 字段为配置迁移
  保留，但不会额外发送“已收到”消息。
- 飞书、Slack 等旧 webhook 字段为迁移兼容保留，M4-A 主连接分别使用长
  连接或 Socket Mode，不能同时为同一机器人启动两套接收器。
- 钉钉 SDK 外包安全传输层，不允许输出凭据或原始 frame。
- 平台重投、进程重启和发送重试都复用 DigitalMate 的事件与 Delivery
  账本；不以重跑 Agent 换取恢复。
