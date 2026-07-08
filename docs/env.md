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

## Web 应用与提醒时区

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_PASSWORD` | 生产环境必填 | Web 登录口令 |
| `APP_SECRET` | 生产环境必填 | 会话签名密钥 |
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串 |
| `TZ` | 否 | Node 运行时本地时区，默认 `Asia/Shanghai`；提醒中的「明天 9 点」「周五之前」会按该时区计算 |

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

## 常见问题

**401 Invalid or missing API key**

- 检查 `KIE_AI_API_KEY` 是否已填入且无误
- Gemini 与 Claude 都通过 KIE.AI 网关使用 `Authorization: Bearer`

**402 Insufficient Credits**

- KIE.AI 账户余额不足，需在控制台充值

**Claude 请求失败但 Gemini 正常**

- 确认请求头包含 `anthropic-version`
- 确认 `model` 字段与接入文档一致（`claude-opus-4-6` 或 `claude-opus-4-8`）
