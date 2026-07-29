# 渠道消息按会话并发处理实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让不同钉钉群、不同会话的消息并发处理，同一会话内仍严格串行且保持 FIFO。

**Architecture:** 保持"入站先入库再 ACK、worker 异步消费"的现有架构。在事件与投递两个 `claimNext` 的 SQL 里各加一条"我是本会话未完成记录中最老的一条"约束，把 `startWorkerLoop` 从各 1 条改为各 N 条，并把数据库连接池上限按并发数放大。无数据迁移、无新表、无新列。

**Tech Stack:** TypeScript、PostgreSQL（`FOR UPDATE SKIP LOCKED` + 租约）、zod（env 校验）、vitest（含 `embedded-postgres` 集成测试）。

**Spec:** `docs/superpowers/specs/2026-07-30-channel-per-conversation-concurrency-design.md`

## Global Constraints

- 沟通、文档、commit message 用简体中文；代码标识符与注释用英文。
- 只做本计划要求的改动，不顺手重构。
- 会话分区键两侧统一为 `(connection_id, external_conversation_id)`；投递侧从 `recipient->>'externalConversationId'` 取。
- 事件未完成集合：`pending_attachments`、`accepted`、`running`。投递未完成集合：`queued`、`running`、`retry`。
- 事件侧 `pending_attachments` 只在 5 分钟宽限期内参与阻塞。
- 投递侧 `waiting_node` 不参与阻塞。
- 投递侧会话内先后按 `(created_at, id)` 判定，全局候选排序仍是 `next_attempt_at, created_at, id`。
- 不改动任何幂等机制：`external_event_id` 去重、`clientTurnId`、`claimClientTurnExecution`、执行 journal step key 全部保持原样。
- `CHANNEL_WORKER_CONCURRENCY=1` 时只启动各 1 条循环，并发度回到改动前；按会话领取的约束始终生效。
- `schema.sql` 只做增量、可重复执行的改动（`CREATE INDEX IF NOT EXISTS`）。
- 不得在对话输出中暴露思考过程、工具调用或系统提示。

---

### Task 1: 事件侧按会话串行领取

**Files:**
- Modify: `src/server/channels/runtime/event-repository.ts`（`claimNext`，约 229-272 行；`ChannelEventRepositoryOptions`，约 75-77 行；文件头常量，约 13 行）
- Modify: `src/server/db/schema.sql`（新增一个部分索引）
- Test: `tests/integration/channels/event-claim.test.ts`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `createChannelEventRepository(pool, options)` 的 `options` 新增可选字段 `pendingAttachmentBlockMs?: number`，默认 `300_000`。
  - `claimNext(owner: string, now?: Date): Promise<ClaimedChannelEvent | null>` 签名不变，语义变为"只领取本会话未完成事件中最老的一条"。
  - 测试辅助函数 `normalizedEvent(connectionId, externalEventId, overrides?)` 新增第三个可选参数，类型 `Partial<NormalizedChannelEvent>`。

- [ ] **Step 1: 扩展测试辅助函数以支持指定会话与接收时间**

`tests/integration/channels/event-claim.test.ts` 底部的 `normalizedEvent`（约 1198-1228 行）改为接受覆盖项。只加参数，不改任何已有调用点：

```ts
function normalizedEvent(
  connectionId: string,
  externalEventId: string,
  overrides: Partial<NormalizedChannelEvent> = {},
): NormalizedChannelEvent {
  return {
    connectionId,
    agentId: AGENT_ID,
    channelType: "telegram",
    externalEventId,
    externalConversationId: "conversation-1",
    externalSenderId: "sender-1",
    chatType: "direct",
    mentioned: false,
    text: "hello",
    thread: {},
    attachments: [],
    occurredAt: new Date("2026-07-26T00:00:00.000Z"),
    receivedAt: new Date("2026-07-26T00:00:01.000Z"),
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent: false,
    },
    rawSummary: {
      eventType: "message",
      messageId: externalEventId,
    },
    ...overrides,
  };
}
```

- [ ] **Step 2: 写失败测试——不同会话并发、同会话串行**

在 `tests/integration/channels/event-claim.test.ts` 里 `it("allows only one of eight workers to claim an event", ...)` 之后插入三个用例：

