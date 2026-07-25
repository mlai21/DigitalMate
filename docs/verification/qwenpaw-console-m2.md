# QwenPaw Console M2 验收报告

- 记录日期：2026-07-26
- 分支：`codex/qwenpaw-console`
- M2 起点：`dadfc8279d76f7de318fcbe7f9a46f381df93676`
- 最终验证头（报告提交前）：`5936203e39cf328ddb14554a74833597f75767a2`
- 验收基线：QwenPaw Console `v2.0.0.post3`
- 上游 commit：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`
- 上游目录 SHA-256：`04459760c48b596c2521dbfcd182660c5784adbecc654ed98d3eb4dc7e85a53a`
- 环境：Darwin `25.5.0` arm64、Node.js `v22.22.3`、npm `10.9.8`

## 验收结论

M2 的目标边界已经形成：现有数据完成默认数字分身归属，Agent 级数据访问使用非空
`agent_id`，Console 兼容层具备同源会话、CSRF、revision、审计、密钥加密、单数字分身
数据映射和 17 个渠道的配置合同。真实 PostgreSQL 集成测试覆盖迁移并发、跨分身隔离、
会话撤销、配置冲突、事务提交歧义恢复和渠道密钥历史。

本结论只覆盖 M2，不代表整套 QwenPaw Console 与全渠道迁移完成：

- 正式 `/admin` 尚未切换，当前可回退入口仍为 `/admin-preview`。
- 第二套数字分身和第二套独立记忆当前不开放；数据模型、选择器和 AgentScope 通路保留，
  create、clone、import、delete 均返回 `501 capability_disabled`。
- 17 个渠道本期只完成 manifest、配置、密钥和健康状态合同；真实运行时、收发适配和平台
  smoke test 分属 M3、M4，不在本报告的完成声明内。
- M3 的统一入站事件、Agent 执行、Delivery 队列和现有四渠道迁移尚未开始。
- P2 沙箱、文件任务和工具扩展继续冻结。

## 已批准差异

M2 延续已经批准的产品差异，没有把 QwenPaw 的产品身份原样暴露给用户：

- 导航、页面和交互以固定上游 Console 为基线，品牌与视觉继续使用 DigitalMate 珊瑚色体系。
- Console 的 Chat 入口返回 DigitalMate 首页，不建立第二套后台聊天。
- 单数字分身是当前唯一可用形态，多分身前后端能力位保留但操作明确禁用。
- 渠道 secret 为只写；读取接口只返回是否已配置和最后轮换时间。
- `filter_thinking`、`filter_tool_messages` 强制为 `true` 且只读。
- 二维码入口和真实渠道启停入口在运行时落地前保持隐藏或 blocked，不呈现假成功。

## M2 任务 1–8 与验收收口提交清单

| 任务 | 提交 |
|---|---|
| 1. 默认数字分身数据边界 | `ad752bd` 建立默认数字分身数据边界；`e6b529e` 保留默认分身选择与 Seed 幂等；`48e11a5` 串行化空库 Seed；`91a41df` 加固所有权与并发启动 |
| 2. AgentScope 执行边界 | `00a871b` 贯通默认分身执行作用域；`cb74e57` 收紧导出与清空边界；`6366e2d` 覆盖断开失败重试；`1b184d2` 落实资源授权；`e270357` 完善静默期与产物发布；`0a5fb68` 完善租约取消与原子提交；`05c5e94` 收紧取消链；`27bb3df` 让任务提交可安全取消 |
| 3. 会话与 CSRF | `731a6ef` 稳定嵌入式数据库清理；`ee9162e` 统一 Console 登录态与 CSRF；`49983e7` 完善会话撤销与安全回跳；`749e42f` 加固刷新与生产密钥；`29dcca1` 加固数据库关闭超时 |
| 4. 兼容路由 | `cd42574` 建立兼容 API 路由；`63d46e3` 加固原始路径与错误边界；`7c5bd1d` 统一状态路由合同；`ae23c27` 加固错误详情和请求体限制；`c4f1926` 收敛能力标识白名单 |
| 5. revision、加密与审计 | `5d67c84` 增加配置版本与加密审计；`cc057df` 防止渠道密钥进入公开配置；`ba4b299` 绑定密钥加密上下文；`598bbb4` 阻断配置泄密并限制审计事务；`94c35f9` 收紧审计错误映射 |
| 6. 单数字分身 Console | `08e7aa8` 保留单数字分身数据通路；`e516569` 修复一致性边界；`bbcfec0` 恢复配置提交确认 |
| 7. 17 渠道配置合同 | `4f30a6f` 建立渠道配置与密钥合同；`acacf2a` 修正安全合同；`3c180a4` 收紧验证错误脱敏；`424559a` 阻断凭据泄漏并稳定恢复；`492809d` 完善响应恢复与详情隔离 |
| 8. 导出、清空与安全收口 | `4097165` 扩展数据导出与安全清空；`e78b57d` 隔离资源释放失败；`1f8ff9e` 封堵清空并发与导出泄漏；`ed8a941` 加固隐私数据与渠道入口；`caa4108` 加固凭证历史与事务恢复；`7818f37` 约束凭证扫描成本与来源范围 |
| 验收收口 | `717c55e` 消除认证兼容空操作 lint 错误；`37fd59f` 消除 Console 补丁新增 lint 问题；`5936203` 同步 Console 路由拆分契约 |

## 固定上游与补丁可重放

| 验证项 | 精确命令 | 结果 |
|---|---|---|
| 上游快照 | `npm run console:verify-upstream` | 退出码 0；commit `fef7e64d984f4332d0b84a343cd209bd3ea5d316`，864 个文件通过 |
| 补丁顺序 | `npm run console:prepare`，连续两次 | 两次均按 `0001` → `0002` → `0003` → `0004` 完成 `git apply --check` 与应用 |
| 独立准备树一致性 | 两次 `prepareConsole({ keep: true })`，按相对路径和文件内容计算 SHA-256 | 两棵树均为 735 个文件，摘要均为 `00a67114d0a07524e52b717a3185cb7bc57f79ace9e13673265819f2e27a5219` |
| 生成物边界 | 扫描补丁目标，并运行 `git ls-files public/_admin-console`、`git ls-files '*.tsbuildinfo'` | 四个补丁没有修改 `dist`、`build`、`node_modules` 或构建资产；两类生成物均为 0 个跟踪文件 |

补丁文件 SHA-256：

| 补丁 | SHA-256 |
|---|---|
| `0001-brand.patch` | `00c7d8421fc10f62180a4775b30a478b429f210070fe5405c06710da5d18d62f` |
| `0002-theme.patch` | `b5699f221f31673cc903e42512f60d4581a0696f0ca9222d58d791e2f549d751` |
| `0003-route-auth.patch` | `06ef23ac6d148dd2524df3d31d26683a29ee1628139c4ca3d8715992e51b55e0` |
| `0004-api-compat.patch` | `7df9c88f0d1f02ceb29baeb66d48a03ea1f76a06e4a7206e8980e413129de517` |

## 自动化验证

根工程全量门禁最初在 M2 实现头 `7818f37` 上执行；Console 补丁完成 lint 收口并同步
根契约测试后，又在最终验证头 `5936203e39cf328ddb14554a74833597f75767a2`
重新运行根全量测试、生产构建、类型检查、补丁脚本合同和差异检查，避免用旧证据替代
受影响范围的验证。

| 验证项 | 精确命令 / 范围 | 退出码 | 数量 / 结果 |
|---|---|---:|---|
| M2 扩展目标测试 | `npm test -- --run` 加 32 个 M2 单元与集成测试文件 | 0 | 32 个文件、658 项测试通过 |
| 根全量测试 | `npm test` | 0 | 118 个测试文件、1512 项测试通过；最终验证头复跑耗时 37.30 秒 |
| 根 TypeScript | `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| M2 改动文件 lint | 从 `ad752bd^..7818f37` 以 NUL 分隔传入 205 个 `ts`、`tsx`、`mjs` 文件执行 `npx eslint` | 0 | 无 error / warning 输出 |
| 验收收口测试 lint | `npx eslint tests/unit/qwenpaw-console-scripts.test.ts` | 0 | 最终新增根测试文件改动无 error / warning |
| Console 补丁脚本合同 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts` | 0 | 1 个文件、154 项测试通过 |
| 根生产构建 | `npm run build` | 0 | 最终验证头上 Console 15116 个模块、13.76 秒；Next.js 构建成功并生成 34 个静态页面 |
| Console 全量测试与构建 | `npm run console:test` | 0 | 137 个测试文件、1233 项测试通过；随后 `tsc -b && vite build --mode production` 成功，15116 个模块，14.26 秒 |
| Console config/auth 目标测试 | `npx vitest run src/api/config.test.ts src/api/authHeaders.test.ts src/api/csrfRefresh.test.ts src/api/logout.test.ts src/api/modules/auth.test.ts src/api/request.test.ts` | 0 | 6 个文件、73 项测试通过 |
| Console 显式类型检查 | 在新准备树运行 `npx tsc -b --noEmit` | 0 | 无 TypeScript 错误 |
| Console 独立发布构建 | `npm run console:build` | 0 | TypeScript 与 Vite 生产构建成功，15116 个模块，15.12 秒；原子发布到被 Git 忽略的 `public/_admin-console` |
| 空白检查 | `git diff --check` | 0 | 无空白错误 |

M2 的 32 文件目标集合包含以下真实 PostgreSQL 集成测试，输出中没有 skip 或 todo：

- `tests/integration/agent-scope-migration.test.ts`
- `tests/integration/agent-scope-repositories.test.ts`
- `tests/integration/session-state-repositories.test.ts`
- `tests/integration/admin-agent-profile.test.ts`
- `tests/integration/admin-audit.test.ts`
- `tests/integration/admin-channel-config.test.ts`

这些集成测试不是 mock SQL：它们实际启动嵌入式 PostgreSQL，覆盖并发迁移、所有权、
跨 Agent 隔离、跨进程会话撤销、CAS revision、审计、17 个虚拟渠道默认配置、密钥
历史、批量回滚、行锁和 COMMIT 响应丢失恢复。

### Console 补丁 lint 的上游差异

四个补丁最初触及 74 个 TypeScript 文件。为消除本次新增的两个路由
`react-refresh/only-export-components` warning，最终补丁把两个路由组件拆为独立文件，
所以完整候选集增至 76 个 `ts` / `tsx` 文件。验收对同一组相对路径分别执行 prepared
Console 和未打补丁上游的 ESLint：

| 范围 | 候选文件 | errors | warnings | ESLint 退出码 |
|---|---:|---:|---:|---:|
| 最终 prepared Console | 76 | 49 | 17 | 1 |
| 未打补丁上游中存在的同路径文件 | 62 | 53 | 17 | 1 |

两边均因上游既有 lint 债务退出 1，不能把全量命令表述为“lint 全绿”。按
`relative file + severity + rule + normalized message` 逐项、多重集比较，最终补丁相对
上游新增 **0 error、0 warning**；prepared 反而净减少 4 个 error。

另以 source line 参与比较时有两项位置差异：

- `src/api/modules/agents.test.ts` 的上游 `as any` 因对象增加 `operation_id` 后从单行展开，
  rule 和语义未新增。
- `src/pages/Chat/index.tsx` 的上游 `messageQueue` Hook warning 保持同一表达式，只因前序
  补丁插入行导致 warning 文本引用的下游 `useEffect` 行号改变。

这两项均在原始上游同文件存在，不计为新增。`src/api/config.ts` 的兼容空操作
unused-parameter error、两处新增 CSRF 测试的 explicit-any，以及两个新增路由组件 warning
均已在最终补丁中消除。另对 config/auth 的 5 个生产文件单独运行 ESLint，退出码为 0。

## 数据库隔离审计

计划要求的精确扫描：

```bash
rg -n 'WHERE (id|conversation_id|goal_id|message_id) = \$1' \
  src/server/db src/server/agents
