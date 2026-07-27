# 智能体实例管理设计规格（第一步：选择与编辑非默认智能体）

> 日期：2026-07-28
>
> 状态：已确认
>
> 关联范围：P1-14 独立专业智能体 Alvin MVP、P0-8 管理后台（QwenPaw Console）
>
> 上游基线：QwenPaw `v2.0.0.post3`（Console 补丁叠加，不改动 vendored 快照）

## 1. 背景

P1-14 已经交付 Alvin 的服务端能力：幂等创建固定 `slug=alvin` 实例、独立人设、六项售前 Skill、与 DigitalMate 双向隔离的记忆与资源、钉钉私聊/群聊上下文隔离与 `admin_from` 权限门。生产库中 Alvin 实例已按幂等脚本创建完成（`slug=alvin`，`is_default=false`，`inherits_user_resources=false`）。

但管理后台无法给 Alvin 配置钉钉连接，原因不在服务端：

- 兼容层 router 早已支持按 `x-digitalmate-agent-id` 解析任意活跃智能体作用域，所有 `/api/admin/compat/*` 接口都走这条链路。
- Console 侧的补丁 `patches/qwenpaw-console/0004-api-compat.patch` 写死了 `SECONDARY_AGENT_CAPABILITY = "unsupported"`，`AgentSelector` 只显示 `is_default === true` 的智能体，`authHeaders` 也只在选中项等于已校验默认智能体时才发送作用域请求头。
- 渠道连接按 `channel_connections.agent_id` 硬绑定，因此后台不能切换作用域，就不可能建出属于 Alvin 的钉钉连接。

也就是说，阻塞点是前端的自我限制，而不是缺少后端能力。

## 2. 已确认的产品决策

1. **分两步交付**。第一步只开放"创建固定 Alvin + 后台可切换到 Alvin 作用域 + 查看和编辑 Alvin 人设"；任意智能体新建与删除留到第二步。
2. **全部 Console 页面跟随选中作用域**，且允许编辑非默认智能体的人设与主动性、节奏、搜索设置。不按页面做白名单限制，因为服务端本就统一按请求头解析作用域，按页面设限只会增加代码而不增加安全性。
3. **Web 前台不切换智能体**。首页聊天继续硬编码默认智能体（`/api/**` 全部使用 `resolveDefaultAgentScope`），Alvin 首期只经钉钉接入，与 `docs/alvin-mvp.md` 口径一致。
4. **Alvin 实例由运维脚本幂等创建**，不在第一步的 Console 上放"新建"入口，避免出现"点新建但只能建出 Alvin"的误导语义。
5. **UI 门控由后端能力驱动**，不再在前端硬编码。第二步开放任意新建与删除时，只需翻后端开关，前端不必再改一次并重建产物。

## 3. 第一步范围

**包含**：

- 后端在智能体列表响应里如实返回可用写能力与按实例区分的描述。
- Console 可以列出并选中非默认智能体，选中后所有页面数据跟随该作用域。
- Console 可以查看并编辑非默认智能体的人设与设置。
- 用户在 Alvin 作用域下创建钉钉连接并填写 `admin_from` 等字段（该字段已在钉钉 manifest 中声明为列表字段，表单由 manifest 驱动自动渲染，无需额外开发）。

**不包含**（留给第二步或继续冻结）：

- 任意智能体的新建、克隆、导入、删除。
- 智能体的启用停用、置顶、排序（后端目前是"只接受不改变现状的请求"的占位实现）。
- Web 前台切换到 Alvin。
- 多智能体协作、客户空间、自动报价、多智能体备份恢复。

## 4. 后端设计

改动集中在兼容层，不触碰 Agent 执行内核、记忆、搜索与主动消息链路。

### 4.1 能力字段收敛与扩展

`src/server/admin/compat/handlers/agents.ts` 目前有四处各自硬编码的 `capabilities` 字面量。收敛为单一常量源，用于详情、创建与更新响应，并新增到列表响应的顶层（当前列表完全不返回该字段，前端因此无从判断能力）。能力是账号级的，不按实例区分，因此放在列表顶层而不是每个摘要里。

字段在上游既有的 `multi_agent`、`create`、`import`、`clone`、`delete` 之外补充 `toggle`、`pin`、`reorder` 三项。原因是这三个操作后端只接受不改变现状的请求，其余情况返回 501，前端必须知道要禁用对应控件。第一步除 `multi_agent` 为 `true` 外，其余全部为 `false`。

`capabilities` 的语义明确为"当前可用的写操作"，不表达"能否选中或编辑某个实例"——后者是服务端一直支持的既有能力，不需要开关表达。

### 4.2 按实例区分描述

列表与详情响应中的 `description` 目前硬编码为默认分身文案，切到 Alvin 会显示错误描述。改为按 `slug` 映射：`digitalmate` 用默认分身描述，`alvin` 用售前解决方案架构师描述，未知 slug 回退显示名。`slug` 已存在于 `DigitalAgent` 类型与 `digital_agents` 表，无需数据模型改动。

### 4.3 不改动的部分

`src/server/agents/features.ts` 的 `assertMultiAgentMutationAllowed` 保持现状：`create` 仅放行固定 Alvin 创建，`delete`、`clone`、`import` 继续抛 501 与稳定能力码。第一步不新增任何写能力。

