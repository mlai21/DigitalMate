# 环境变量配置说明

本文档说明如何根据 [docs/api/](./api/) 下的接入文档配置 LLM API 环境变量。

## 快速开始

```bash
cp .env.example .env
```

编辑项目根目录的 `.env`，填入 `KIE_AI_API_KEY`。`.env` 含敏感信息，**不要提交到 Git**。自托管部署建议保留 `TZ=Asia/Shanghai`，避免提醒时间在 UTC 容器内发生偏移。

## 统一 API 提供商

三个接入文档均指向同一服务商 **KIE.AI**：

| 项目 | 值 |
|---|---|
| 正式环境 Base URL | `https://api.kie.ai` |
| API Key 获取 | [kie.ai](https://kie.ai) 控制台 |
| 环境变量 | `KIE_AI_API_KEY`、`KIE_AI_BASE_URL` |

Gemini 与 Claude 接口**共用同一个 API Key**，无需为每个模型单独申请。

---

## Gemini 3.5 Flash

- **接入文档**：[gemini3-5-flash接入文档.md](./api/gemini3-5-flash接入文档.md)
- **完整 URL**：`{KIE_AI_BASE_URL}{GEMINI_3_5_FLASH_ENDPOINT}`
  - 默认：`https://api.kie.ai/gemini-3-5-flash-openai/v1/chat/completions`
- **协议**：OpenAI Chat Completions 兼容格式
- **鉴权**：请求头 `Authorization: Bearer <KIE_AI_API_KEY>`
- **特性**：流式 SSE、多模态、Google 搜索（`tools: [{ type: "function", function: { name: "googleSearch" } }]`）、函数调用

### 相关环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `KIE_AI_API_KEY` | 是 | KIE.AI API Key |
| `KIE_AI_BASE_URL` | 否 | 默认 `https://api.kie.ai` |
| `GEMINI_3_5_FLASH_ENDPOINT` | 否 | 默认 `/gemini-3-5-flash-openai/v1/chat/completions` |
| `LLM_MODEL_LIGHT` | 否 | 路由到 Gemini 时使用的模型标识，默认 `gemini-3-5-flash-openai` |

---

## P1 IM 渠道

| 变量 | 必填 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram 启用时必填 | Telegram Bot Token，用于调用 Bot API 发送消息 |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram 生产环境建议必填 | Telegram webhook secret token；配置后请求头 `x-telegram-bot-api-secret-token` 必须匹配，值需与 `setWebhook` 的 `secret_token` 一致 |
| `SLACK_BOT_TOKEN` | Slack 启用时必填 | Slack Bot User OAuth Token，用于 `chat.postMessage` |
| `SLACK_SIGNING_SECRET` | Slack 生产环境必填 | Slack Events API 请求签名密钥，用于校验 webhook 来源 |
| `FEISHU_APP_ID` | 飞书启用时必填 | 飞书自建应用 App ID，用于换取 `tenant_access_token` |
| `FEISHU_APP_SECRET` | 飞书启用时必填 | 飞书自建应用 App Secret，用于换取 `tenant_access_token` |
| `FEISHU_VERIFICATION_TOKEN` | 飞书生产环境建议必填 | 飞书事件订阅的 Verification Token；配置后 webhook 载荷中的 `header.token` 或旧版 `token` 必须匹配 |
| `DINGTALK_ROBOT_CODE` | 钉钉生产环境建议必填 | 钉钉企业 Bot 的 `robotCode`；配置后 webhook 载荷中的 `robotCode` 必须匹配 |
| `CHANNEL_IMPORT_LEGACY_ENABLED` | 否 | 仅控制旧环境变量首次导入后的连接是否立即启用，默认 `0`。启动时会把尚无后台连接的四渠道配置一次性导入加密存储；默认导入为禁用，之后以 `/admin` 渠道配置为准，不再用环境变量覆盖 |

旧环境变量只用于迁移已有部署。导入需要独立的
`CHANNEL_SECRETS_KEY`；日志与审计只记录字段是否存在，不记录凭据值。
迁移完成并在后台确认连接正常后，可删除上述渠道凭据环境变量。

## Web 应用与提醒时区

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_PASSWORD` | 生产环境必填 | Web 登录口令 |
| `APP_SECRET` | 生产环境必填 | 会话与 CSRF 派生签名的根密钥；开发环境可使用本地默认值，生产环境必须显式配置至少 32 字节的独立高熵随机值，缺失、公开默认值或占位符会导致启动失败，且 `APP_PASSWORD` 不能替代 |
| `CHANNEL_SECRETS_KEY` | 生产环境必填 | 渠道凭据与 Matrix crypto store 的独立 32 字节标准 base64 根密钥；不得复用 `APP_SECRET` |
| `BACKUP_ENCRYPTION_KEY` | 使用完整备份时必填 | 灾难恢复包外层 AES-256-GCM 的另一把 32 字节标准 base64 密钥；不得复用或回退到 `APP_SECRET`/`CHANNEL_SECRETS_KEY`。缺失或无效时只阻止备份/恢复，不影响聊天和渠道 |
| `BACKUP_STORAGE_DIR` | 否 | 加密灾难恢复包的私有目录，开发环境默认 `data/backups`；Docker Compose 中仅 Web 服务挂载 `/app/data/backups`，不得放入 `public/` |
| `BACKUP_RETENTION_DAYS` | 否 | 备份任务保留天数，默认 `30`，允许 `1–365` |
| `TRUST_PROXY_HEADERS` | 否 | 是否信任由受控入口代理清洗的 `X-Forwarded-Proto`、`X-Forwarded-Host` 与 `X-DigitalMate-Original-URI`，默认 `false`。Docker Compose 的 Caddy 会先删除客户端同名原始 URI 头，再注入未经 Next.js 规范化的 request URI；启用信任后该头缺失或异常会关闭请求。直接暴露 Next.js 不提供严格原始路径保证，不得作为生产入口；其他代理必须实现等价的覆盖式注入后才能设为 `true` |
| `ADMIN_CONSOLE_ENABLED` | 否 | 正式 `/admin` 是否启用新 Console，只有显式设为 `1` 才启用；默认 `0` 会保留路径后缀和查询参数并临时回退到 `/admin-legacy`，`/admin-preview` 始终用于预览新 Console |
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串 |
| `DOMAIN` | Docker Compose 生产部署必填 | HTTPS 域名（如 `mate.example.com`），需先将域名 A 记录解析到服务器 IP；Caddy 自动申请/续期 Let's Encrypt 证书并将 HTTP 跳转到 HTTPS |
| `PUBLIC_BASE_URL` | 生产环境必填 | 与 `DOMAIN` 对应的 HTTPS 根地址（如 `https://mate.example.com`），不得包含路径、查询、片段或用户信息 |
| `TZ` | 否 | Node 运行时本地时区，默认 `Asia/Shanghai`；提醒中的「明天 9 点」「周五之前」会按该时区计算 |
| `ATTACHMENT_STORAGE_DIR` | 否 | 聊天附件的私有存储目录，开发环境默认 `data/attachments`；Docker Compose 中 Web 与 Agent 共用持久卷 `/app/data/attachments`。该目录不得放入 `public/`，附件下载必须经过鉴权接口 |

`BACKUP_ENCRYPTION_KEY` 可用 `openssl rand -base64 32` 单独生成。备份包可以包含渠道凭据的既有密文、私有附件和 Matrix crypto store，因此普通个人数据导出不能替代灾难恢复包；备份文件也只能通过鉴权后的后台接口下载。

### 最小 curl 验证

```bash
curl -X POST "${KIE_AI_BASE_URL}${GEMINI_3_5_FLASH_ENDPOINT}" \
  -H "Authorization: Bearer ${KIE_AI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}],"stream":false}'
```

---

## Claude Opus 4.6

- **接入文档**：[claude-opus-4-6接入文档.md](./api/claude-opus-4-6接入文档.md)
- **完整 URL**：`{KIE_AI_BASE_URL}{CLAUDE_MESSAGES_ENDPOINT}`
  - 默认：`https://api.kie.ai/claude/v1/messages`
- **协议**：Anthropic Messages API
- **鉴权**：
  - `Authorization: Bearer <KIE_AI_API_KEY>`
  - `anthropic-version: <ANTHROPIC_API_VERSION>`（默认 `2023-06-01`）
- **请求体**：`model` 必须为 `claude-opus-4-6`

### 相关环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `KIE_AI_API_KEY` | 是 | 同上，填入 `Authorization: Bearer` 请求头 |
| `CLAUDE_MESSAGES_ENDPOINT` | 否 | 默认 `/claude/v1/messages` |
| `ANTHROPIC_API_VERSION` | 否 | Anthropic API 版本头，默认 `2023-06-01` |
| `LLM_MODEL_MAIN` | 否 | 设为 `claude-opus-4-6` 时使用此模型 |

### 最小 curl 验证

```bash
curl -X POST "${KIE_AI_BASE_URL}${CLAUDE_MESSAGES_ENDPOINT}" \
  -H "Authorization: Bearer ${KIE_AI_API_KEY}" \
  -H "anthropic-version: ${ANTHROPIC_API_VERSION:-2023-06-01}" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

---

## Claude Opus 4.8

- **接入文档**：[claude-opus-4-8接入文档.md](./api/claude-opus-4-8接入文档.md)
- **完整 URL**：与 4.6 相同（`{KIE_AI_BASE_URL}{CLAUDE_MESSAGES_ENDPOINT}`）
- **鉴权**：与 4.6 相同
- **请求体**：`model` 必须为 `claude-opus-4-8`

4.6 与 4.8 共用 `CLAUDE_MESSAGES_ENDPOINT` 和鉴权配置，**通过请求体中的 `model` 字段区分**。

| 变量 | 说明 |
|---|---|
| `LLM_MODEL_MAIN` | 设为 `claude-opus-4-8` 时使用此模型（`.env.example` 默认值） |

---

## 模型路由建议

按 [PRD 7.3](./prd.md#73-模型适配层) 的用途划分：

| 用途 | 推荐模型 | 环境变量 |
|---|---|---|
| 主对话 / 复杂任务 | Claude Opus 4.8 | `LLM_MODEL_MAIN=claude-opus-4-8` |
| 插话判断、记忆抽取等轻量调用 | Gemini 3.5 Flash | `LLM_MODEL_LIGHT=gemini-3-5-flash-openai` |

路由策略在实现阶段作为配置读取，不硬编码。

---

## 记忆向量 Embedding（可选）

记忆召回使用 pgvector 语义检索 + 词面相关度加权融合。配置任意 OpenAI 兼容的 `/embeddings` 接口即可启用真实语义向量；**不配置时自动降级为本地哈希伪向量**（功能可用，语义召回质量下降）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `EMBEDDING_BASE_URL` | 否 | OpenAI 兼容 API base URL（如 `https://api.openai.com/v1`），请求发往 `{BASE_URL}/embeddings` |
| `EMBEDDING_API_KEY` | 否 | Embedding 服务的 API Key |
| `EMBEDDING_MODEL` | 否 | 如 `text-embedding-3-small`；与 `EMBEDDING_BASE_URL` 同时配置才启用 |
| `EMBEDDING_DIMENSIONS` | 否 | 默认 `1536`，必须与 `schema.sql` 中 `vector(1536)` 一致 |

---

## 常见问题

**401 Invalid or missing API key**

- 检查 `KIE_AI_API_KEY` 是否已填入且无误
- Gemini 与 Claude 都通过 KIE.AI 网关使用 `Authorization: Bearer`

**402 Insufficient Credits**

- KIE.AI 账户余额不足，需在控制台充值

**Claude 请求失败但 Gemini 正常**

- 确认请求头包含 `anthropic-version`
- 确认 `model` 字段与接入文档一致（`claude-opus-4-6` 或 `claude-opus-4-8`）
