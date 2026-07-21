# QwenPaw Console 与全渠道迁移总实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按已批准规格，把 QwenPaw `v2.0.0.post3` Console 的导航、页面和交互可审计地引入 `/admin`，保留 DigitalMate 珊瑚色品牌与首页聊天，并让 17 个外部渠道共用一个 DigitalMate Agent、记忆和 PostgreSQL 事务边界。

**架构：** 上游 Console 以不可变快照、可重放补丁和独立 React 18/Vite 构建接入；Next.js 通过 `/api/admin/compat/*` 把上游 API 形状映射到 DigitalMate 领域服务。所有 IM 先写入持久事件并 ACK，再由常驻 Worker 用稳定 `client_turn_id` 执行一次 Agent 和一次可见回复；第二分身当前关闭，但所有分身级数据使用非空 `agent_id`。

**技术栈：** Next.js 16、React 19、QwenPaw Console React 18/Vite、TypeScript、PostgreSQL 16 + pgvector、Vitest、Playwright、WebSocket、平台官方 SDK、Docker Compose、Caddy。

---

## 计划套件与执行顺序

| 顺序 | 计划 | 里程碑 | 可独立工作的结果 |
|---|---|---|---|
| 1 | `2026-07-21-qwenpaw-console-01-foundation.md` | M0–M1 | 测试边界可信；固定 Console 可在 `/admin-preview` 登录、导航、构建和回归 |
| 2 | `2026-07-21-qwenpaw-console-02-agent-scope-compat.md` | M2 | 默认分身与非空 `agent_id` 完成；兼容 API、CSRF、revision、审计和密钥存储可用 |
| 3 | `2026-07-21-qwenpaw-console-03-channel-runtime.md` | M3 | 入站、Agent 执行和发送解耦；现有四渠道不再因重复 webhook 或重启重复执行 |
| 4 | `2026-07-21-qwenpaw-console-04-standard-channels.md` | M4-A | Telegram、Discord、Slack、Mattermost、飞书、钉钉、QQ 官方机器人完成适配与合同测试 |
| 5 | `2026-07-21-qwenpaw-console-05-protocol-channels.md` | M4-B | MQTT、Matrix、企业微信、小艺、元宝、微信 iLink 完成适配与合同测试 |
| 6 | `2026-07-21-qwenpaw-console-06-edge-voice-channels.md` | M4-C | OneBot、iMessage、Voice/Twilio、SIP 和受限运行节点完成适配与合同测试 |
| 7 | `2026-07-21-qwenpaw-console-07-pages-cutover.md` | M5 | 32 个上游 API 模块都有真实映射或准确禁用；DigitalMate 独有页面完成；旧后台可回退 |
| 8 | `2026-07-21-qwenpaw-console-08-release-verification.md` | M6 | 全量自动化、迁移、备份恢复、安全、视觉、真实平台和回滚证据齐全；正式切换 `/admin` |

计划必须按表中顺序执行。第 4–6 份计划可以在第 3 份完成后按渠道组并行开发，但第 7 份只在三个渠道计划均通过合同测试后收口，第 8 份只负责验证和切换，不补写缺失功能。

## 跨计划固定接口

以下名称在整套计划中保持一致，不允许在实现过程中改名后只修一部分调用方：

```ts
export type AgentScope = Readonly<{ userId: string; agentId: string }>;

export type ChannelType =
  | "imessage" | "discord" | "dingtalk" | "feishu" | "qq"
  | "telegram" | "mattermost" | "mqtt" | "matrix" | "slack"
  | "voice" | "sip" | "wecom" | "xiaoyi" | "yuanbao"
  | "wechat" | "onebot";

export type ChannelHealthStatus =
  | "disabled" | "starting" | "connected"
  | "degraded" | "disconnected" | "blocked";

export type ChannelInboundStatus =
  | "accepted" | "running" | "completed" | "failed";

export type CapabilityErrorCode =
  | "capability_disabled"
  | "config_revision_conflict"
  | "external_prerequisite_missing";
```

兼容 API 的错误体固定为：

```ts
export type AdminCompatError = {
  error: {
    code: CapabilityErrorCode | "invalid_request" | "unauthorized" | "forbidden";
    message: string;
    details?: Record<string, unknown>;
  };
};
```

渠道 Adapter 固定使用第 3 份计划定义的 `ChannelAdapter<TConfig>`，任何 Adapter 都不得导入 `runAgent`、记忆仓储、搜索、Skill、工具仓储或 `messages.create*`。