## 5. 前端设计

新增 `patches/qwenpaw-console/0005-agent-scope.patch`，叠加在 0004 之后，并在 `scripts/qwenpaw-console/prepare.mjs` 的 `PATCHES` 列表登记。不修改 320 KB 的 0004 补丁，避免在大体积 unified diff 上做手术导致 `git apply` 失败。

补丁生成方式：把 `vendor/qwenpaw-console/console` 快照复制到临时 git 仓库，依次应用 0001 至 0004 并提交为基线，在基线上修改源码后用 `git diff` 导出 0005。

改动文件与内容：

| 文件 | 改动 |
|---|---|
| `src/api/agentScope.ts` | 把"已校验的默认智能体"泛化为"已校验的活跃智能体集合"，集合来源是 `GET /agents` 返回的活跃实例，默认智能体保留特殊语义用于回退 |
| `src/api/authHeaders.ts` | 选中项是合法 UUID 且在已校验集合内即发送 `x-digitalmate-agent-id`（与 `X-Agent-Id` 继续双写），不再要求等于默认智能体 |
| `src/components/AgentSelector/index.tsx` | 列出所有活跃智能体（默认置顶）并可切换，去掉只显示 `is_default` 的过滤 |
| `src/stores/agentStore.ts` | 去掉 `refreshAgents` 强制重置为默认的逻辑，改为仅当选中项不在活跃列表时回退默认 |
| `src/pages/Settings/Agents/*` | 拆分单一门控：查看与编辑人设对非默认开放；新建、删除、克隆、导入、启用停用、置顶、排序按后端 `capabilities` 禁用并给出 Tooltip |

补丁内同步更新其自带的前端单测（`AgentSelector.test.tsx`、`authHeaders.test.ts` 及 Agents 页测试）。

## 6. 数据流与错误处理

数据流：用户在 Console 侧栏选中 Alvin，`agentStore.selectedAgent` 保存 Alvin 的 UUID，所有 `/api/admin/compat/*` 请求带上 `x-digitalmate-agent-id`，router 通过 `getActive` 解析作用域，渠道配置写入 `channel_connections(agent_id = Alvin)`。

错误处理沿用既有语义，不新增错误码：

- 选中的智能体不存在或非活跃：后端 404 `agent_not_found` 或 409 `active_agent_required`；前端回退默认并提示，上游已有 `currentAgentDeleted` 与 `currentAgentDisabled` 文案。
- 路径 ID 与请求头不一致：统一 404，不枚举实例存在性。
- 被关闭的能力：501 `capability_disabled` 加稳定能力码，作为 UI 禁用之外的兜底。
- 人设并发编辑：`revision` 乐观锁，冲突返回 409 `revision_conflict`，前端提示重载。

## 7. 测试与验收

后端 vitest 补充用例：列表返回 `capabilities` 与按 slug 的描述；Alvin 作用域下人设读取与更新成功；已关闭能力仍返回 501 与稳定能力码；渠道配置在两个智能体之间互不可见。

前端执行 `npm run console:test`（隔离目录内运行上游加补丁的 vitest）与 `npm run console:build` 的产物前缀校验。检查 `playwright.admin-cutover.config.ts` 覆盖的后台切换用例，若其断言依赖"只存在默认智能体"则同步更新。

按 AGENTS.md 约定执行全量 vitest，包含四条固定回归用例：普通问候 0 次搜索、未授权实时问题 0 次搜索、遗留无授权分享不投递、同一主动任务重复执行只写入 1 条可见消息。本次改动不触碰搜索、调度与消息写入链路，回归用例作为护栏执行。

人工验收：后台切到 Alvin 后创建钉钉连接并保存 `admin_from`；切回 DigitalMate 确认看不到该连接；两个作用域的会话与记忆互不可见。

## 8. 文档与上线

文档同步：`docs/prd.md` 的 P1-14 与 `docs/alvin-mvp.md` 第 2、3 节改为分步口径，写明 Alvin 由运维脚本幂等创建、后台切换作用域后配置钉钉连接、任意新建与删除仍未开放。

上线顺序：

1. 生产创建 Alvin 实例（已完成，幂等脚本，二次执行返回同一实例且不产生重复 Skill）。
2. 本地 `npm run console:build` 重建 `public/_admin-console`，部署时额外上传 Console 产物包，服务器继续使用 `PREBUILT_CONSOLE=1` 以避免构建期内存耗尽。
3. 用户在后台切到 Alvin 配置钉钉机器人信息。

## 9. 第二步待决问题

第二步（任意智能体新建与删除）单独走一次设计确认，需要先回答：

- 删除的语义是物理删除还是归档。`digital_agents` 没有 `deleted_at`，物理删除会级联 20 余张带 `(user_id, agent_id)` 外键的表（会话、记忆、渠道连接、任务、目标等），审计表按 `SET NULL` 保留，而 `skills.origin_agent_id` 没有外键、不会自动清理。
- 新建时人设、资源授权与 Skill 的初始化策略，以及是否允许自定义 slug。
- 默认智能体的保护规则与"至多一个默认"约束下的默认切换流程。
- 启用停用、置顶、排序三个占位实现是否一并做实。