```ts
  it("claims two conversations in parallel but serializes one conversation", async () => {
    const events = createChannelEventRepository(pool);
    const base = new Date("2026-07-26T00:00:01.000Z");
    await events.accept(scope, normalizedEvent(CONNECTION_A, "conv-a-1", {
      externalConversationId: "conversation-a",
      receivedAt: base,
    }));
    await events.accept(scope, normalizedEvent(CONNECTION_A, "conv-a-2", {
      externalConversationId: "conversation-a",
      receivedAt: new Date(base.getTime() + 1_000),
    }));
    await events.accept(scope, normalizedEvent(CONNECTION_A, "conv-b-1", {
      externalConversationId: "conversation-b",
      receivedAt: new Date(base.getTime() + 2_000),
    }));

    const first = await events.claimNext("worker-1");
    const second = await events.claimNext("worker-2");
    const third = await events.claimNext("worker-3");

    expect(first?.normalizedEvent.externalEventId).toBe("conv-a-1");
    expect(second?.normalizedEvent.externalEventId).toBe("conv-b-1");
    expect(third).toBeNull();

    await events.complete(first!, null);
    await expect(
      events.claimNext("worker-4"),
    ).resolves.toMatchObject({
      normalizedEvent: { externalEventId: "conv-a-2" },
    });
  });

  it("never lets two workers claim the same conversation concurrently", async () => {
    const events = createChannelEventRepository(pool);
    const base = new Date("2026-07-26T00:00:01.000Z");
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      await events.accept(scope, normalizedEvent(
        CONNECTION_A,
        `race-${index}`,
        {
          externalConversationId: "conversation-race",
          receivedAt: new Date(base.getTime() + index * 1_000),
        },
      ));
    }

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        events.claimNext(`race-worker-${index}`),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.normalizedEvent.externalEventId)
      .toBe("race-0");
  });

  it("reclaims an expired conversation head without unblocking its follower", async () => {
    const events = createChannelEventRepository(pool, { leaseMs: 100 });
    const base = new Date("2026-07-26T00:00:01.000Z");
    await events.accept(scope, normalizedEvent(CONNECTION_A, "lease-head", {
      externalConversationId: "conversation-lease",
      receivedAt: base,
    }));
    await events.accept(scope, normalizedEvent(CONNECTION_A, "lease-next", {
      externalConversationId: "conversation-lease",
      receivedAt: new Date(base.getTime() + 1_000),
    }));

    const start = new Date(base.getTime() + 2_000);
    const first = await events.claimNext("worker-lease-old", start);
    const reclaimed = await events.claimNext(
      "worker-lease-new",
      new Date(start.getTime() + 101),
    );

    expect(first?.normalizedEvent.externalEventId).toBe("lease-head");
    expect(reclaimed?.normalizedEvent.externalEventId).toBe("lease-head");
    await expect(
      events.complete(first!, null, new Date(start.getTime() + 102)),
    ).resolves.toBe(false);
    await expect(
      events.claimNext("worker-lease-third", new Date(start.getTime() + 102)),
    ).resolves.toBeNull();
  });

  it("blocks a conversation behind pending attachments until the grace period ends", async () => {
    const events = createChannelEventRepository(pool, {
      pendingAttachmentBlockMs: 60_000,
    });
    const base = new Date("2026-07-26T00:00:01.000Z");
    await events.accept(
      scope,
      normalizedEvent(CONNECTION_A, "pending-head", {
        externalConversationId: "conversation-pending",
        receivedAt: base,
      }),
      { initialStatus: "pending_attachments", failureCode: null },
    );
    await events.accept(scope, normalizedEvent(CONNECTION_A, "pending-next", {
      externalConversationId: "conversation-pending",
      receivedAt: new Date(base.getTime() + 1_000),
    }));

    await expect(
      events.claimNext("pending-worker", new Date(base.getTime() + 2_000)),
    ).resolves.toBeNull();

    await expect(
      events.claimNext("pending-worker", new Date(base.getTime() + 61_001)),
    ).resolves.toMatchObject({
      normalizedEvent: { externalEventId: "pending-next" },
    });
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/integration/channels/event-claim.test.ts -t "conversation"`
Expected: FAIL。第一个用例的 `third` 会拿到 `conv-a-2` 而不是 `null`；第二个用例会有多条 claim 成功；第三个用例最后一次 `claimNext` 会拿到 `lease-next`；第四个用例第一次 `claimNext` 会直接拿到 `pending-next`。

