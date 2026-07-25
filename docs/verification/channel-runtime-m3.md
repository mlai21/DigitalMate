# QwenPaw 渠道事务运行时 M3 验收

## 验收范围

- 需求：P1-13 多渠道入口、P1-5 群聊插话，以及搜索、附件、主动消息和数据隔离红线。
- 渠道：Telegram、Slack、飞书、钉钉。
- 运行时：Webhook 只鉴权、标准化、持久化并 ACK；Agent 与平台发送由独立事务 Worker 执行。
- 数据边界：所有连接、事件、执行日志、回复句柄和 Delivery 均绑定 `user_id + agent_id`。

## 强制红线

| 红线 | 自动化证据 | 结果 |
| --- | --- | --- |
| 普通问候 0 次搜索 | `search-gate.test.ts`：`does not treat casual chat as an explicit request`、`fails closed for ordinary messages without any model call` | 通过 |
| 未授权实时问题 0 次搜索 | `search-gate.test.ts`：`blocks implicit realtime searches when the user did not authorize this turn` | 通过 |
| 当前附件 0 搜索、0 Skill、0 其他工具 | `channel-agent-turn.test.ts`：`附件上下文禁止搜索、Skill 与其他工具`；`run-agent.test.ts`：`keeps all tools closed while current or historical attachment context exists, then restores them` | 通过 |
| 历史附件仍关闭搜索、Skill 和工具 | `channel-agent-turn.test.ts`：`历史消息含附件时同样禁止搜索和 Skill`；`chat-route.test.ts`：`restores tools only after attachment messages leave recent history` | 通过 |
| 遗留无授权分享 0 投递 | `proactive-delivery.test.ts`：`cancels legacy shares without an explicit subscription or scheduled digest authorization`、`cancels shares that name an authorization type but have no persisted source id` | 通过 |
| 同一主动任务只产生 1 条可见消息 | `proactive-delivery.test.ts`：`消息已存在时仍幂等补入 Delivery 队列`；`end-to-end.test.ts`：`主动任务重复入队只创建一个 Delivery` | 通过 |
| 同一外部事件只执行 1 次 Agent、写入 1 条 assistant、创建 1 个 Delivery | `event-claim.test.ts`：`accepts the same external event concurrently only once`、`creates one delivery for one persisted assistant message`；`end-to-end.test.ts`：`lets only one of eight workers run the Agent` | 通过 |
| 搜索原始标题、摘要和链接不写入 `messages` | `run-agent.test.ts`：`replaces a final answer that copies raw search titles or urls`、`replaces a final answer that copies only a long prefix of a search snippet` | 通过 |
| 群聊插话遵守频率、静默时段和繁忙退避 | `interjection.test.ts`：`allows relevant group interjection within configured limits`、`blocks quiet hours and recent bot messages`、`blocks interjection when the group conversation is busy` | 通过 |
| 跨 Agent 不可读取或操作数据 | `agent-scope-repositories.test.ts`：`isolates two agents across domain APIs and converges clear to one canonical default`；渠道表复合外键和 Repository scope 校验覆盖连接、事件、回复句柄与 Delivery | 通过 |

## 故障注入与恢复

| 故障点 | 预期恢复语义 | 自动化证据 | 结果 |
| --- | --- | --- | --- |
| `after_accept` | 事件已落库，重试不重复接收 | `end-to-end.test.ts` 参数化崩溃恢复用例 | 通过 |
| `after_claim` | 过期 lease 可恢复，旧 owner 不可完成 | `end-to-end.test.ts` 参数化崩溃恢复用例；`event-claim.test.ts`：`prevents an expired owner from completing a reclaimed event` | 通过 |
| `llm_started` | 不重复调用模型，未完成副作用标记为不确定 | `end-to-end.test.ts`：`does not call the LLM again after a crash at llm_started` | 通过 |
| `after_assistant_insert` | 复用唯一 assistant，不再执行 Agent | `end-to-end.test.ts` 参数化崩溃恢复用例 | 通过 |
| `after_delivery_insert` | 复用唯一 Delivery，仅恢复发送 | `end-to-end.test.ts` 参数化崩溃恢复用例 | 通过 |
| 平台发送失败 | 只重试持久化 Delivery，不重跑 Agent | `end-to-end.test.ts`：`retries only the persisted delivery and never reruns the Agent` | 通过 |
| 平台发送结果不确定 | 不盲目重发，进入人工可判断状态 | `end-to-end.test.ts`：`marks an unfinished platform attempt ambiguous after lease recovery`；`delivery-worker.test.ts`：`does not resend a segment whose prior platform outcome is ambiguous` | 通过 |
| 清空数据与已 claim 事件竞态 | 旧事件不能复活已清空消息 | `runtime-start.test.ts`：`清空数据删除已 claim 事件后不会复活旧消息` | 通过 |
| 回复句柄恢复 | 密钥不进入事件载荷，重复持久化仍为一行 | `end-to-end.test.ts`：`加密回复句柄不进入事件载荷且重复持久化保持一行`；`event-claim.test.ts`：`never persists attachment locators or unsealed reply secrets` | 通过 |

## 验证命令

| 命令 | 结果 |
| --- | --- |
| `npm test -- --run tests/unit/channels tests/integration/channels` | 11 个文件、100 项测试通过 |
| `npm test -- --run tests/unit/channel-webhook-routes.test.ts tests/unit/proactive-delivery.test.ts tests/unit/search-gate.test.ts tests/unit/chat-route.test.ts` | 4 个文件、82 项测试通过 |
| `npm test -- --run tests/unit/interjection.test.ts tests/unit/channel-agent-turn.test.ts tests/unit/run-agent.test.ts tests/integration/agent-scope-repositories.test.ts tests/unit/channels/runtime-start.test.ts` | 5 个文件、54 项测试通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 128 个文件、1607 项测试通过 |
| `npm run lint` | 通过；上游镜像与生成产物按边界排除 |
| `npm run build` | QwenPaw Console 与 Next.js 生产构建通过，34 个 Next.js 页面完成生成或编译 |
| `rg -n "runAgent\|web-search\|repositories\\.memories\|repositories\\.messages" src/server/channels/adapters` | 无命中 |
| `rg -n "scheduleChannelMessageHandling\|handleChannelMessage\|sendChannelMessage\|setTimeout\\(.*processChannel" src` | 无命中 |
| `rg -n "@/server/channels/(dispatch\|handler\|normalize\|outbound)" src tests` | 无命中 |
| `git diff --check` | 无输出 |

## 结论

M3 统一事务运行时满足四个现有渠道的接入、幂等、恢复、安全和 Agent 隔离要求。后续渠道只允许实现 Adapter 或受限 Node，并复用同一事件、执行日志、回复与 Delivery 账本，不得在 Adapter 内直接调用 Agent、搜索、记忆或消息仓储。
