# 阿里云百炼 Qwen3.7-Max 接入文档

本文覆盖从开通百炼到在 DigitalMate 里跑通 `qwen3.7-max` 的全流程。事实以阿里云百炼官方文档为准（[模型列表](https://help.aliyun.com/zh/model-studio/models)、[OpenAI 兼容-Chat](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[获取 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)），项目侧映射以本仓库代码为准。

## 为什么单独接一个供应商

Qwen 系列**不在 KIE 网关上**。我们试过 `/qwen3-7-max/v1/chat/completions`、`/qwen3-7-max-openai/...`、`/qwen3.7-max/...` 等命名，KIE 一律返回 `{"code":422,"msg":"The model is not supported"}`。所以 Qwen 必须直连百炼的 OpenAI 兼容端点，用独立的 Base URL 与密钥。

密钥也不能复用：百炼 Model Studio 的模型密钥与项目里已有的 `ALIYUN_IQS_API_KEY`（智能搜索 IQS）是两个产品的凭据。拿 IQS 的密钥打百炼会得到：

```json
{"error":{"message":"Incorrect API key provided...","type":"invalid_request_error","code":"invalid_api_key"}}
```

## 步骤一：开通并获取 API Key

1. 进入[百炼控制台](https://bailian.console.aliyun.com/)，用主账号（或具备 `管理员` / `API-Key` 页面权限的子账号）操作。
2. 在页面右上角**先选好地域**——华北2（北京）、新加坡、日本（东京）、德国（法兰克福）、美国（弗吉尼亚）的 API Key **互不通用**。
3. 进入 API Key 页面 → 创建 API Key。归属业务空间建议选默认空间；权限选"全部"，或用"自定义"限制可访问 IP 与模型。
4. 创建成功的弹窗会同时给出 **API Key 和 API Host（即 Base URL）**。新版密钥以 `sk-ws` 开头，且**只在这一次展示明文**，关掉就再也看不到，丢了只能重置或重建。旧的 `sk-` 开头密钥仍然可用。

## 步骤二：确认 Base URL

百炼现在推荐**业务空间专属域名**（性能与稳定性更好），`{WorkspaceId}` 在控制台业务空间详情页查看：

| 地域 | OpenAI 兼容 Base URL |
|---|---|
| 华北2（北京） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 新加坡 | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| 日本（东京） | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| 德国（法兰克福） | `https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1` |
| 美国（弗吉尼亚） | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |

旧域名 `https://dashscope.aliyuncs.com/compatible-mode/v1`（北京）与 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`（新加坡）仍可正常使用，是项目里的默认值；拿到 WorkspaceId 后建议换成专属域名。

**Base URL 必须与创建密钥的地域一致**，否则会报 401。

## 步骤三：最小 curl 验证

```bash
curl -X POST "${MODEL_STUDIO_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${MODEL_STUDIO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "stream": true,
    "messages": [{"role": "user", "content": "只回复两个字：在的"}]
  }'
```

成功时 `Content-Type` 为 `text/event-stream`，每行以 `data: ` 开头，最后以 `data: [DONE]` 结束。项目里的客户端只读 `choices[0].delta.content` 与 `delta.tool_calls`。

## 项目侧配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `MODEL_STUDIO_API_KEY` | 是（用 Qwen 时） | 百炼 API Key。**未配置时 Qwen 模型会被直接跳过**，不会尝试调用也不会报错 |
| `MODEL_STUDIO_BASE_URL` | 否 | 默认北京旧域名，按上表替换为自己地域/业务空间的地址 |
| `LLM_MODEL_MAIN` / `LLM_MODEL_LIGHT` | 否 | 填 `qwen3.7-max` 即把它作为主/轻模型 |
| `LLM_MODEL_MAIN_FALLBACKS` | 否 | 主模型故障时的降级链，可包含 `qwen3.7-max` |

改完这三处才算生效：

1. `.env`（本地）与服务器上的 `.env`；
2. `docker-compose.yml` 的 `environment` 是**逐项白名单**传值，新变量不加进去容器里读不到（`MODEL_STUDIO_API_KEY`、`MODEL_STUDIO_BASE_URL`、`LLM_MODEL_MAIN_FALLBACKS` 已加）；
3. **Agent 模型授权**。`qwen3.7-max` 必须在该 Agent 的 `agent_resource_grants` 里有 `model` 记录，否则主模型会抛 `model_resource_unauthorized`、备用模型会被静默忽略。默认 Agent（`inherits_user_resources = true`）自动继承，Alvin 这类不继承的必须显式补：

```sql
INSERT INTO agent_resource_grants (user_id, agent_id, resource_type, resource_id, enabled)
SELECT user_id, id, 'model', 'qwen3.7-max', true
FROM digital_agents WHERE slug = 'alvin'
ON CONFLICT (agent_id, resource_type, resource_id) DO UPDATE SET enabled = true;
```

## 代码位置

| 关注点 | 位置 |
|---|---|
| 供应商选择（`qwen` 前缀 → 百炼） | `clientNameForModel` / `getLlmClientForModel`（`src/server/llm/router.ts`） |
| 百炼客户端构造 | `OpenAiCompatClient.forModelStudio`（`src/server/llm/openai-compat.ts`） |
| 模型目录条目 | `MODEL_CATALOG`（`src/server/llm/catalog.ts`） |
| 故障降级链 | `src/server/llm/fallback.ts` |

## 模型能力与同代型号

`qwen3.7-max` 是纯文本推理旗舰（**不支持图片输入**，目录里 `supportsImageInput: false`），带扩展思考，长上下文。同代还有 `qwen3.7-plus`、`qwen3.7-flash`，均在上述五个地域提供 OpenAI 兼容接口，换模型 id 即可。`qwen3.8-max-preview` 目前只对 Token Plan 订阅用户开放，且 Token Plan / Coding Plan 用的是以 `sk-sp-` 开头的专属密钥。

## 三个需要注意的地方

**一、思考内容不会进对话。** Qwen3 的思考文本走 `delta.reasoning_content`，我们的客户端只取 `delta.content`，所以推理过程天然不会出现在回复里——这正是产品红线要的（不暴露思考过程），不要"顺手"把它读出来。

**二、`tools` 与 `stream` 的组合要实测。** 百炼 OpenAI 兼容文档里有一句针对老 `qwen-turbo/plus/max` 的说明称"tools 暂时无法与 stream=True 同时使用"。我们的客户端**总是**流式、且主模型回合几乎总带 `tools`（联网搜索、Skill 等）。把 `qwen3.7-max` 设为主模型前，先按上面的 curl 加上 `tools` 跑一次；若报错，它只适合放在不带工具的轻量用途上。

**三、错误码语义。** 百炼直接用标准 HTTP 状态码（不像 KIE 把故障包在 HTTP 200 的 `{"code":500}` 里）：

| 状态码 | 含义 | 降级链是否重试 |
|---|---|---|
| 400 Invalid Request Error | 请求参数有问题 | 否 |
| 401 Incorrect API key provided | 密钥错误，或密钥与 Base URL 地域不匹配 | 否 |
| 429 Rate limit reached | QPS/QPM 超限 | 是 |
| 429 exceeded your current quota | 额度超限或欠费 | 是 |
| 500 server had an error | 服务端错误 | 是 |
| 503 engine is currently overloaded | 负载过高，可重试 | 是 |

429 会被当作可重试并切到下一个备用模型；欠费导致的 429 换模型也救不回来，此时看日志里的 `llm_http_429` 与响应片段。