- [ ] **Step 4: 给 repository 增加宽限期选项**

`src/server/channels/runtime/event-repository.ts` 文件头常量区（约 13 行）新增：

```ts
const DEFAULT_EVENT_LEASE_MS = 60_000;
// An event waiting for attachments normally leaves this state inside the same
// inbound request. If the process dies mid-download the row would block its
// conversation forever, so it only holds the queue for a bounded window.
const DEFAULT_PENDING_ATTACHMENT_BLOCK_MS = 300_000;
```

`ChannelEventRepositoryOptions`（约 75-77 行）改为：

```ts
export type ChannelEventRepositoryOptions = Readonly<{
  leaseMs?: number;
  pendingAttachmentBlockMs?: number;
}>;
```

`createChannelEventRepository` 里 `leaseMs` 之后（约 111 行）新增：

```ts
  const pendingAttachmentBlockMs = positiveLease(
    options.pendingAttachmentBlockMs
      ?? DEFAULT_PENDING_ATTACHMENT_BLOCK_MS,
  );
```

- [ ] **Step 5: 改写 claimNext 的 SQL**

把 `claimNext`（约 229-272 行）整体替换为：

```ts
    async claimNext(
      owner: string,
      now = new Date(),
    ): Promise<ClaimedChannelEvent | null> {
      assertOwner(owner);
      const result = await pool.query<ChannelEventRow>(
        `WITH candidate AS (
           SELECT event.id
           FROM channel_inbound_events AS event
           WHERE (
             event.status = 'accepted'
             OR (
                event.status = 'running'
                AND event.claim_expires_at <= $1
              )
           )
             AND (
               event.reply_handle_required = false
               OR EXISTS (
                 SELECT 1
                 FROM channel_reply_handles AS handle
                 WHERE handle.event_id = event.id
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM channel_inbound_events AS earlier
               WHERE earlier.connection_id = event.connection_id
                 AND earlier.external_conversation_id
                   = event.external_conversation_id
                 AND (earlier.received_at, earlier.id)
                   < (event.received_at, event.id)
                 AND (
                   earlier.status IN ('accepted', 'running')
                   OR (
                     earlier.status = 'pending_attachments'
                     AND earlier.received_at >
                       $1 - ($4::integer * interval '1 millisecond')
                   )
                 )
             )
           ORDER BY event.received_at, event.id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE channel_inbound_events AS event
         SET status = 'running',
             claim_owner = $2,
             claim_expires_at =
               $1 + ($3::integer * interval '1 millisecond'),
             attempts = event.attempts + 1,
             updated_at = $1
         FROM candidate
         WHERE event.id = candidate.id
         RETURNING event.*`,
        [now, owner, leaseMs, pendingAttachmentBlockMs],
      );
      const row = result.rows[0];
      return row ? asClaim(mapEventRow(row)) : null;
    },
```

`NOT EXISTS` 子查询就是"我是本会话未完成事件里最老的一条"这条约束。行比较 `(received_at, id) < (received_at, id)` 是严格小于，所以不会把自己算进阻塞者。

- [ ] **Step 6: 加部分索引**

`src/server/db/schema.sql` 里 `channel_inbound_events` 已有索引定义之后，追加：

```sql
CREATE INDEX IF NOT EXISTS
  idx_channel_inbound_events_conversation_backlog
  ON channel_inbound_events (
    connection_id, external_conversation_id, received_at, id
  )
  WHERE status IN ('pending_attachments', 'accepted', 'running');
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/integration/channels/event-claim.test.ts`
Expected: PASS，整个文件全绿（包含既有的去重、租约、附件用例）。

- [ ] **Step 8: 运行相邻集成测试确认无回归**

Run: `npx vitest run tests/integration/channels/end-to-end.test.ts`
Expected: PASS。该文件里同会话的多次 `runOne` 都是对同一条事件的重试或已完成后的下一步，不受新约束影响。

- [ ] **Step 9: Commit**

```bash
git add src/server/channels/runtime/event-repository.ts src/server/db/schema.sql tests/integration/channels/event-claim.test.ts
git commit -m "feat(P1-13): 事件领取按会话串行以支持跨会话并发"
```

---

### Task 2: 投递侧按会话串行领取

**Files:**
- Modify: `src/server/channels/runtime/delivery-repository.ts`（`claimNext`，约 264-299 行）
- Modify: `src/server/db/schema.sql`（新增一个部分索引）
- Test: `tests/integration/channels/event-claim.test.ts`

**Interfaces:**
- Consumes: Task 1 里扩展过的 `normalizedEvent(connectionId, externalEventId, overrides?)`。
- Produces: `claimNext(owner: string, now?: Date): Promise<ClaimedChannelDelivery | null>` 签名不变，语义变为"只领取本会话未完成投递中最老的一条"。

- [ ] **Step 1: 增加可批量播种助手消息的测试辅助函数**

`channel_deliveries` 上有 `UNIQUE (connection_id, assistant_message_id)`，所以同一连接上的多条投递必须各自绑定不同的助手消息，不能复用现有 `seedAssistantMessage()` 的单条固定消息。在 `tests/integration/channels/event-claim.test.ts` 里 `seedAssistantMessage`（约 1175-1195 行）之后新增：

```ts
  async function seedAssistantMessages(
    count: number,
  ): Promise<string[]> {
    await pool.query(
      `INSERT INTO conversations (
         id, user_id, agent_id, channel, title
       )
       VALUES ($1, $2, $3, 'telegram', 'Channel conversation')
       ON CONFLICT (id) DO NOTHING`,
      [CONVERSATION_ID, USER_ID, AGENT_ID],
    );
    const ids = Array.from(
      { length: count },
      (_, index) =>
        `40000000-0000-4000-8000-0000000001${
          String(index).padStart(2, "0")
        }`,
    );
    for (const id of ids) {
      await pool.query(
        `INSERT INTO messages (
           id, user_id, agent_id, conversation_id, role, content
         )
         VALUES ($1, $2, $3, $4, 'assistant', 'persisted reply')`,
        [id, USER_ID, AGENT_ID, CONVERSATION_ID],
      );
    }
    return ids;
  }
```

- [ ] **Step 2: 写失败测试——投递按会话串行**

在 `it("creates one delivery for one persisted assistant message", ...)` 之后插入三个用例：

```ts
  it("claims deliveries for two conversations in parallel but serializes one", async () => {
    const deliveries = createChannelDeliveryRepository(pool);
    const events = createChannelEventRepository(pool);
    const messageIds = await seedAssistantMessages(3);
    const enqueue = async (
      index: number,
      externalEventId: string,
      conversation: string,
    ) => {
      const accepted = await events.accept(
        scope,
        normalizedEvent(CONNECTION_A, externalEventId, {
          externalConversationId: conversation,
        }),
      );
      return deliveries.enqueue({
        scope,
        eventId: accepted.event.id,
        connectionId: CONNECTION_A,
        assistantMessageId: messageIds[index]!,
        body: `reply for ${externalEventId}`,
        recipient: { externalConversationId: conversation },
      });
    };

    const firstOfA = await enqueue(0, "delivery-a-1", "conversation-a");
    const secondOfA = await enqueue(1, "delivery-a-2", "conversation-a");
    const firstOfB = await enqueue(2, "delivery-b-1", "conversation-b");

    const claimA = await deliveries.claimNext("delivery-worker-1");
    const claimB = await deliveries.claimNext("delivery-worker-2");
    const blocked = await deliveries.claimNext("delivery-worker-3");

    expect(claimA?.id).toBe(firstOfA.delivery.id);
    expect(claimB?.id).toBe(firstOfB.delivery.id);
    expect(blocked).toBeNull();

    await expect(deliveries.markSent(claimA!)).resolves.toBe(true);
    await expect(
      deliveries.claimNext("delivery-worker-4"),
    ).resolves.toMatchObject({ id: secondOfA.delivery.id });
  });

  it("holds a conversation while its earliest delivery waits to retry", async () => {
    const deliveries = createChannelDeliveryRepository(pool);
    const events = createChannelEventRepository(pool);
    const messageIds = await seedAssistantMessages(2);
    const enqueue = async (index: number, externalEventId: string) => {
      const accepted = await events.accept(
        scope,
        normalizedEvent(CONNECTION_A, externalEventId, {
          externalConversationId: "conversation-retry",
        }),
      );
      return deliveries.enqueue({
        scope,
        eventId: accepted.event.id,
        connectionId: CONNECTION_A,
        assistantMessageId: messageIds[index]!,
        body: `reply for ${externalEventId}`,
        recipient: {
          externalConversationId: "conversation-retry",
        },
      });
    };

    const head = await enqueue(0, "delivery-retry-1");
    await enqueue(1, "delivery-retry-2");
    const now = new Date();
    const claim = await deliveries.claimNext("retry-worker", now);
    expect(claim?.id).toBe(head.delivery.id);
    await expect(deliveries.scheduleRetry(
      claim!,
      new Date(now.getTime() + 60_000),
      "network_unreachable",
      now,
    )).resolves.toBe(true);

    await expect(
      deliveries.claimNext(
        "retry-follower-worker",
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toBeNull();
  });

  it("keeps a node-bound delivery from blocking its conversation", async () => {
    const deliveries = createChannelDeliveryRepository(pool);
    const events = createChannelEventRepository(pool);
    const messageIds = await seedAssistantMessages(2);
    const enqueue = async (index: number, externalEventId: string) => {
      const accepted = await events.accept(
        scope,
        normalizedEvent(CONNECTION_A, externalEventId, {
          externalConversationId: "conversation-node",
        }),
      );
      return deliveries.enqueue({
        scope,
        eventId: accepted.event.id,
        connectionId: CONNECTION_A,
        assistantMessageId: messageIds[index]!,
        body: `reply for ${externalEventId}`,
        recipient: {
          externalConversationId: "conversation-node",
        },
      });
    };

    const head = await enqueue(0, "delivery-node-1");
    const next = await enqueue(1, "delivery-node-2");
    await pool.query(
      `UPDATE channel_deliveries
       SET status = 'waiting_node',
           claim_owner = NULL,
           claim_expires_at = NULL
       WHERE id = $1`,
      [head.delivery.id],
    );

    await expect(
      deliveries.claimNext("node-unblocked-worker"),
    ).resolves.toMatchObject({ id: next.delivery.id });
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/integration/channels/event-claim.test.ts -t "conversation"`
Expected: FAIL。第一个用例的 `blocked` 会拿到 `secondOfA` 而不是 `null`；第二个用例会拿到 `delivery-retry-2` 而不是 `null`。第三个用例本来就应当 PASS（`waiting_node` 不阻塞是要保住的现状）。

- [ ] **Step 4: 改写投递侧 claimNext 的 SQL**

把 `src/server/channels/runtime/delivery-repository.ts` 的 `claimNext`（约 264-299 行）整体替换为：

```ts
    async claimNext(
      owner: string,
      now = new Date(),
    ): Promise<ClaimedChannelDelivery | null> {
      assertOwner(owner);
      const result = await pool.query<DeliveryRow>(
        `WITH candidate AS (
           SELECT delivery.id
           FROM channel_deliveries AS delivery
           WHERE (
             (
               delivery.status IN ('queued', 'retry')
               AND delivery.next_attempt_at <= $1
             )
             OR (
               delivery.status = 'running'
               AND delivery.claim_expires_at <= $1
             )
           )
             AND NOT EXISTS (
               SELECT 1
               FROM channel_deliveries AS earlier
               WHERE earlier.connection_id = delivery.connection_id
                 AND earlier.recipient->>'externalConversationId'
                   = delivery.recipient->>'externalConversationId'
                 AND earlier.status IN ('queued', 'running', 'retry')
                 AND (earlier.created_at, earlier.id)
                   < (delivery.created_at, delivery.id)
             )
           ORDER BY
             delivery.next_attempt_at,
             delivery.created_at,
             delivery.id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE channel_deliveries AS delivery
         SET status = 'running',
             claim_owner = $2,
             claim_expires_at =
               $1 + ($3::integer * interval '1 millisecond'),
             attempts = delivery.attempts + 1,
             updated_at = $1
         FROM candidate
         WHERE delivery.id = candidate.id
         RETURNING delivery.*`,
        [now, owner, leaseMs],
      );
      const row = result.rows[0];
      return row ? asClaim(mapDeliveryRow(row)) : null;
    },
```

会话内先后用 `(created_at, id)` 而不是 `next_attempt_at`：否则一条进入退避重试的回复会被排到后面，导致聊天窗口里回复顺序与提问顺序相反。`waiting_node` 不在未完成集合里，因此不阻塞同会话后续投递。

- [ ] **Step 5: 加部分索引**

`src/server/db/schema.sql` 里 `channel_deliveries` 已有索引定义之后，追加：

```sql
CREATE INDEX IF NOT EXISTS
  idx_channel_deliveries_conversation_backlog
  ON channel_deliveries (
    connection_id,
    (recipient->>'externalConversationId'),
    created_at,
    id
  )
  WHERE status IN ('queued', 'running', 'retry');
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/integration/channels/event-claim.test.ts tests/integration/channels/end-to-end.test.ts`
Expected: 两个文件全 PASS。

- [ ] **Step 7: 运行投递 worker 单测确认无回归**

Run: `npx vitest run tests/unit/channels/delivery-worker.test.ts`
Expected: PASS。该文件用的是内存假仓储，不经过 SQL。

- [ ] **Step 8: Commit**

```bash
git add src/server/channels/runtime/delivery-repository.ts src/server/db/schema.sql tests/integration/channels/event-claim.test.ts
git commit -m "feat(P1-13): 投递领取按会话串行以避免分段交叉"
```

---

### Task 3: 并发与连接池配置

**Files:**
- Modify: `src/server/config/env.ts`（`envSchema` 约 76-96 行、`readEnv` 返回对象约 136 行起）
- Modify: `src/server/db/client.ts`（`getPool`，8-14 行）
- Modify: `.env.example`
- Modify: `docs/env.md`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `readEnv()` 返回值新增两个字段，Task 4 会用到：
  - `channelWorkerConcurrency: number`（1-32，默认 4）
  - `databasePoolMax: number`（未显式配置时为 `Math.max(10, channelWorkerConcurrency * 4 + 8)`）

- [ ] **Step 1: 写失败测试**

在 `tests/unit/env.test.ts` 末尾的 `describe` 内追加：

```ts
  it("defaults channel worker concurrency to four and sizes the pool for it", () => {
    const env = readEnv({
      DATABASE_URL: "postgres://localhost:5432/digitalmate",
    });

    expect(env.channelWorkerConcurrency).toBe(4);
    expect(env.databasePoolMax).toBe(24);
  });

  it("keeps the pool at its previous floor when concurrency is disabled", () => {
    const env = readEnv({
      DATABASE_URL: "postgres://localhost:5432/digitalmate",
      CHANNEL_WORKER_CONCURRENCY: "1",
    });

    expect(env.channelWorkerConcurrency).toBe(1);
    expect(env.databasePoolMax).toBe(12);
  });

  it("lets an explicit pool size win over the derived one", () => {
    const env = readEnv({
      DATABASE_URL: "postgres://localhost:5432/digitalmate",
      CHANNEL_WORKER_CONCURRENCY: "8",
      DATABASE_POOL_MAX: "15",
    });

    expect(env.databasePoolMax).toBe(15);
  });

  it("rejects a concurrency beyond the supported range", () => {
    expect(() => readEnv({
      DATABASE_URL: "postgres://localhost:5432/digitalmate",
      CHANNEL_WORKER_CONCURRENCY: "33",
    })).toThrow();
  });
```

第二个用例期望 12 是因为 `max(10, 1 × 4 + 8) = 12`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/env.test.ts -t "concurrency"`
Expected: FAIL，`env.channelWorkerConcurrency` 为 `undefined`。

- [ ] **Step 3: 加 env schema 字段**

`src/server/config/env.ts` 的 `envSchema` 里，`CHANNEL_GATEWAY_PORT` 之前插入：

```ts
  CHANNEL_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(4),
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional(),
```

- [ ] **Step 4: 在 readEnv 返回值里暴露两个字段**

`readEnv` 的返回对象里，`databaseUrl` 之后插入：

```ts
    channelWorkerConcurrency: parsed.CHANNEL_WORKER_CONCURRENCY,
    // Each worker loop can hold several connections during one turn, and the
    // gateway plus the periodic tick need headroom on top of that.
    databasePoolMax: parsed.DATABASE_POOL_MAX
      ?? Math.max(10, parsed.CHANNEL_WORKER_CONCURRENCY * 4 + 8),
```

- [ ] **Step 5: 让主连接池使用配置值**

`src/server/db/client.ts` 的 `getPool`（8-14 行）改为：

```ts
export function getPool(): Pool {
  if (!pool) {
    const env = readEnv();
    pool = new Pool({
      connectionString: env.databaseUrl,
      max: env.databasePoolMax,
    });
  }
  return pool;
}
```

`getTurnLockPool` 与 `getUserDataLockPool` 不动：前者固定 `max: 2`，后者是 advisory lock 专用池。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: PASS。

- [ ] **Step 7: 同步 .env.example 与 docs/env.md**

`.env.example` 在渠道相关配置附近追加：

```
# 渠道 worker 并发数：不同会话之间并发处理，同一会话仍串行。设为 1 等同旧行为。
CHANNEL_WORKER_CONCURRENCY=4
# 主数据库连接池上限。留空按 max(10, 并发数 × 4 + 8) 推算。
# DATABASE_POOL_MAX=24
```

`docs/env.md` 的环境变量表格追加两行：

```
| `CHANNEL_WORKER_CONCURRENCY` | 否 | 默认 `4`。事件与投递各启动的 worker 循环数；不同会话并发、同一会话串行；设为 `1` 等同并发化之前的行为 |
| `DATABASE_POOL_MAX` | 否 | 主连接池上限，留空按 `max(10, CHANNEL_WORKER_CONCURRENCY × 4 + 8)` 推算；需确认不超过 PostgreSQL 的 `max_connections` |
```

- [ ] **Step 8: Commit**

```bash
git add src/server/config/env.ts src/server/db/client.ts .env.example docs/env.md tests/unit/env.test.ts
git commit -m "feat(P1-13): 增加渠道并发数与连接池上限配置"
```

---

### Task 4: 启动多条 worker 循环

**Files:**
- Modify: `src/server/channels/runtime/start.ts`（事件与投递 worker 构造约 521-583 行）
- Test: `tests/unit/channels/runtime-start.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `env.channelWorkerConcurrency`；Task 1 与 Task 2 已按会话串行的 `claimNext`。
- Produces: `startChannelRuntime` 的返回值与入参签名不变，仅内部并发度改变。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/channels/runtime-start.test.ts` 末尾追加。该文件已从 `@/server/channels/runtime/start` 导入过工厂函数，本用例只验证"每条循环有独立 owner 且 owner 数量等于并发数"这个可观测契约：

```ts
describe("channel worker concurrency wiring", () => {
  it("gives every event and delivery loop its own claim owner", async () => {
    const owners = new Set<string>();
    const events = {
      claimNext: vi.fn(async (owner: string) => {
        owners.add(owner);
        return null;
      }),
    };
    const workers = Array.from({ length: 4 }, (_, index) =>
      createChannelEventWorker({
        owner: `runtime:event:${index}`,
        events: events as never,
        executor: { execute: vi.fn() } as never,
      }),
    );

    await Promise.all(workers.map((worker) => worker.runOne()));

    expect(owners).toEqual(new Set([
      "runtime:event:0",
      "runtime:event:1",
      "runtime:event:2",
      "runtime:event:3",
    ]));
  });
});
```

文件顶部补充导入：

```ts
import {
  createChannelEventWorker,
} from "@/server/channels/runtime/event-worker";
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run tests/unit/channels/runtime-start.test.ts -t "claim owner"`
Expected: PASS。`createChannelEventWorker` 的入参已是 `{ owner, events, executor }`，`claimNext` 返回 `null` 时 `runOne` 直接返回 `false`、不会触发心跳，所以假仓储足够。这个用例锁定"每条循环有独立 owner"这一契约，为 Step 3 的接线提供回归护栏。

- [ ] **Step 3: 把单条循环改为 N 条**

`src/server/channels/runtime/start.ts` 中，把 `const eventWorker = createChannelEventWorker({...})`（521-525 行）替换为：

```ts
  const concurrency = input.env.channelWorkerConcurrency;
  const eventWorkers = Array.from(
    { length: concurrency },
    (_, index) => createChannelEventWorker({
      owner: `${owner}:event:${index}`,
      events: input.repositories.channelEvents,
      executor: leasedExecutor,
    }),
  );
```

把 `const deliveryWorker = createChannelDeliveryWorker({...})`（553-560 行）替换为：

```ts
  const deliveryWorkers = Array.from(
    { length: concurrency },
    (_, index) => createChannelDeliveryWorker({
      owner: `${owner}:delivery:${index}`,
      deliveries: input.repositories.channelDeliveries,
      transport: deliveryTransport,
      loadCadence: async (delivery) => (
        await input.repositories.settings.get(delivery.scope)
      ).cadence,
    }),
  );
```

把两条循环（562-569 行）替换为：

```ts
  const eventLoops = eventWorkers.map((worker) =>
    startWorkerLoop(
      (signal) => worker.runOne({ signal }),
      "channel_event_worker_failed",
    ),
  );
  const deliveryLoops = deliveryWorkers.map((worker) =>
    startWorkerLoop(
      (signal) => worker.runOne({ signal }),
      "channel_delivery_worker_failed",
    ),
  );
```

把 `stop()`（572-582 行）里的两行 `await` 替换为：

```ts
        await Promise.all(eventLoops.map((loop) => loop.stop()));
        await Promise.all(deliveryLoops.map((loop) => loop.stop()));
```

`leasedExecutor` 与 `deliveryTransport` 可以被多个 worker 共享：前者每次调用都基于传入的 claim 取租约，不持有跨调用状态。

- [ ] **Step 4: 类型检查与关停测试**

Run: `npm run typecheck`
Expected: 无错误。

Run: `npx vitest run tests/unit/channels/runtime-start.test.ts tests/unit/agent-service-shutdown.test.ts`
Expected: PASS，关停路径能等待全部循环退出。

- [ ] **Step 5: Commit**

```bash
git add src/server/channels/runtime/start.ts tests/unit/channels/runtime-start.test.ts
git commit -m "feat(P1-13): 按配置启动多条渠道 worker 循环"
```

---

### Task 5: 全量回归与文档收口

**Files:**
- Modify: `docs/prd.md`（P1-13 渠道运行时相关段落）
- Test: 全量 vitest

**Interfaces:**
- Consumes: Task 1-4 的全部改动。
- Produces: 无新接口。

- [ ] **Step 1: 跑红线回归用例**

Run: `npx vitest run -t "普通问候"`
Expected: PASS，0 次搜索。

Run: `npx vitest run -t "未授权"`
Expected: PASS，未授权实时问题 0 次搜索。

Run: `npx vitest run -t "主动"`
Expected: PASS，遗留无授权分享不投递、同一主动任务重复执行只写入 1 条可见消息。

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS。若有用例失败，先判断它是否依赖"同一会话可同时领取两条记录"这一旧行为——若是，按新语义更新该用例的断言并在 commit message 里说明；若不是，说明实现有问题，回到对应 Task 修复。

- [ ] **Step 3: 跑 lint 与类型检查**

Run: `npm run lint && npm run typecheck`
Expected: 均无错误。

- [ ] **Step 4: 更新 PRD**

`docs/prd.md` 中 P1-13 渠道运行时的描述补上一句并发口径，与 spec 一致：不同会话（不同群、不同单聊）并发处理，同一会话严格串行且保持 FIFO，并发度由 `CHANNEL_WORKER_CONCURRENCY` 控制，默认 4。

- [ ] **Step 5: Commit**

```bash
git add docs/prd.md
git commit -m "docs(P1-13): 记录渠道消息按会话并发的口径"
```

- [ ] **Step 6: 人工验收清单**

部署后按 spec 第 6 节执行：

1. 在两个钉钉群同时发消息，两个群各自独立开始回复，不互相等待。
2. 在同一个群连发两条消息，回复顺序与提问顺序一致，分段不交叉。
3. 检查 PostgreSQL 的 `max_connections` 能容纳 Web 与 Agent 两个进程的连接池之和。
