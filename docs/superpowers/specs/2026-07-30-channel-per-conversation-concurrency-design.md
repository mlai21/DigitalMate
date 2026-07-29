# 渠道消息按会话并发处理设计规格

> 日期：2026-07-30
>
> 状态：已确认
>
> 关联范围：P1-13 渠道运行时（事件与投递事务账本）、P1-12 多渠道接入

## 1. 背景

不同钉钉群、不同会话的消息目前是排队处理的，一个群的长回复会让其他群一起等待。这与"多个对话入口共享同一身份"的产品形态冲突：用户在 A 群提问后，B 群的同事必须等 A 群回复完才能得到响应。

现状的串行来自渠道运行时的两处设计，不是有意的限流：

- `src/server/channels/runtime/start.ts` 的 `startWorkerLoop` 各只启动**一条** event loop 和**一条** delivery loop。
- `event-repository.ts` 与 `delivery-repository.ts` 的 `claimNext` 都是 `FOR UPDATE SKIP LOCKED LIMIT 1`，一次只领一条记录。

入站链路本身已经是异步的：adapter 收到消息后经 `acceptInbound` 写入 `channel_inbound_events` 并立即 ACK，真正的 Agent 回合在 worker 里跑。所以并发化不需要触碰任何 adapter 或 webhook 代码，只需要让 worker 能同时处理多条属于不同会话的记录。

`SKIP LOCKED` 本就允许多个消费者各领不同记录，因此多进程部署下并发已经天然成立；缺的是**同会话必须串行**这个约束，以及单进程内的多 worker。

## 2. 已确认的产品决策

1. **所有渠道统一按会话并发**。队列机制是钉钉、飞书、Telegram 等共用的，按会话分区对所有渠道同时生效，不做单渠道开关——两套行为会让问题排查成本翻倍。
2. **不同会话并行，同会话严格串行且保持 FIFO**。同一个聊天窗口内的消息顺序和上下文连贯性优先于并行度。
3. **并发数可配置，默认 4**。每个并行会话占用一次 LLM 调用与若干数据库连接，无上限会撞上模型 API 限流。设为 `1` 即回到改动前的行为，作为回滚开关。
4. **事件侧与投递侧一起并发化**。只改事件侧不改投递侧等于没改（见 4.2）。
5. **不改动任何幂等机制**。幂等语义保持"按来源"（`external_event_id` / `clientTurnId` / 执行 journal），不改成"按会话"。

## 3. 方案选择

评估过三种方案：

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 多 worker + 会话感知 claimNext | `claimNext` 跳过"同会话已有 running"的记录，worker 循环从 1 条改为 N 条 | **采用** |
| B. 进程内调度器 + 每会话内存队列 | dispatcher 批量领取后按会话分发到内存串行队列，信号量控限 | 否决 |
| C. 会话哈希分片 | 每个 worker 只领 `hash(会话) % N == 自己编号` 的记录 | 否决 |

采用 A 的理由：并发协调完全交给 PostgreSQL，与项目现有的 `FOR UPDATE SKIP LOCKED` + 租约模式一致；单进程与多进程行为相同；崩溃恢复复用既有租约超时机制；不触碰幂等与红线逻辑。

否决 B 的理由：记录被领取后在内存排队，必须持续续租，且进程崩溃时"内存队列里的记录归谁"语义复杂；多进程部署会直接破坏同会话串行保证。

否决 C 的理由：一个活跃群会堵死同分片内的其他会话，负载不均，与"不同群互不影响"的目标直接冲突。

## 4. 设计

### 4.1 事件侧

**会话键**与既有的 `channelContextKey`（`src/server/channels/runtime/agent-turn.ts`）口径一致：

- `direct` 聊天：`connection_id` + `external_sender_id`
- `group` 聊天：`connection_id` + `external_conversation_id`

这三列都已存在于 `channel_inbound_events`，在 SQL 里用表达式计算即可，**不需要数据迁移**。

**`claimNext` 改造**（`src/server/channels/runtime/event-repository.ts`）：

1. 候选集排除"同会话已存在 `status = 'running'` 且 `claim_expires_at` 未过期"的事件；
2. 每个会话只允许领取其最老的一条待处理事件，保证同会话 FIFO；
3. 全局排序键保持 `received_at, id` 不变，保证跨会话公平；
4. 整个领取语句包在事务内，先取一个全局 `pg_advisory_xact_lock`。这只串行化"领取"这一个微秒级动作，消除"两个 worker 同时判定某会话空闲、各领走该会话一条消息"的竞态；事件的实际处理完全并行。事件侧与投递侧使用**不同的**固定锁键，两条队列的领取动作互不阻塞。

**worker 循环**（`src/server/channels/runtime/start.ts`）：`startWorkerLoop` 由启动 1 条改为启动 N 条 event loop。每条循环内部逻辑不变——领一条、处理完、再领下一条。

**保持不变**：入站去重（`ON CONFLICT (connection_id, external_event_id)`）、`clientTurnId` 幂等、`claimClientTurnExecution`、执行 journal 的 step key、租约过期后的接管。worker 崩溃时该会话最多被租约时长（60 秒）阻塞，到期后被其他循环接管，与现状一致。

### 4.2 投递侧

