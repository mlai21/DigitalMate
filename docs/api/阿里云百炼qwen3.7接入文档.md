# 阿里云百炼 Qwen3.7 接入文档

本文覆盖从开通百炼到在 DigitalMate 里跑通 `qwen3.7-max` 与 `qwen3.7-plus` 的全流程。事实以阿里云百炼官方文档为准（[模型列表](https://help.aliyun.com/zh/model-studio/models)、[OpenAI 兼容-Chat](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[获取 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)），项目侧映射以本仓库代码为准，能力结论以线上实测为准。

## 实测结论（2026-07-30，北京地域，走本项目客户端）

| 模型 | 流式文本 | 流式 + tools | 图片输入 |
|---|---|---|---|
| `qwen3.7-max` | ✓ | ✓ | ✗ 直接拒绝：`Unexpected item type in content` |
| `qwen3.7-plus` | ✓ | ✓ | ✓ 能正确描述真实照片内容 |

两条值得记住的结论：**tools 与 stream 可以同时用**（官方兼容文档里"tools 暂时无法与 stream=True 同时使用"那句是针对老 `qwen-turbo/plus/max` 的，对 3.7 不适用），所以它们可以安全地作为带工具的主模型或降级备用；**图片能力只有 plus 有**，因此目录里 `qwen3.7-plus` 的 `supportsImageInput` 为 `true`、`qwen3.7-max` 为 `false`。

另外注意图片有最小尺寸限制，1×1 的测试图会被拒（`height:1 or width:1 must be larger`），排查时别把它误判成"不支持图片"。

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

要走本项目的客户端验证（会一并覆盖 tools 与图片路径），注意**裸跑脚本不会自动加载 `.env`**（只有 Next.js 会），必须显式指定：

```bash
npx tsx --env-file=.env <你的脚本>
```

否则会得到一个很有迷惑性的 401 `You didn't provide an API key`——那是密钥根本没发出去，不是密钥错误。真正的密钥错误消息是 `Incorrect API key provided`。

## 项目侧配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `MODEL_STUDIO_API_KEY` | 是（用 Qwen 时） | 百炼 API Key。**未配置时 Qwen 模型会被直接跳过**，不会尝试调用也不会报错 |
| `MODEL_STUDIO_BASE_URL` | 否 | 默认北京旧域名，按上表替换为自己地域/业务空间的地址 |
| `LLM_MODEL_MAIN` / `LLM_MODEL_LIGHT` | 否 | 填 `qwen3.7-max` 或 `qwen3.7-plus` 即把它作为主/轻模型 |
| `LLM_MODEL_MAIN_FALLBACKS` | 否 | 主模型故障时的降级链 |

当前生产策略是 `LLM_MODEL_MAIN=claude-opus-4-8`、`LLM_MODEL_MAIN_FALLBACKS=qwen3.7-plus,gemini-3-6-flash-openai`。两级备用刻意跨了供应商：第一级换到百炼，KIE 网关整体故障时仍能作答；第二级回到 KIE 的廉价模型，兜住百炼欠费或超限的情况。

改完这三处才算生效：

1. `.env`（本地）与服务器上的 `.env`；
2. `docker-compose.yml` 的 `environment` 是**逐项白名单**传值，新变量不加进去容器里读不到（`MODEL_STUDIO_API_KEY`、`MODEL_STUDIO_BASE_URL`、`LLM_MODEL_MAIN_FALLBACKS` 已加）；
3. **Agent 模型授权**。要用的模型必须在该 Agent 的 `agent_resource_grants` 里有 `model` 记录，否则主模型会抛 `model_resource_unauthorized`、备用模型会被静默忽略。默认 Agent（`inherits_user_resources = true`）自动继承，Alvin 这类不继承的必须显式补：

```sql
INSERT INTO agent_resource_grants (user_id, agent_id, resource_type, resource_id, enabled)
SELECT a.user_id, a.id, 'model', m.model, true
FROM digital_agents a
CROSS JOIN (VALUES ('qwen3.7-max'), ('qwen3.7-plus')) AS m(model)
WHERE a.status = 'active'
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

`qwen3.7-max` 是纯文本推理旗舰，带扩展思考、长上下文；`qwen3.7-plus` 是均衡档，能力略低但**支持图片理解**，因此更适合当降级备用（降级时不必担心多模态回合失去图片能力）。同代还有更便宜的 `qwen3.7-flash`，均在上述五个地域提供 OpenAI 兼容接口，换模型 id 即可。`qwen3.8-max-preview` 目前只对 Token Plan 订阅用户开放，且 Token Plan / Coding Plan 用的是以 `sk-sp-` 开头的专属密钥。

需要说明的是，降级到 `qwen3.7-plus` 并不会让原本不支持图片的主模型突然能读图：附件是否作为图片送入，由**配置的主模型**的 `supportsImageInput` 在更上游决定，降级发生时这个判断早已完成。

## 两个需要注意的地方

**一、思考内容不会进对话。** Qwen3 的思考文本走 `delta.reasoning_content`，我们的客户端只取 `delta.content`，所以推理过程天然不会出现在回复里——这正是产品红线要的（不暴露思考过程），不要"顺手"把它读出来。

**二、错误码语义。** 百炼直接用标准 HTTP 状态码（不像 KIE 把故障包在 HTTP 200 的 `{"code":500}` 里）：

| 状态码 | 含义 | 降级链是否重试 |
|---|---|---|
| 400 Invalid Request Error | 请求参数有问题 | 否 |
| 401 Incorrect API key provided | 密钥错误，或密钥与 Base URL 地域不匹配 | 否 |
| 429 Rate limit reached | QPS/QPM 超限 | 是 |
| 429 exceeded your current quota | 额度超限或欠费 | 是 |
| 500 server had an error | 服务端错误 | 是 |
| 503 engine is currently overloaded | 负载过高，可重试 | 是 |

429 会被当作可重试并切到下一个备用模型；欠费导致的 429 换模型也救不回来，此时看日志里的 `llm_http_429` 与响应片段。
