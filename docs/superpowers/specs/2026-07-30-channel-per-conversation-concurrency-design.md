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
| A. 多 worker + 会话感知 claimNext | `claimNext` 只领取每个会话未完成记录中最老的一条，worker 循环从 1 条改为 N 条 | **采用** |
| B. 进程内调度器 + 每会话内存队列 | dispatcher 批量领取后按会话分发到内存串行队列，信号量控限 | 否决 |
| C. 会话哈希分片 | 每个 worker 只领 `hash(会话) % N == 自己编号` 的记录 | 否决 |

采用 A 的理由：并发协调完全交给 PostgreSQL，与项目现有的 `FOR UPDATE SKIP LOCKED` + 租约模式一致；单进程与多进程行为相同；崩溃恢复复用既有租约超时机制；不触碰幂等与红线逻辑。

否决 B 的理由：记录被领取后在内存排队，必须持续续租，且进程崩溃时"内存队列里的记录归谁"语义复杂；多进程部署会直接破坏同会话串行保证。

否决 C 的理由：一个活跃群会堵死同分片内的其他会话，负载不均，与"不同群互不影响"的目标直接冲突。

## 4. 设计

### 4.1 会话键

两侧统一使用 `(connection_id, external_conversation_id)` 作为会话分区键。

不沿用既有 `channelContextKey`（单聊用发送者、群聊用会话）的口径，原因是各渠道在单聊场景都会给出与用户一一对应的会话 ID（钉钉 `conversationId`、飞书 p2p `chat_id`、Telegram chat id、QQ `c2c:<openid>`、微信 `<user>@im.wechat`），用会话 ID 已经足够细；而且它让事件侧与投递侧的键**完全同形**——投递记录的 `recipient` JSON 里必有 `externalConversationId`，不需要处理 `chatType` 分支。

两侧口径必须一致：若事件侧按 A 分组、投递侧按 B 分组，会出现"同一个群的两条回复被判定为不同会话"，导致拟人分段交叉。

`channel_inbound_events` 已有 `connection_id` 与 `external_conversation_id` 列，`channel_deliveries` 的 `recipient` 已含 `externalConversationId`，因此**两侧都不需要加列或做数据迁移**。

### 4.2 事件侧

**`claimNext` 改造**（`src/server/channels/runtime/event-repository.ts`）：在现有候选条件之外增加一条约束——同会话不存在状态属于未完成集合、且 `(received_at, id)` 更小的事件，即"我是本会话未完成事件里最老的一条"。全局排序键保持 `received_at, id` 不变，保证跨会话公平。

未完成集合取 `pending_attachments`、`accepted`、`running`；`completed` 与 `failed` 是终态，不参与阻塞。

**这一条约束同时提供 FIFO 与互斥，不需要 advisory 锁。** 关键在于它只依赖"更老的事件是否未完成"，而这个判断在 READ COMMITTED 快照下是安全的：

设同会话事件 E1 早于 E2，两条领取语句并发执行。想领 E2 的语句在自己的快照里看 E1——若 E1 尚未终结（`accepted`、`pending_attachments`，或另一个 worker 刚改成 `running` 但未提交、快照里仍是旧值 `accepted`），E2 都因"存在更老的未完成事件"被拒；若 E1 在该快照里已是 `completed`/`failed`，说明它在快照之前就已终结，那么另一个 worker 也不可能正在领取它（领取只接受 `accepted` 或租约过期的 `running`）。两种情况都不会出现同会话双领。

对比之下，advisory 锁放在同一条语句里是**无效**的：语句的快照在语句开始时就已确定，锁在扫描过程中才取到，挡不住上述竞态；要有效就必须拆成"先在事务里加锁、再用新快照查询"，而 repository 目前只接收 `Pick<Pool | PoolClient, "query">`，没有 `connect()`，为此改造接口不值得。

之所以必须把 `pending_attachments` 计入未完成集合：否则一条等待附件的老事件不阻塞后续事件，而它稍后转为 `accepted` 时又会因"没有更老的未完成事件"成为可领取的头部，从而与同会话的后续事件并发执行。

**附件等待的兜底**：`pending_attachments` 正常在同一次入站请求内就转为 `accepted` 或 `failed`（`ingress.ts` 紧接 `afterPersist` 调用 `markAttachmentsReady`），是秒级状态。但进程若在附件下载途中被杀，该行会永久停留在 `pending_attachments`，进而永久堵死这个会话。因此它只在 5 分钟宽限期内参与阻塞，超期后不再阻塞，让会话能自愈。宽限期远大于正常耗时，不会误放。