投递侧必须一起改，否则并发不产生用户可感知的改善：`delivery-worker` 在发送每一段前会真实等待——首段等 `responseDelayMs`，后续段按文本长度模拟打字延迟（单段上限 4 秒）。这是刻意的拟人节奏，不能优化掉。但它意味着一条长回复会占住唯一的投递循环十几秒，结果是 A 群和 B 群的 Agent 确实同时算完了，回复仍在排队逐条发出。

**会话键**从 `recipient` JSON 推导，与事件侧口径完全一致：

- `chatType = 'direct'`：`connection_id` + `recipient->>'externalUserId'`
- 其他：`connection_id` + `recipient->>'externalConversationId'`

`recipient` 在两条入队路径（事件回复 `turn-executor.ts` 的 `persist`、主动任务 `enqueueProactiveChannelDelivery`）都必定包含 `chatType` 与 `externalConversationId`，`direct` 还包含 `externalUserId`。因此 `channel_deliveries` **同样不需要加列或做数据迁移**。`externalUserId` 缺失时回退到 `externalConversationId`，保证会话键永不为 NULL。

两侧口径必须一致：若事件侧按 A 分组、投递侧按 B 分组，会出现"同一个群的两条回复被判定为不同会话"，导致拟人分段交叉。

**`claimNext` 改造**（`src/server/channels/runtime/delivery-repository.ts`）：与事件侧同构——排除同会话 running 未过期的投递、每会话只取最老一条、领取动作置于事务内的 advisory 锁下。排序键保持现有的 `next_attempt_at, created_at, id`，重试退避行为不变。

**worker 循环**：delivery loop 同样从 1 条改为 N 条。

**同会话顺序保证**：同一会话的下一条投递必须等前一条**所有分段发完**才会被领取，这由"同会话有 running 就跳过"直接保证。因此同一个聊天窗口内分段永不交叉，不同会话之间完全并行。

**心跳与租约**：每个 delivery claim 已有独立的 `startHeartbeat` 续租，多 worker 并行互不干扰，无需改动。

### 4.3 连接池

`getPool()`（`src/server/db/client.ts`）目前使用 pg 默认 `max: 10`。一次 Agent 回合会占用多个连接（读设置、读历史、写消息事务、写 journal），4 个事件 worker 加 4 个投递 worker 并行时容易耗尽连接池，表现为"看起来像卡死"的排队。

因此池上限改为可配置，未显式配置时按 `max(10, CHANNEL_WORKER_CONCURRENCY × 4 + 8)` 推算：每条 worker 循环预留 4 个连接（覆盖一次回合中嵌套占用的最坏情况），额外 8 个留给渠道网关与 15 秒 tick 循环。并发数为默认值 4 时得到 24。取 `max(10, …)` 保证并发数设为 1 时池不小于现状。

这一项必须与并发开关同批落地，否则并发化会让整体更慢。

### 4.4 配置项

新增到 `src/server/config/env.ts`，并同步 `.env.example` 与 `docs/env.md`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHANNEL_WORKER_CONCURRENCY` | `4` | 事件与投递各自启动的 worker 循环数；设为 `1` 等同改动前行为 |
| `DATABASE_POOL_MAX` | `max(10, 并发数 × 4 + 8)` | 显式设置时优先于推算值 |

## 5. 并发引入的风险与既有兜底

**插话频率上限不受影响**。`repositories.channels` 的插话计数 SQL 带 `channel = $3 AND external_conversation_id = $4`，是**按会话**统计的；同会话仍串行，因此不存在"读计数→决策→写入"的跨会话竞态。

**主动消息每日配额不受影响**。`canSendProactiveMessage` 使用的 `countSentToday` 是账号级全局计数，但它在 `processDueProactiveTasks` 里执行，属于 15 秒 tick 的串行循环，配额检查完成后才入队；并发只发生在入队之后的投递阶段。

**平台限流已有兜底**。投递失败抛 `ChannelSendError` 时 `nextRetryAt` 会尊重 `retryAfterMs`。同一个钉钉连接上多个会话并行发送撞到平台限流时是退避重试，不会丢消息，无需新增机制。

**模型限流**：并发 4 意味着 LLM 请求峰值放大约 4 倍，provider 返回 429 时事件按既有租约与重试链路重来。默认值取 4 而非更大就是为了留出余量。

**清空用户数据**：`withUserDataLease` 的共享租约允许多个持有者，exclusive 清空需要等待所有 in-flight 完成。并发后 in-flight 数量上升，清空动作获取排他锁的等待时间变长，语义不变。

## 6. 测试与验收

新增用例放入既有集成测试文件（`tests/integration/channels/event-claim.test.ts`、`tests/integration/channels/end-to-end.test.ts`）：

1. 两个不同会话的事件可被两个 worker 同时领取并并行处理；
2. 同一会话的两条连续消息，第二条在第一条完成前不被领取，处理顺序为 FIFO；
3. worker 处理途中崩溃，租约到期后同会话事件被其他 worker 接管，`clientTurnId` 幂等保证不产生重复回复；
4. 投递侧同构两条：不同会话分段并行、同会话分段不交叉；
5. `CHANNEL_WORKER_CONCURRENCY=1` 时行为与改动前一致。

本次改动落在消息写入链路上，按 AGENTS.md 约定必须执行四条固定回归用例：普通问候 0 次搜索、未授权实时问题 0 次搜索、遗留无授权分享不投递、同一主动任务重复执行只写入 1 条可见消息。

人工验收：在两个钉钉群同时发消息，两个群应各自独立开始回复而不互相等待；在同一个群连发两条消息，回复顺序与提问顺序一致且分段不交叉。
