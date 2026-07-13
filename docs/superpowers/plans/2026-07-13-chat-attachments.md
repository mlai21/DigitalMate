# 聊天附件与多模态输入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在聊天输入框中支持上传图片与 PDF/TXT/MD/JSON/CSV，并让附件经过私有持久化、鉴权和统一 LLM 适配后真正进入模型输入。

**架构：** 附件先通过独立 API 保存为当前用户的临时记录，发送消息时在数据库事务中绑定。图片以 base64 多模态 block 进入 OpenAI/Anthropic 适配器，文档由服务端提取文本并以不可信数据边界进入上下文；聊天列表只返回安全展示元数据。

**技术栈：** Next.js 16 Node runtime、React 19、TypeScript、PostgreSQL、`pdf-parse@^2.4.5`、Vitest、Testing Library、Playwright

---

## 文件结构

- 创建 `src/server/attachments/types.ts`：附件领域类型、白名单和限制常量。
- 创建 `src/server/attachments/validation.ts`：文件名、扩展名、MIME、文件签名、数量与大小校验。
- 创建 `src/server/attachments/extraction.ts`：PDF 与 UTF-8 文档文本提取和上下文截断。
- 创建 `src/server/attachments/storage.ts`：私有磁盘保存、读取、删除和路径隔离。
- 创建 `src/server/attachments/context.ts`：数据库附件转 `LlmAttachment`，不把提取文本暴露给 UI。
- 创建 `src/server/attachments/cleanup.ts`：批量清理超过 24 小时的未绑定附件。
- 修改 `src/server/config/env.ts`：读取 `ATTACHMENT_STORAGE_DIR`。
- 修改 `.gitignore`、`docker-compose.yml`、`docs/env.md`：忽略本地附件并为 Web/Agent 挂载共享持久卷。
- 修改 `src/server/db/schema.sql`、`src/server/db/repositories.ts`：附件表、草稿生命周期、原子绑定和查询。
- 创建 `src/app/api/chat/attachments/route.ts`：上传附件。
- 创建 `src/app/api/chat/attachments/[attachmentId]/route.ts`：删除未绑定草稿。
- 创建 `src/app/api/chat/attachments/[attachmentId]/download/route.ts`：鉴权下载。
- 修改 `src/app/api/chat/route.ts`：接收 `attachmentIds`、允许纯附件消息、原子绑定并传入模型。
- 修改 `src/app/api/messages/route.ts`、`src/app/api/conversations/[conversationId]/messages/route.ts`、`src/app/page.tsx`：返回安全附件元数据。
- 修改 `src/server/llm/types.ts`、`src/server/llm/openai-compat.ts`、`src/server/llm/anthropic.ts`：统一多模态消息类型和厂商载荷。
- 修改 `src/server/agent/run-agent.ts`：把当前与最近历史附件加入上下文。
- 创建 `src/components/chat/attachment-picker.tsx`：加号菜单、文件选择、拖放、上传状态与预览。
- 修改 `src/components/chat/chat-input.tsx`、`src/components/chat/chat-shell.tsx`、`src/components/chat/message-bubble.tsx`：附件提交、失败恢复和历史卡片。
- 修改 `src/app/globals.css`：附件菜单、预览和消息卡片样式。
- 修改 `src/agent-service/index.ts`：清理超过 24 小时的临时附件。
- 修改 `docs/prd.md`：新增 P0-10 并划清 P2 文件任务边界。
- 新增/修改对应单元、API、组件和 E2E 测试。

### 任务 1：安装 PDF 解析依赖并定义附件领域模型

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`src/server/attachments/types.ts`
- 创建：`tests/unit/attachment-validation.test.ts`

- [ ] **步骤 1：安装 Node 22 支持的 PDF 解析器**

运行：`npm install pdf-parse@^2.4.5`

预期：`package.json` 和 `package-lock.json` 增加 `pdf-parse`；该版本自带 TypeScript 类型，不安装旧版 `@types/pdf-parse`。

- [ ] **步骤 2：编写附件限制与类型的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, classifyAllowedAttachment } from "@/server/attachments/types";

