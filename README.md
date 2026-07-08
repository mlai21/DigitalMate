# DigitalMate 数字伙伴

DigitalMate 是一个自托管的私人数字伙伴：Web 聊天、长期记忆、联网搜索、提醒、管理后台、多渠道 webhook、反思、Skills、文件任务和后台数据自控都在同一个 Next.js + Node 服务体系内运行。

完整需求以 [docs/prd.md](docs/prd.md) 为准；本仓库工作约定见 [AGENTS.md](AGENTS.md)。

## 技术栈

- Web/API：Next.js App Router + TypeScript
- Agent 服务：常驻 Node 进程，与 Web 共享 TypeScript 代码
- 数据库：PostgreSQL + pgvector
- 部署：Docker Compose / VPS
- LLM：通过统一适配层接入 KIE.AI 的 Claude / Gemini，未配置 API Key 时使用本地 mock

## 本地启动

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少配置：

- `APP_PASSWORD`：Web 登录口令
- `APP_SECRET`：会话签名密钥
- `DATABASE_URL`：PostgreSQL 连接
- `KIE_AI_API_KEY`：真实模型调用需要

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

## 后台能力

登录后访问 `/admin`：

- 会话、记忆、工具调用、模型用量、提醒、反思
- Skills 草稿审核与启用
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