```

结果为 0 个命中。为避免正则“零命中”掩盖其他写法，验收继续审查
`src/server/db/repositories.ts`、`src/server/agents`、`src/server/admin` 的 ID 查询、
子资源写入、导出和清空路径。

| 范围 | 审查结论 |
|---|---|
| conversations、projects、messages、memory、reflections、goals、task runs、artifacts、channel messages | 所有 Agent 级直接 CRUD 同时限定 `user_id` 与 `agent_id` |
| 子资源创建 | message 校验同 scope conversation；memory 校验同 scope source message；tool log 校验同 scope conversation / goal；artifact 校验同 scope task run |
| `goal_steps` | 表本身没有 `user_id`，读取与写入通过 `goals` join 同时限定 `goal.user_id` 和 `step.agent_id` |
| attachments | 直接操作限定 `user_id + agent_id`；绑定动作同时锁定同 scope attachment 和 conversation |
| channel secrets | API 先在同一事务按 `user_id + agent_id` 锁定父 `channel_connections`，再使用内部取得的 connection ID 操作 secret；导出和清空通过父连接 join / 子查询限定用户 |
| exposure fingerprints | 直接限定 `user_id`；schema 同时具备用户外键及 `(connection_id, user_id)` 复合外键；连接删除后允许保留去关联历史指纹 |
| skills 与 skill revisions | skill 是用户级资源；两个仅按 `skill_id` 的内部 revision 查询只接受由 `skills.listEnabledForAgent(scope)` 得到的 ID，不存在外部不可信 ID 入口 |
| 用户级导出与清空 | 按产品定义是整用户操作，不是单 Agent 操作；必须经过认证并持有用户数据租约 |
| 存储存在性探针 | `listExistingStorageKeys(storageKeys)` 只检查调用方给定 key 是否仍存在，不枚举或返回其他用户数据，属于清理基础设施例外 |

扩展扫描发现 `admin/audit.ts` 三处和 `admin/channel-config.ts` 两处
`WHERE id = $1`。逐项检查后，五处都在同一 SQL 中继续带有
`user_id = $2 AND agent_id = $3`，没有单 ID 越权读写。

隔离结论：未发现遗漏 AgentScope 的 Agent 级查询，也未发现可从不可信子资源 ID 绕过
父资源所有权的路径。

## secret、会话与兼容层安全审计

计划要求的扫描：

```bash
rg -n \
  'APP_SECRET.*encrypt|decrypt.*APP_SECRET|filter_thinking.*false|filter_tool_messages.*false' \
  src patches/qwenpaw-console