describe("attachment types", () => {
  it("accepts the first phase allowlist only", () => {
    expect(classifyAllowedAttachment("photo.png", "image/png")).toBe("image");
    expect(classifyAllowedAttachment("notes.md", "text/markdown")).toBe("document");
    expect(classifyAllowedAttachment("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBeNull();
  });

  it("fixes message limits", () => {
    expect(ATTACHMENT_LIMITS).toEqual({ maxCount: 4, maxFileBytes: 10 * 1024 * 1024, maxMessageBytes: 20 * 1024 * 1024 });
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`npm test -- tests/unit/attachment-validation.test.ts`

预期：FAIL，提示附件模块不存在。

- [ ] **步骤 4：定义稳定类型和白名单**

```ts
export type AttachmentKind = "image" | "document";
export type AttachmentStatus = "pending" | "ready" | "failed" | "bound";

export type ChatAttachment = {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  downloadUrl?: string;
};

export const ATTACHMENT_LIMITS = {
  maxCount: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxMessageBytes: 20 * 1024 * 1024,
} as const;
```

白名单固定 JPEG/PNG/WebP/PDF/TXT/MD/JSON/CSV；`classifyAllowedAttachment` 必须同时匹配扩展名和声明 MIME，不接受 SVG、HTML、Office、压缩包和可执行文件。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/attachment-validation.test.ts`

预期：2 个测试 PASS。

```bash
git add package.json package-lock.json src/server/attachments/types.ts tests/unit/attachment-validation.test.ts
git commit -m "feat(P0-10): 定义聊天附件类型与限制"
```

### 任务 2：实现文件校验、提取与私有存储

**文件：**
- 创建：`src/server/attachments/validation.ts`
- 创建：`src/server/attachments/extraction.ts`
- 创建：`src/server/attachments/storage.ts`
- 修改：`src/server/config/env.ts`
- 修改：`.gitignore`
- 修改：`docker-compose.yml`
- 修改：`docs/env.md`
- 修改：`tests/unit/docker-config.test.ts`
- 修改：`tests/unit/attachment-validation.test.ts`
- 创建：`tests/unit/attachment-extraction.test.ts`
- 创建：`tests/unit/attachment-storage.test.ts`

- [ ] **步骤 1：编写安全边界的失败测试**

覆盖以下实际输入：

```ts
expect(validateAttachmentFile({ fileName: "../x.png", declaredMime: "image/png", bytes: pngBytes })).toMatchObject({ fileName: "x.png" });
expect(() => validateAttachmentFile({ fileName: "x.png.exe", declaredMime: "image/png", bytes: pngBytes })).toThrow("attachment_type_not_allowed");
expect(() => validateAttachmentFile({ fileName: "x.png", declaredMime: "image/png", bytes: Buffer.from("not-png") })).toThrow("attachment_signature_mismatch");
expect(truncateAttachmentText("a".repeat(120_000), 100_000)).toEqual({ text: "a".repeat(100_000), truncated: true });
```

存储测试用临时目录验证 `saveAttachment`、`readAttachment`、`deleteAttachment`，并断言 `../../secret` 存储键被拒绝。

- [ ] **步骤 2：运行三个测试文件确认失败**

运行：`npm test -- tests/unit/attachment-validation.test.ts tests/unit/attachment-extraction.test.ts tests/unit/attachment-storage.test.ts`

预期：FAIL，提示三个实现模块不存在。

- [ ] **步骤 3：实现校验与文本提取**

签名规则：JPEG `ff d8 ff`、PNG `89 50 4e 47 0d 0a 1a 0a`、WebP `RIFF....WEBP`、PDF `%PDF-`。TXT/MD/JSON/CSV 只允许 UTF-8，拒绝 NUL 字节；JSON 必须能 `JSON.parse`。

PDF 提取固定使用 v2 API并确保释放资源：

```ts
import { PDFParse } from "pdf-parse";

export async function extractPdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}
```

`parser.getText()` 外层设置 15 秒超时，超时或异常都进入 `finally` 调用 `destroy()`。文本提取统一返回 `{ text, truncated }`，每个文档最大 100,000 字符；空 PDF 返回 `attachment_no_extractable_text`。

- [ ] **步骤 4：实现路径隔离存储**

`storage.ts` 只接受服务端生成的 UUID 存储键，使用 `path.resolve(root, key)` 后验证结果仍在根目录内；写入采用临时文件加原子重命名。`readEnv` 增加：

```ts
attachmentStorageDir: source.ATTACHMENT_STORAGE_DIR ?? path.join(process.cwd(), "data", "attachments")
```

`.gitignore` 增加 `data/attachments/`。`docker-compose.yml` 在 `web` 和 `agent` 中同时设置 `ATTACHMENT_STORAGE_DIR=/app/data/attachments` 并挂载 `digitalmate-attachments:/app/data/attachments`，顶层声明同名 volume；`docs/env.md` 记录变量用途。`docker-config.test.ts` 断言两个服务共享该 volume。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/attachment-validation.test.ts tests/unit/attachment-extraction.test.ts tests/unit/attachment-storage.test.ts`

预期：全部 PASS。

```bash
git add src/server/attachments src/server/config/env.ts .gitignore docker-compose.yml docs/env.md tests/unit/attachment-*.test.ts tests/unit/docker-config.test.ts
git commit -m "feat(P0-10): 安全校验并提取聊天附件"
```

### 任务 3：新增附件表和原子绑定仓储

**文件：**
- 修改：`src/server/db/schema.sql`
- 修改：`src/server/db/repositories.ts`
- 修改：`tests/unit/schema.test.ts`
- 创建：`tests/unit/repositories-attachments.test.ts`

- [ ] **步骤 1：编写 Schema 和仓储失败测试**

`schema.test.ts` 增加：

```ts
expect(schema).toContain("CREATE TABLE IF NOT EXISTS message_attachments");
expect(schema).toMatch(/message_attachments[\s\S]+user_id uuid NOT NULL/);
expect(schema).toMatch(/message_attachments[\s\S]+message_id uuid REFERENCES messages\(id\) ON DELETE CASCADE/);
```

仓储测试验证：创建 ready 草稿；只按 userId 读取；`createWithAttachments` 在一个事务内创建 user 消息并把 ready 附件改为 bound；跨用户、failed、deleting 或已 bound 附件导致回滚；过期草稿通过原子认领进入 deleting，避免清理与消息绑定竞态。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/schema.test.ts tests/unit/repositories-attachments.test.ts`

预期：FAIL，缺少表和 `messageAttachments` 仓储。

- [ ] **步骤 3：新增表与索引**

```sql
CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE,
  extracted_text text,
  text_truncated boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'deleting', 'bound')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_stale ON message_attachments(status, created_at) WHERE message_id IS NULL;
```

- [ ] **步骤 4：实现仓储事务**

新增 `DbMessageAttachment` 和 `messageAttachments.createDraft/getForUser/listForMessages/deleteDraft/claimExpiredDrafts/markFailed/releaseDeletionClaim`。`claimExpiredDrafts` 必须使用单条 CTE、`FOR UPDATE SKIP LOCKED` 和 `UPDATE ... RETURNING`，把未绑定的过期 ready、已退避 5 分钟的 failed，以及租约超过 15 分钟的 deleting 草稿原子更新为 deleting；候选按 `updated_at, id` 排序，避免失败项反复霸占批次。认领后不能再被消息绑定，清理失败通过 `releaseDeletionClaim` 回到 failed 并从当前时间重新退避。新增：

```ts
messages.createWithAttachments(input: {
  userId: string;
  conversationId: string;
  content: string;
  attachmentIds: string[];
}): Promise<{ message: DbMessage; attachments: DbMessageAttachment[] }>
```

方法使用同一 `PoolClient` 的 `BEGIN/COMMIT/ROLLBACK`，`SELECT ... FOR UPDATE` 锁定附件，并校验 user、`status = 'ready'`、`message_id IS NULL`、数量和总大小后再绑定。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/schema.test.ts tests/unit/repositories-attachments.test.ts`

预期：全部 PASS。

```bash
git add src/server/db/schema.sql src/server/db/repositories.ts tests/unit/schema.test.ts tests/unit/repositories-attachments.test.ts
git commit -m "feat(P0-10): 持久化并原子绑定聊天附件"
```

### 任务 4：实现上传、删除和鉴权下载 API

**文件：**
- 创建：`src/app/api/chat/attachments/route.ts`
- 创建：`src/app/api/chat/attachments/[attachmentId]/route.ts`
- 创建：`src/app/api/chat/attachments/[attachmentId]/download/route.ts`
- 创建：`tests/unit/chat-attachments-route.test.ts`

- [ ] **步骤 1：编写三个路由的失败测试**

测试必须验证：未登录 401；无文件 400；超限 413；类型/签名不符 415；成功上传只返回安全字段；只能删除当前用户未绑定附件；跨用户下载返回 404；成功下载带安全 `Content-Disposition`。

成功响应断言：

```ts
expect(await response.json()).toEqual({
  attachment: {
    id: "attachment-1",
    kind: "document",
    fileName: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    status: "ready",
  },
});
expect(JSON.stringify(await response.clone().json())).not.toContain("storageKey");
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/chat-attachments-route.test.ts`

预期：FAIL，三个路由模块不存在。

- [ ] **步骤 3：实现上传路由**

`POST` 固定 `runtime = "nodejs"`，登录后使用 `busboy` 直接流式消费 `request.body`，不得调用会先完整解析请求的 `request.formData()`。`Content-Length` 只用于 11 MiB 快速拒绝，同时流内强制单文件 10 MiB、总请求 11 MiB、单文件/单字段/最多两有效 part；达到限制立即取消剩余请求体并返回稳定 413。随后执行声明类型、真实签名和文本提取。

附件状态按 `pending → ready|failed` 发布：先创建 pending 草稿，再原子保存私有文件，最后 `markReady`；保存或 ready 转换失败时先 `markFailed` 保留可观测记录，再尽力删除磁盘文件。超过 24 小时的 pending 也必须进入清理认领。Caddy 对 `POST /api/chat/attachments` 设置 11 MB 请求体上限，作为应用层流式限制之前的外围防线。

- [ ] **步骤 4：实现删除与下载路由**

`DELETE` 只删除 `message_id IS NULL` 且属于当前用户的记录；缺失、跨用户、已绑定和已删除统一空 204。删除认领必须生成 `deletion_claim_token`，接管 ready/failed/deleting 草稿；释放和最终删除都匹配 token，旧 worker 不能改写新认领。磁盘删除或数据库删除失败均尝试按 token 释放为 failed，重复请求可用新 token 立即接管并继续幂等删除。`GET download` 通过 userId 查询附件，设置 `Content-Type`、`Content-Length` 与 RFC 5987 编码文件名，文件缺失返回 404。

仓储并发测试默认通过 `embedded-postgres` 临时启动真实 PostgreSQL 16（macOS arm64/Linux、Node 22），运行后清理数据目录；`TEST_DATABASE_URL` 仍可覆盖。不得因本机没有常驻 PostgreSQL 而跳过 `FOR UPDATE SKIP LOCKED`、事务绑定和 deletion token fencing 测试。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/chat-attachments-route.test.ts`

预期：全部 PASS。

```bash
git add src/app/api/chat/attachments tests/unit/chat-attachments-route.test.ts
git commit -m "feat(P0-10): 增加私有聊天附件接口"
```

### 任务 5：扩展统一 LLM 多模态类型与适配器

**文件：**
- 修改：`src/server/llm/types.ts`
- 修改：`src/server/llm/catalog.ts`
- 修改：`src/server/llm/openai-compat.ts`
- 修改：`src/server/llm/anthropic.ts`
- 修改：`tests/unit/llm-openai-compat.test.ts`
- 修改：`tests/unit/llm-anthropic.test.ts`
- 修改：`tests/unit/llm-router.test.ts`

- [ ] **步骤 1：编写两种厂商载荷的失败测试**

统一输入：

```ts
const message = {
  role: "user" as const,
  content: "看一下",
  attachments: [
    { kind: "image" as const, fileName: "cat.png", mimeType: "image/png", base64: "aGVsbG8=" },
    { kind: "document" as const, fileName: "notes.md", mimeType: "text/markdown", text: "正文", truncated: false },
  ],
};
```

OpenAI 断言 `content` 是 `text + image_url + text` 数组；Anthropic 断言为 `text + image(source.type=base64) + text` blocks。文档文本必须包含文件名、不可信数据说明和开始/结束边界。无附件旧消息仍保持字符串。

模型目录测试还要断言所有内置主对话模型明确声明 `supportsImageInput`；自定义未知模型默认 false，不能静默假设支持视觉。

- [ ] **步骤 2：运行适配器测试确认失败**

运行：`npm test -- tests/unit/llm-openai-compat.test.ts tests/unit/llm-anthropic.test.ts tests/unit/llm-router.test.ts`

预期：FAIL，附件被忽略或类型不存在。

- [ ] **步骤 3：定义统一附件类型**

```ts
export type LlmAttachment =
  | { kind: "image"; fileName: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; base64: string }
  | { kind: "document"; fileName: string; mimeType: string; text: string; truncated: boolean };

export type LlmMessage = {
  role: LlmRole;
  content: string;
  attachments?: LlmAttachment[];
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
};
```

`ModelCatalogEntry` 增加 `supportsImageInput: boolean`，并导出：

```ts
export function supportsImageInput(modelId: string): boolean {
  return MODEL_CATALOG.find((entry) => entry.id === modelId)?.supportsImageInput ?? false;
}
```

- [ ] **步骤 4：实现两个映射器**

只对 `role === "user"` 处理附件。OpenAI 图片使用 `data:${mimeType};base64,${base64}`；Anthropic 图片使用 `{ type: "image", source: { type: "base64", media_type: mimeType, data: base64 } }`。文档文本由共享 `formatDocumentAttachment` 生成，禁止把内容放入 system prompt。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/llm-openai-compat.test.ts tests/unit/llm-anthropic.test.ts tests/unit/llm-router.test.ts`

预期：全部 PASS。

```bash
git add src/server/llm tests/unit/llm-openai-compat.test.ts tests/unit/llm-anthropic.test.ts tests/unit/llm-router.test.ts
git commit -m "feat(P0-10): 统一图片与文档模型输入"
```

### 任务 6：把附件绑定聊天事务并送入 Agent

**文件：**
- 创建：`src/server/attachments/context.ts`
- 修改：`src/server/agent/run-agent.ts`
- 修改：`src/app/api/chat/route.ts`
- 修改：`tests/unit/run-agent.test.ts`
- 修改：`tests/unit/chat-route.test.ts`

- [ ] **步骤 1：编写聊天链路失败测试**

覆盖：`message` 为空但有附件时通过；两者都空返回 400；非法/越权附件在创建消息前失败；成功调用 `createWithAttachments`；当前附件和最近历史附件进入 `runAgent`；图片文件从私有存储读取后转 base64；文档只使用数据库提取文本。

关键断言：

```ts
expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({
  message: "",
  attachments: [expect.objectContaining({ kind: "image", fileName: "cat.png" })],
}));
expect(mocks.messagesCreate).not.toHaveBeenCalled();
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/chat-route.test.ts tests/unit/run-agent.test.ts`

预期：FAIL，schema 拒绝空文字且 `runAgent` 没有 attachments。

- [ ] **步骤 3：实现安全上下文加载器**

`context.ts` 暴露：

```ts
export async function loadLlmAttachments(
  attachments: DbMessageAttachment[],
  storage: AttachmentStorage,
): Promise<LlmAttachment[]>;
```

图片读取私有文件并 base64；文档使用 `extractedText`。最多载入当前上下文内 4 个附件、20 MB 图片和每文档 100,000 字符，超过时抛出稳定错误而不是静默忽略。

- [ ] **步骤 4：接入 Chat API 与 Agent**

请求 schema 改为：

```ts
const requestSchema = z.object({
  message: z.string().max(8000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(4).default([]),
  conversationId: z.string().uuid().optional(),
  skillIds: z.array(z.string().uuid()).max(3).optional(),
  searchEnabled: z.boolean().optional(),
}).refine((value) => value.message.trim().length > 0 || value.attachmentIds.length > 0, "message_or_attachment_required");
```

先在创建本轮 user message前读取 recent history，避免现有流程把当前消息同时放进 history 又在 `buildMessages` 末尾追加一次。附件存在时，再用 `supportsImageInput(model)` 检查图片能力；未知或不支持的模型返回 `image_model_not_supported`，且不创建消息、不绑定附件。检查通过后用 `createWithAttachments`，把历史消息对应附件和当前附件分别传给 `runAgent`。`RunAgentInput` 增加 `attachments?: LlmAttachment[]`，`buildMessages` 的最后一条 user message带当前附件；历史附件仍绑定在各自的 `LlmMessage` 上。附件不改变 `webSearchEnabled` 或 `searchGate`。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- tests/unit/chat-route.test.ts tests/unit/run-agent.test.ts`

预期：全部 PASS。

```bash
git add src/server/attachments/context.ts src/server/agent/run-agent.ts src/app/api/chat/route.ts tests/unit/chat-route.test.ts tests/unit/run-agent.test.ts
git commit -m "feat(P0-10): 将聊天附件送入主模型上下文"
```

### 任务 7：在消息接口中返回安全附件元数据

**文件：**
- 修改：`src/app/api/messages/route.ts`
- 修改：`src/app/api/conversations/[conversationId]/messages/route.ts`
- 修改：`src/app/page.tsx`
- 修改：`tests/unit/conversations-api.test.ts`
- 修改：`tests/unit/chat-route.test.ts`

- [ ] **步骤 1：编写消息序列化失败测试**

断言初始页面、轮询接口和会话消息接口都返回：

```ts
attachments: [{
  id: "attachment-1",
  kind: "document",
  fileName: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 12,
  status: "bound",
  downloadUrl: "/api/chat/attachments/attachment-1/download",
}]
```

并断言响应不包含 `storageKey`、`extractedText`、`errorCode`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/conversations-api.test.ts tests/unit/chat-route.test.ts`

预期：FAIL，消息没有 attachments。

- [ ] **步骤 3：实现批量附件序列化**

先取得本次消息 ID 列表，再调用 `messageAttachments.listForMessages(user.id, ids)` 一次批量查询并按 messageId 分组；禁止逐消息查询。共享 `toChatAttachment` 只选择安全字段并生成下载 URL。

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- tests/unit/conversations-api.test.ts tests/unit/chat-route.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add src/app/page.tsx src/app/api/messages/route.ts src/app/api/conversations tests/unit/conversations-api.test.ts tests/unit/chat-route.test.ts
git commit -m "feat(P0-10): 在聊天历史中返回附件卡片数据"
```

### 任务 8：实现输入框附件菜单、上传状态和历史卡片

**文件：**
- 创建：`src/components/chat/attachment-picker.tsx`
- 修改：`src/components/chat/chat-input.tsx`
- 修改：`src/components/chat/chat-shell.tsx`
- 修改：`src/components/chat/message-bubble.tsx`
- 修改：`src/app/globals.css`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：编写用户交互失败测试**

覆盖：加号打开两个菜单项；Esc、点击外部和完成选择关闭；图片/文件 accept 精确；上传中禁用发送；失败显示重试；移除调用 DELETE；纯附件可发送；发送失败保留输入和附件；成功后清空；历史消息显示可下载卡片。

提交断言：

```ts
expect(onSubmit).toHaveBeenCalledWith("", {
  attachmentIds: ["attachment-1"],
  attachments: [expect.objectContaining({ fileName: "cat.png", status: "ready" })],
});
```

- [ ] **步骤 2：运行组件测试确认失败**

运行：`npm test -- tests/unit/chat-ui.test.tsx`

预期：FAIL，页面没有“添加附件”和“上传图片/上传文件”。

- [ ] **步骤 3：实现 AttachmentPicker**

组件属性固定为：

```ts
type AttachmentPickerProps = {
  attachments: UploadingAttachment[];
  disabled?: boolean;
  onChange: (attachments: UploadingAttachment[]) => void;
};
```

内部隐藏两个 file input；图片 accept 为 `.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp`，文件 accept 为 `.pdf,.txt,.md,.json,.csv,application/pdf,text/plain,text/markdown,application/json,text/csv`。每个文件独立 POST，状态为 `uploading|ready|failed`，失败保存用户可读原因。菜单使用按钮和 `aria-expanded`，点击外部与 Escape 关闭。输入框的 `dragover/drop` 只接收同一白名单并复用相同的数量、大小和上传逻辑；拖入不支持文件时就地显示错误。

- [ ] **步骤 4：接入发送和消息展示**

`ChatInput.onSubmit` 改为返回 `Promise<boolean>`，options 增加 `attachmentIds` 与安全展示 attachments；存在 ready 附件时允许空文字。`ChatShell.sendMessage` 在 SSE 正常完成时返回 true，网络/API/SSE 失败时返回 false；乐观 user message带附件，POST `/api/chat` 只发送 ID。`ChatInput` 只有收到 true 才清空文字、Skill、搜索开关和附件，false 时完整保留草稿。`MessageBubble` 在正文下渲染附件卡片，正文为空时仍保留气泡行。

- [ ] **步骤 5：实现符合设计系统的样式并测试**

菜单 Level 1 阴影、24px 圆角体系内；附件卡片使用暖色 `surface-sunken` 与 1px border；错误用 danger；触控目标 44px；图片缩略图使用固定 56×56px、`object-fit: cover`。图片预览的 object URL 在移除、发送成功和组件卸载时调用 `URL.revokeObjectURL`。不使用 spinner、进度条或科技蓝。

运行：`npm test -- tests/unit/chat-ui.test.tsx`

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add src/components/chat src/app/globals.css tests/unit/chat-ui.test.tsx
git commit -m "feat(P0-10): 在聊天框上传并展示附件"
```

### 任务 9：清理过期草稿并完成文档与端到端验收

**文件：**
- 创建：`src/server/attachments/cleanup.ts`
- 修改：`src/agent-service/index.ts`
- 创建：`tests/unit/attachment-cleanup.test.ts`
- 修改：`docs/prd.md`
- 修改：`tests/e2e/chat.spec.ts`

- [ ] **步骤 1：编写 24 小时清理失败测试**

模拟 `messageAttachments.claimExpiredDrafts(24)` 原子返回带 `deletionClaimToken` 的 deleting 草稿，断言服务删除对应磁盘文件后按相同 token 调用 `deleteDraft`；单个文件缺失不阻断其他清理；删除失败按相同 token 调用 `releaseDeletionClaim` 恢复为 failed 且 5 分钟内不重试；旧 token 不能释放或删除新 worker 的认领；进程崩溃留下的 deleting 在 15 分钟租约后可重新认领；两个清理 worker 不会认领同一记录，pending 超过 24 小时可被认领，bound 附件不会被认领。另需清理私有存储目录中超过安全租约时间的 `.tmp` 原子写入残留；不得把刚写入中的临时文件删除。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/attachment-cleanup.test.ts`

预期：FAIL，附件清理模块不存在。

- [ ] **步骤 3：实现定时清理**

在常驻服务中增加每小时一次的 `cleanupStaleAttachments`；启动时也执行一次。每次最多处理 100 条，单条失败记录错误摘要后继续，不记录文件内容。

- [ ] **步骤 4：更新 PRD**

将版本提升到 v0.8，并新增：

```md
| P0-10 | 稳定阅读与聊天附件 | 输入框增高不得遮挡消息；阅读历史时新内容不得强制滚到底部，以新消息按钮提示。输入框“+”支持 JPEG/PNG/WebP 与 PDF/TXT/MD/JSON/CSV，附件保存在自有私有存储并真正进入主模型；上传不等于联网授权。CSV 在本功能中只作为文本上下文，不触发 P2 表格处理。 |
```

同步 4.3 的 P2-2 说明：P0-10 只负责对话理解，清洗、汇总和产出文件仍属于冻结的 P2。

- [ ] **步骤 5：增加 E2E 附件场景**

使用 Playwright 的 `setInputFiles` 上传 PNG、PDF、TXT、MD、JSON、CSV，验证附件预览、纯附件发送、刷新后卡片仍在、下载接口成功；再上传 `.svg` 和 10MB+1 字节文件，验证明确错误。请求 mock 检查 `/api/chat` 收到 attachmentIds 而不是 base64 或提取文本。

- [ ] **步骤 6：运行完整验证**

运行：

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e -- tests/e2e/chat.spec.ts
npm run build
git diff --check
```

预期：所有命令退出码为 0；浏览器验收覆盖桌面和移动视口；差异中没有存储路径、提取文本或模型载荷进入用户可见响应。

- [ ] **步骤 7：提交**

```bash
git add src/server/attachments/cleanup.ts src/agent-service/index.ts tests/unit/attachment-cleanup.test.ts docs/prd.md tests/e2e/chat.spec.ts
git commit -m "docs(P0-10): 完成聊天附件验收与产品约束"
```
