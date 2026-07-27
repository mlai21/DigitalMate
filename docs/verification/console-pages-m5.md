# QwenPaw Console M5 全页面验收报告

验收日期：2026-07-27

## 结论

DigitalMate 已完成 QwenPaw Console 全页面迁移与旧后台收口。迁移固定在
QwenPaw `v2.0.0.post3`，上游 commit 为
`fef7e64d984f4332d0b84a343cd209bd3ea5d316`，共 864 个经过 SHA-256
校验的快照文件，许可证为 Apache-2.0。

Console 保留 QwenPaw 的导航、页面结构和交互，使用 DigitalMate
珊瑚色视觉；聊天入口回到 DigitalMate 首页。QwenPaw 未覆盖的群聊插话、
目标、记忆和反思按同一套视觉与交互补齐。17 个内置渠道的运行时对齐证据见
[`qwenpaw-channel-parity.md`](./qwenpaw-channel-parity.md)。

第二套数字分身和第二套记忆未实现。当前 Console 只允许操作默认数字分身及其
记忆，但请求、数据作用域与兼容合同仍显式携带 `agent_id`，没有把单实例限制
固化成不可扩展的数据结构。

## 状态定义

- `mapped`：连接 DigitalMate 的真实领域数据或操作。
- `disabled`：能力未开放，稳定返回非 2xx 响应、机器可读能力码和用户可见原因。
- `redirected`：该能力由 DigitalMate 其他入口承载，返回明确目标地址。

模块状态表示页面或领域的总体归类；一个 `mapped` 模块仍可包含因安全边界或
P2 冻结而禁用的写端点。例如 `console` 总体归为 `redirected`，但它的 5 个
配置读取端点都已映射。独立 SHA-256 合同指纹逐端点固定
`METHOD path`、模块、状态、禁用码和跳转目标；所有状态由测试固定，不允许
用空数组、空对象或 `success: true` 伪装尚未实现的能力。

## 32 个上游 API 模块

| 模块 | 模块状态 | mapped | disabled | redirected | 端点总数 |
| --- | --- | ---: | ---: | ---: | ---: |
| accessControl | mapped | 13 | 0 | 0 | 13 |
| acp | disabled | 0 | 6 | 0 | 6 |
| agent | mapped | 7 | 10 | 1 | 18 |
| agentStats | mapped | 1 | 0 | 0 | 1 |
| agents | mapped | 6 | 2 | 0 | 8 |
| auth | mapped | 1 | 3 | 0 | 4 |
| backup | mapped | 7 | 0 | 0 | 7 |
| channel | mapped | 6 | 2 | 0 | 8 |
| chat | redirected | 9 | 0 | 4 | 13 |
| codingMode | disabled | 0 | 2 | 0 | 2 |
| codingProject | disabled | 0 | 8 | 0 | 8 |
| commands | mapped | 2 | 0 | 0 | 2 |
| console | redirected | 5 | 0 | 0 | 5 |
| cronjob | mapped | 11 | 0 | 0 | 11 |
| debug | mapped | 1 | 0 | 0 | 1 |
| env | mapped | 1 | 2 | 0 | 3 |
| git | disabled | 0 | 11 | 0 | 11 |
| heartbeat | mapped | 3 | 0 | 0 | 3 |
| language | mapped | 2 | 1 | 0 | 3 |
| localModel | disabled | 0 | 12 | 0 | 12 |
| market | disabled | 0 | 3 | 0 | 3 |
| mcp | mapped | 5 | 9 | 0 | 14 |
| plugin | mapped | 3 | 3 | 0 | 6 |
| pluginMarket | disabled | 0 | 1 | 0 | 1 |
| provider | mapped | 3 | 17 | 0 | 20 |
| root | mapped | 2 | 0 | 0 | 2 |
| security | mapped | 7 | 9 | 0 | 16 |
| skill | mapped | 11 | 30 | 0 | 41 |
| tokenUsage | mapped | 2 | 0 | 0 | 2 |
| tools | mapped | 2 | 3 | 0 | 5 |
| userTimezone | mapped | 2 | 0 | 0 | 2 |
| workspace | mapped | 6 | 9 | 0 | 15 |
| **合计** | **23 mapped / 7 disabled / 2 redirected** | **118** | **143** | **5** | **266** |

## 30 条页面路由

