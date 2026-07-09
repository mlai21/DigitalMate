# DigitalMate 数字伙伴

DigitalMate 是一个自托管的私人数字伙伴：Web 聊天、长期记忆、联网搜索、提醒、管理后台、多渠道 webhook、反思、Skills、文件任务和后台数据自控都在同一个 Next.js + Node 服务体系内运行。

在线体验：[https://ginkgo.xin/home](https://ginkgo.xin/home)

完整需求以 [docs/prd.md](docs/prd.md) 为准；架构通俗介绍见 [docs/AgentSchemaIntro.md](docs/AgentSchemaIntro.md)；本仓库工作约定见 [AGENTS.md](AGENTS.md)。

## 实现状态

框架与流程已经打通，但部分核心能力仍是占位实现，正在逐步换成真实版本：

| 模块 | 状态 |
|---|---|
| Web 聊天 / 登录 / 管理后台 / 渠道 webhook | 真实可用 |
| 会话与项目管理（P0-9） | 多会话增删改查、置顶、搜索、项目分组；标题首轮后由轻量模型自动生成 |
| 管理后台 | 分组侧栏；会话日志可下钻到单会话完整消息 + 工具调用；模型页支持目录选择 + 自定义 ID |
| LLM 适配层 | OpenAI 兼容统一客户端，main/light 按用途路由，后台可视化选择模型 |
| Agent 循环 | 原生 tool-calling 循环（web_search + 已注册工具） |
| 记忆抽取/召回 | LLM 抽取 + 向量/全文混合检索（embedding 未配置时降级为全文+词面）；写入前做敏感信息与提示注入扫描 |
| 记忆容量自整理 | profile/agent_self 层带容量上限，超限由轻量模型合并压缩，失败时降级淘汰旧低置信条目 |
| 轮后轻量复盘 | 每轮对话后异步用轻量模型复盘，产出行为修正建议与 Skill 草稿 |
| 每日反思 | LLM 生成（未配置模型时降级为模板） |
| Skill 沉淀 | 轮后复盘自动生成 Skill 草稿（LLM 判据）+ 任务类模板草稿；一律 pending 待后台确认 |
| 群聊插话相关度 | 占位：n-gram 词面重叠，待换低成本模型判断 |
| 沙箱 / CSV / PPT / 工具注册（P2 范畴） | 已实现基础版，冻结不扩展 |

## 架构概览

系统由三个角色组成，跑在同一个 Docker Compose 里，彼此**不直接通信**，全靠读写同一个数据库协作：

| 角色 | 是什么 | 干什么 |
|---|---|---|
| Web 服务（Next.js） | 前台接待 | 网页聊天界面、管理后台、接收各 IM 平台的 webhook |
| Agent 服务（常驻 Node 进程） | 后台管家 | 每 15 秒 `tick()` 一轮，处理主动消息、记忆抽取、每日反思等"不着急但重要"的事 |
| PostgreSQL（带 pgvector） | 共享大脑存储 | 所有会话、记忆、任务、反思都存这里 |

- **Agent 大脑**（`src/server/agent/run-agent.ts`）：自研 Harness，不依赖现成框架。备料（人设 + 相关记忆 + 匹配 Skills + 反思建议 + 已启用工具）→ 拼装 system prompt + 最近 12 条历史 → 循环式 tool call（最多 4 轮）→ 清洗文本后流式输出。
- **记忆分三层**（`memory_entries` 表）：`profile`（偏好/身份/关系，上限 40）、`agent_self`（对自己的认知，上限 24）、`episodic`（有时效事件，180 天过期）。写记忆是后台异步活，抽取 → 敏感信息过滤 → 生成 embedding → 入库；召回用语义 70% + 词面 30% 混合检索取 top 8。
- **模型无关**（`src/server/llm/router.ts`）：按用途分 `main`（能力优先，主对话）和 `light`（成本优先，抽取/反思/复盘等高频小活）两条路由，配置存数据库、不硬编码。
- **多渠道同一身份**：Web、Telegram、Slack、飞书、钉钉五个入口共享同一套会话、记忆和人设；群聊插话由 `shouldInterject()` 的六道闸门控制，全部通过才开口。
- **进化模块**：每日反思、轮后复盘、事件反思、对话中主动沉淀四条路径产出反思与 Skill 草稿，一律 `pending`，经你在后台确认才生效——反思过程绝不外露到对话中。

更完整的图解（含 mermaid 流程图、数据库 ER 图、占位实现清单）见 [docs/AgentSchemaIntro.md](docs/AgentSchemaIntro.md)。

## 技术栈

- Web/API：Next.js App Router + TypeScript
- Agent 服务：常驻 Node 进程，与 Web 共享 TypeScript 代码
- 数据库：PostgreSQL + pgvector
- 部署：Docker Compose / VPS
- LLM：通过统一适配层接入 Claude / Gemini等，未配置 API Key 时使用本地 mock

## 本地启动

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少配置：

- `APP_PASSWORD`：Web 登录口令
- `APP_SECRET`：会话签名密钥
- `DATABASE_URL`：PostgreSQL 连接
- `AI_API_KEY`：真实模型调用需要

启动数据库后运行：

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

Web 地址：[http://localhost:3000](http://localhost:3000)

常驻 Agent 服务用于提醒、记忆抽取和每日反思：

```bash
npm run agent
```

## 生产部署（Docker Compose + HTTPS）

服务器上：

```bash
cp .env.example .env   # 填入配置，其中 DOMAIN 为解析到本机的域名
docker compose up -d --build
```

Caddy 作为反向代理接管 80/443：`.env` 中配置 `DOMAIN`（域名 A 记录需指向服务器 IP，安全组放行 80/443）后自动申请并续期 Let's Encrypt 证书，HTTP 自动跳转 HTTPS；`DOMAIN` 留空则仅提供 80 端口 HTTP。

## 后台能力

登录后访问 `/admin`（分组侧栏导航）：

- 会话日志：全部渠道会话列表，可进入单会话查看完整消息与工具调用时间线
- 模型：主对话/轻量任务模型可视化选择（内置模型目录 + 自定义模型 ID）
- 记忆、模型用量、提醒、反思（含每日反思与轮后复盘记录）
- Skills 草稿审核与启用（含轮后复盘自动沉淀的草稿）
- 工具注册审核与启用：支持沙箱脚本工具与 stdio MCP 工具，默认 pending，确认后才进入 Agent 私有工具上下文
- CSV/XLSX 汇总报告、PPTX 生成和产物下载
- 个人数据导出与清空
- 人设、静默时段和主动性参数配置

## IM 渠道

已提供 webhook 入口：

- Telegram：`/api/webhooks/telegram`
- Slack：`/api/webhooks/slack`
- 飞书：`/api/webhooks/feishu`
- 钉钉：`/api/webhooks/dingtalk`

相关环境变量见 [docs/env.md](docs/env.md)。真实平台联调需要公网回调地址、平台凭证和对应机器人权限。

## 验证命令

```bash
npm test
npm run typecheck
npm run lint
npm audit --audit-level=moderate
npm run build
npm run test:e2e
```

如果需要完整端到端验收，请先确保 Docker、PostgreSQL/pgvector 和真实 IM 平台凭证可用。