**worker 循环**（`src/server/channels/runtime/start.ts`）：`startWorkerLoop` 由启动 1 条改为启动 N 条 event loop，每条循环内部逻辑不变——领一条、处理完、再领下一条。每条循环使用带序号后缀的独立 `claim_owner`，便于按租约排查问题。

**保持不变**：入站去重（`ON CONFLICT (connection_id, external_event_id)`）、`clientTurnId` 幂等、`claimClientTurnExecution`、执行 journal 的 step key、租约过期后的接管。worker 崩溃时该会话最多被租约时长（60 秒）阻塞，到期后被其他循环接管，与现状一致。

### 4.3 投递侧

投递侧必须一起改，否则并发不产生用户可感知的改善：`delivery-worker` 在发送每一段前会真实等待——首段等 `responseDelayMs`，后续段按文本长度模拟打字延迟（单段上限 4 秒）。这是刻意的拟人节奏，不能优化掉。但它意味着一条长回复会占住唯一的投递循环十几秒，结果是 A 群和 B 群的 Agent 确实同时算完了，回复仍在排队逐条发出。

**`claimNext` 改造**（`src/server/channels/runtime/delivery-repository.ts`）：与事件侧同构，增加"我是本会话未完成投递里最老的一条"约束。会话键取 `connection_id` 与 `recipient->>'externalConversationId'`。

未完成集合取 `queued`、`running`、`retry`；`sent`、`dead_letter`、`cancelled` 是终态。

**会话内比较用 `(created_at, id)`，不用 `next_attempt_at`**：全局候选排序保持现有的 `next_attempt_at, created_at, id` 以维持重试退避行为，但会话内的先后必须按创建顺序判定。否则一条进入退避重试的回复会被排到后面，导致后一条回复先发出、聊天窗口里回复顺序与提问顺序相反。代价是重试期间同会话的后续回复要等待，退避耗尽后该投递进入 `dead_letter` 终态，队列自然放行。

**`waiting_node` 不参与阻塞**，保持现状语义。它表示投递已交给外部节点（微信等经节点中转的渠道），可能等待数小时；让它阻塞会话会把一个群卡死。代价是节点中转渠道的同会话顺序保证仍与今天一样弱，不属于本次改动范围。

**同会话顺序保证**：同一会话的下一条投递必须等前一条所有分段发完（进入终态）才会被领取，因此同一个聊天窗口内分段永不交叉，不同会话之间完全并行。

**心跳与租约**：每个 delivery claim 已有独立的 `startHeartbeat` 续租，多 worker 并行互不干扰，无需改动。

### 4.4 连接池

`getPool()`（`src/server/db/client.ts`）目前使用 pg 默认 `max: 10`。一次 Agent 回合会占用多个连接（读设置、读历史、写消息事务、写 journal），4 个事件 worker 加 4 个投递 worker 并行时容易耗尽连接池，表现为"看起来像卡死"的排队。

因此池上限改为可配置，未显式配置时按 `max(10, CHANNEL_WORKER_CONCURRENCY × 4 + 8)` 推算：每条 worker 循环预留 4 个连接（覆盖一次回合中嵌套占用的最坏情况），额外 8 个留给渠道网关与 15 秒 tick 循环。并发数为默认值 4 时得到 24。取 `max(10, …)` 保证并发数设为 1 时池不小于现状。

这一项必须与并发开关同批落地，否则并发化会让整体更慢。

### 4.5 配置项

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
3. 同会话存在 `pending_attachments` 事件时，后续事件被阻塞；该事件超过 5 分钟宽限期后不再阻塞；
4. worker 处理途中崩溃，租约到期后同会话事件被其他 worker 接管，`clientTurnId` 幂等保证不产生重复回复；
5. 投递侧同构三条：不同会话分段并行、同会话分段不交叉、同会话进入 `retry` 的投递会阻塞其后续投递；
6. `waiting_node` 状态的投递不阻塞同会话后续投递；
7. `CHANNEL_WORKER_CONCURRENCY=1` 时行为与改动前一致。

本次改动落在消息写入链路上，按 AGENTS.md 约定必须执行四条固定回归用例：普通问候 0 次搜索、未授权实时问题 0 次搜索、遗留无授权分享不投递、同一主动任务重复执行只写入 1 条可见消息。

人工验收：在两个钉钉群同时发消息，两个群应各自独立开始回复而不互相等待；在同一个群连发两条消息，回复顺序与提问顺序一致且分段不交叉。