```

扫描没有发现生产代码违规。唯一两处文本命中位于 `0004-api-compat.patch` 内的
`channelSecurity.test.ts` 负向输入：测试故意传入两个 `false`，并断言请求构造器仍强制
改为 `true`。

| 安全边界 | 证据与结论 |
|---|---|
| 密钥分离 | 渠道 AES-256-GCM 使用独立 `CHANNEL_SECRETS_KEY`，没有复用 `APP_SECRET` |
| 加密上下文 | ciphertext、nonce、auth tag 只出现在 schema、加密值对象和内部仓储；AAD 绑定用户、Agent、连接、渠道类型与字段 |
| secret API | 公开响应只包含 `configured` 与 `lastRotatedAt`；不返回明文、密文、nonce、tag 或历史指纹 |
| 日志、审计与导出 | 审计只保存稳定摘要和内部 operation/input fingerprint；用户导出白名单不含 before/after summary、confirmation source、存储路径、提取文本、reply token、poll token 或原始平台载荷 |
| 历史 secret | 清空和导出会使用当前及历史凭据指纹扫描可见数据，扫描原料和指纹本身不进入导出响应 |
| 同源会话 | PostgreSQL 持久化 session generation；登录收敛、跨进程 logout 撤销和生产密钥边界有真实数据库测试 |
| CSRF | 写请求要求同源检查和绑定当前 session generation 的 HMAC token；GET、HEAD、OPTIONS 免 CSRF 但不免认证；HEAD 无 body、OPTIONS 先认证后枚举 |
| 错误边界 | 兼容层使用稳定错误码、详情白名单和 JSON body 上限；不把异常对象、SQL、secret 或供应商详情直接回传 |
| COMMIT 歧义恢复 | Agent profile、配置审计、渠道单条与批量更新均以 operation ID / fingerprint 和 canonical revision 校验恢复；真实 PostgreSQL 故障注入覆盖 COMMIT 响应丢失及伪造、不完整审计 |
| 数据清空顺序 | 独占租约 → 确认渠道未启用 → 停止/排空 → 枚举 → 物理删除附件 → 删除 artifact tree → 清数据库 → 释放 drain → 释放租约 |
| 失败可重试 | 物理附件或产物删除失败时保留数据库定位行；断开失败、删除失败和重试收敛均有回归 |
| webhook fence | ACK / 入队前取得用户 epoch fence，旧 fence 在清空后不能执行；准入有 750ms 硬超时，payload 不写日志，租约保持到 handler / outbound 完成 |

安全结论：未发现 APP secret 复用、secret 回传、跨会话 CSRF、推理过滤关闭或清空后旧
webhook 继续执行的路径。

## 单数字分身能力与 17 渠道合同

`AGENT_FEATURES.multiAgent` 固定为 `false`。Console 仍从真实数据库读取唯一默认分身 UUID，
选择、pin、order 和后端 AgentScope 数据通路保留；创建、克隆、导入和删除由前后端能力
守卫共同阻断，合同测试全部断言 `501 capability_disabled` 和稳定
`multi_agent_*` 错误码。这样保留未来第二套数字分身、第二套记忆的迁移能力，但本期不向
用户提供未完成操作。

渠道类型、顺序和字段数由 catalog 与 snapshot 测试固定：

| 顺序 | 类型 | 配置字段数 |
|---:|---|---:|
| 1 | `imessage` | 18 |
| 2 | `discord` | 20 |
| 3 | `dingtalk` | 26 |
| 4 | `feishu` | 22 |
| 5 | `qq` | 19 |
| 6 | `telegram` | 20 |
| 7 | `mattermost` | 19 |
| 8 | `mqtt` | 27 |
| 9 | `matrix` | 28 |
| 10 | `slack` | 19 |
| 11 | `voice` | 23 |
| 12 | `sip` | 37 |
| 13 | `wecom` | 21 |
| 14 | `xiaoyi` | 18 |
| 15 | `yuanbao` | 19 |
| 16 | `wechat` | 20 |
| 17 | `onebot` | 18 |

17 个 manifest 都满足：

- `enabled=false` 初始默认值，未配置连接的虚拟响应为 `disabled`。
- `filter_thinking=true`、`filter_tool_messages=true`，且两个字段只读。
- secret 字段只写，更新、清空、轮换和历史泄漏扫描使用独立合同。
- M2 即使记录 `enabled=true` 意图，健康状态仍为 `blocked`，详情码固定为
  `runtime_not_implemented`；不会启动网络连接。
- `channelQrCodeEnabled=false`，二维码 wrapper 返回 `null`；M2 不暴露假的扫码流程。

这张表证明 17 种配置 schema 已进入稳定合同，不证明 17 个渠道已完成真实收发。

## 已知基线告警

固定上游依赖安装报告 29 项 audit 结果：1 low、11 moderate、17 high。M2 没有擅自升级
上游锁定依赖；该清单需要在后续上游同步或专门依赖安全评审中处理。

Console 构建仍有以下上游基线 warning，但所有生产构建退出码为 0：

- `@ant-design/x` 与 `antd` 的 peer dependency 提示。
- 已弃用依赖提示。
- Vite 循环 chunk、同一模块静态与动态导入、超过 1000 kB 的 chunk 提示。
- 根构建的多 lockfile 提示。

Vitest 的 jsdom 会输出预期的“不支持导航 / pseudo-element”提示，以及错误边界测试主动
抛出的 `kaboom`、`plugin boom`、缺少 Provider 等异常文本；最终测试统计为 0 失败，
这些输出不是未处理的产品异常。

## 回滚边界与 M3 准入

M2 没有切换正式 `/admin`。需要回滚时：

1. 保持旧 `/admin` 不变，停止使用 `/admin-preview`。
2. 删除或重新构建被 Git 忽略的 `public/_admin-console`，不回滚用户业务数据。
3. 保留 additive 数据库结构和已回填的默认 `agent_id`，避免破坏已经建立的数据归属。
4. 所有渠道连接继续保持 disabled / blocked，不存在需要回退的真实 M2 渠道进程。

进入 M3 前必须继续满足本报告的 AgentScope、secret、CSRF、单源幂等和清空 fence 边界。
M3 只建立统一 `ChannelAdapter`、连接管理器、事件 claim、Delivery 队列和现有四渠道迁移；
其他 13 个真实适配器及平台 smoke test 仍按 M4-A、M4-B、M4-C 分批验收。M3 不得借配置
合同存在而宣称 17 个渠道已接通，也不得提前切换正式 `/admin`。