| 路由 | 页面 ID | 验收状态 |
| --- | --- | --- |
| `/coding` | `core.coding` | P2 冻结，原生禁用页 |
| `/channels` | `core.channels` | 已映射 17 渠道 |
| `/sessions` | `core.sessions` | 已映射会话、消息和内部留痕 |
| `/inbox` | `core.inbox` | 已映射审批与访问请求 |
| `/cron-jobs` | `core.cron-jobs` | 已映射提醒、摘要、订阅及授权来源 |
| `/heartbeat` | `core.heartbeat` | 已映射，默认关闭并受持久授权约束 |
| `/skills` | `core.skills` | 已映射 |
| `/skill-pool` | `core.skill-pool` | 已映射，启用和沉淀仍需确认 |
| `/tools` | `core.tools` | 已映射读取，冻结写操作明确禁用 |
| `/mcp` | `core.mcp` | 已映射读取，新增和启用仍需确认 |
| `/acp` | `core.acp` | 原生禁用页 |
| `/ACP` | `core.acp` | 兼容别名，规范化到 `/acp` |
| `/workspace` | `core.workspace` | 已映射私有虚拟工作区 |
| `/agents` | `core.agents` | 已映射，当前仅默认数字分身 |
| `/models` | `core.models` | 已映射模型与用途路由；凭据及本地模型受限 |
| `/environments` | `core.environments` | 已映射渠道运行节点 |
| `/agent-config` | `core.agent-config` | 支持字段已映射，其余字段准确禁用 |
| `/security` | `core.security` | 已映射安全状态，危险写操作受控 |
| `/token-usage` | `core.token-usage` | 已映射 |
| `/agent-stats` | `core.agent-stats` | 已映射 |
| `/voice-transcription` | `core.voice-transcription` | 已映射状态，执行能力按运行环境门控 |
| `/debug` | `core.debug` | 已映射，仅后台可见内部留痕 |
| `/backups` | `core.backups` | 已映射自有备份、恢复、清理和审计 |
| `/plugin-manager` | `core.plugin-manager` | 已映射已安装项和审批；市场安装禁用 |
| `/` | `core.inbox` | Console 根路径规范化到 `/inbox` |
| `/interjections` | `digitalmate.interjections` | DigitalMate 独有，已映射 |
| `/goals` | `digitalmate.goals` | DigitalMate 独有，已映射 |
| `/memory` | `digitalmate.memory` | DigitalMate 独有，当前仅默认记忆空间 |
| `/reflections` | `digitalmate.reflections` | DigitalMate 独有，已映射 |
| `/chat` | `digitalmate.home` | 返回 DigitalMate 首页 `/` |

每条 Console 页面均覆盖深层刷新。Interjections、Goals、Memory 和
Reflections 额外覆盖加载、失败、重试后空态及真实交互；冻结能力通过
Console 原生禁用状态呈现，不访问不存在的远端服务。

## 切换与回滚

- `/admin-preview` 始终提供新 Console，供上线前验收。
- `ADMIN_CONSOLE_ENABLED=1` 时，正式 `/admin` 及其深层路由提供新
  Console；未登录回跳保留原路径和查询参数。
- 默认 `ADMIN_CONSOLE_ENABLED=0`，正式 `/admin` 原样转到
  `/admin-legacy`，并保留路径后缀和查询参数。
- `/admin-legacy` 在稳定期始终可直接访问，仍执行原有后台鉴权。
- Console 内的 Chat 始终回到 DigitalMate 首页，不复制第二套聊天。

回滚只需把 `ADMIN_CONSOLE_ENABLED` 设为 `0` 并重启 Web 服务。兼容 API
和领域数据无需回滚，已产生的审批、备份和审计记录继续保留。

## 自动化证据

| 检查 | 结果 |
| --- | --- |
| 上游快照校验 | 864 文件，commit 与 SHA-256 清单一致 |
| 32 模块合同与领域单测 | 13 个测试文件，290 项通过 |
| QwenPaw Console 单测 | 137 个测试文件，1,233 项通过 |
| Console 生产构建 | 15,126 个模块转换并原子发布 |
| 三视口页面、交互与视觉 E2E | Desktop、iPad Mini、Mobile Chrome，301 项通过 |
| 正式 `/admin` 开启态 E2E | 4 项通过 |
| DigitalMate 全量单元/集成测试 | 171 个测试文件，2,169 项通过 |
| DigitalMate 类型检查与代码规范 | 类型检查通过；0 错误、10 条既有警告 |
| DigitalMate 生产构建 | Console 与 Next.js 生产构建均通过 |

视觉检查包含 30 条路由在三个视口下的 90 张像素基线。Console 上游构建
仍会报告既有的大包、循环分块和动态导入警告；固定版本依赖审计当前报告
1 个 low、11 个 moderate、17 个 high。为保持迁移基线可复现，本里程碑
不执行会改变上游依赖树的自动修复，风险在后续上游同步评审中处理。