## 规格到计划的覆盖矩阵

| 规格章节 | 负责计划 | 完成证据 |
|---|---|---|
| 上游源码、许可、补丁、同步 | 01 | 快照 SHA、许可证、补丁重放、上游测试与构建报告 |
| `/admin` 挂载、登录、视觉基础 | 01、08 | 深层刷新 E2E、三视口截图、正式切换与回退演练 |
| 数字分身与记忆能力预留 | 02 | Schema、回填、非空约束、跨分身隔离测试、单 Agent UI |
| Console 兼容 API | 02、07 | 32 模块清单、成功/失败/冲突/禁用合同测试 |
| 渠道统一运行时与数据模型 | 03 | 并发、重复、崩溃恢复、Delivery 单独重试和红线回归 |
| 17 个渠道 | 04、05、06 | 17 项 manifest、配置、收发、健康、访问控制和合同测试 |
| 运行节点、Voice、SIP | 06 | mTLS 节点协议、离线队列、Twilio 签名和 SIP 媒体测试 |
| 信息架构与独有页面 | 07 | 全路由清单、页面状态快照、真实领域数据 E2E |
| 数据导出、清空、隐私 | 02、03、07、08 | secret 排除、先物理后数据库、停止连接、恢复演练 |
| 发布、回滚、真实平台验收 | 08 | 发布清单、平台 smoke 矩阵、外部阻塞标记和回滚报告 |

## 全局非协商门槛

- [ ] 所有 Agent 级查询都同时限定 `user_id` 与 `agent_id`；本期数据库只有一个默认分身，Console 保留选择通路，创建、克隆、导入和删除返回 `501 capability_disabled`。
- [ ] 当前或历史上下文含附件时，搜索、Skill 和其他工具调用次数均为 0；Voice/SIP 音频只在传输层转写为文本。
- [ ] 普通问候和未授权实时问题搜索次数为 0；后台联网只接受持久化授权类型与来源 ID。
- [ ] 同一 `connection_id + external_event_id` 在重复、并发、断线、重启和发送重试下只执行一次 Agent、写一条助手消息；发送失败不重新调用 Agent。
- [ ] `filter_thinking` 与 `filter_tool_messages` 强制为 `true` 且 Console 只读；聊天正文不出现推理、工具日志、搜索原始标题/摘要/链接或平台诊断。
- [ ] secret API 永不回传明文；数据库只保存 AES-256-GCM 密文；日志、审计、导出、备份清单不包含 secret、nonce、二维码 Token、临时 URL 或供应商原始载荷。
- [ ] 17 个渠道均完成代码与自动化合同测试；缺少账号、资格或环境的渠道标记为 `pending_external`，不能显示“可用”。
- [ ] P2 Coding、沙箱、CSV、PPT 和工具自扩展保持冻结；Console 可以保留页面结构，但写操作准确禁用。

## 提交与审查纪律

每个任务严格执行“失败测试 → 最小实现 → 目标测试通过 → 相关回归通过 → 独立 commit”。每份子计划最后提交一次该里程碑的证据文档，不把多个渠道压成一个无法审查的巨型提交。

每次暂存前先运行 `git status --short`，只暂存当前任务“文件”清单中逐项列出的路径；只有清单明确标注为本任务专用的新目录时才允许暂存整个目录。不得使用 `git add src`、`git add tests/unit`、`git add docs/verification` 等宽泛命令，也不得暂存任何任务开始前已存在的未跟踪文件或用户改动。

每份计划完成后执行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Console 源码相关计划额外执行：

```bash
npm run console:verify-upstream
npm run console:test
npm run console:build
```

渠道相关计划额外执行：

```bash
npm test -- --run tests/unit/channels tests/integration/channels
```

若任何命令失败，不进入下一份计划，不用放宽断言、跳过测试或标记“已知失败”替代修复。

## 整体回滚原则

1. Console 发布前始终保留 `/admin-preview` 和 `/admin-legacy`；正式入口由 `ADMIN_CONSOLE_ENABLED` 控制。
2. 数据库迁移只增加表、列、索引和约束；稳定期前不删除旧渠道表、旧后台源文件或旧配置列。
3. 单个渠道可独立 `enabled=false`，不影响 Web 聊天和其他连接。
4. 运行节点证书可逐个吊销；吊销后中心拒绝新连接并保留未发送 Delivery 记录。
5. 回滚 Console 不回滚数据库；回滚渠道只停止 Adapter，不删除事件、回复和审计。
