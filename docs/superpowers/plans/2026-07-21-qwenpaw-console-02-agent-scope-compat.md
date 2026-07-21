# 数字分身边界与 Console 兼容层实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M2：把现有数据安全回填到唯一默认分身，所有分身级数据使用非空 `agent_id`，同时建立 Console 兼容 API、CSRF、revision、审计和加密 secret 基础。

**架构：** `digital_agents` 是分身身份根，`AgentScope={userId,agentId}` 贯穿 Web、Agent service 和仓储；用户级模型/Skill/工具定义不复制，分身级人设、会话、记忆、任务、渠道路由严格隔离。单个 catch-all Next route 把 QwenPaw API 路径分发到专注的兼容模块，模块只调用领域服务，不直接拼 SQL。

**技术栈：** Next.js App Router、TypeScript、PostgreSQL、Zod、HMAC-SHA256、AES-256-GCM、Vitest、embedded-postgres。

---

## 文件结构

**创建：**

- `src/server/agents/types.ts`：`AgentScope`、`DigitalAgent` 和状态类型。
- `src/server/agents/service.ts`：默认分身解析、单分身能力门控和默认资源继承。
- `src/server/agents/repository.ts`：`digital_agents` 与 `agent_resource_grants` 查询。
- `src/server/agents/features.ts`：本期 `multiAgent=false` 的唯一开关。
- `src/server/settings/agent-settings.ts`：分身级人设、主动性、节奏、搜索与模型覆盖。
- `src/server/admin/compat/types.ts`：兼容响应、错误和 handler 上下文。
- `src/server/admin/compat/router.ts`：精确 method/path 路由，不直接访问数据库。
- `src/server/admin/compat/handlers/auth.ts`：共享 Cookie 登录状态与 CSRF token。
- `src/server/admin/compat/handlers/agents.ts`：默认分身 list/get/update；创建、克隆、导入、删除禁用。
- `src/server/admin/compat/handlers/channels.ts`：17 种渠道 schema、连接配置、secret 状态和 revision。
- `src/server/admin/compat/handlers/preferences.ts`：语言、时区和 Console 根信息。
- `src/server/admin/compat/handlers/capabilities.ts`：冻结能力的稳定 `501 capability_disabled`。
- `src/server/admin/compat/register-core.ts`：注册本计划已经可用的兼容端点。
- `src/app/api/admin/compat/[...segments]/route.ts`：GET/POST/PUT/PATCH/DELETE 统一入口。
- `src/server/http/csrf.ts`：同源校验、短期签名 token 生成与验证。
- `src/server/security/encrypted-secret.ts`：AES-256-GCM 值对象和 key version。
- `src/server/admin/audit.ts`：管理写操作审计领域服务。
- `src/server/channels/manifests/types.ts`：渠道配置字段、secret 字段和运行条件类型。
- `src/server/channels/manifests/catalog.ts`：17 个渠道的 QwenPaw 同序字段清单。
- `tests/unit/agent-scope.test.ts`：默认分身、能力门控与资源继承。
- `tests/unit/admin-compat-router.test.ts`：method/path、鉴权、CSRF、错误体和能力状态。
- `tests/unit/admin-compat-agents.test.ts`：单 Agent Console 合同。
- `tests/unit/admin-compat-channels.test.ts`：17 schema、revision 和 secret 脱敏。
- `tests/unit/encrypted-secret.test.ts`：密文、篡改、错 key 与日志安全。
- `tests/integration/agent-scope-migration.test.ts`：真实 PostgreSQL 回填、约束和隔离。
- `tests/integration/admin-audit.test.ts`：revision 原子更新和 secret 审计。
- `docs/verification/qwenpaw-console-m2.md`：迁移、隔离、兼容 API、密钥和单 Agent 能力报告。

**修改：**

- `src/server/db/schema.sql`：新增分身、grant、分身设置、渠道连接/secret、管理审计；给分身级表回填并约束 `agent_id`。
- `src/server/db/seed.ts`：先建立默认用户，再幂等建立唯一默认分身和默认会话。
- `src/server/db/repositories.ts`：所有分身级方法接受 `AgentScope`；组合新 repository。
- `src/server/settings/defaults.ts`、`src/server/settings/update.ts`：拆分用户级模型默认值和分身级设置。
- `src/server/config/env.ts`、`.env.example`、`docker-compose.yml`：增加 `CHANNEL_SECRETS_KEY`，不复用 `APP_SECRET`。
- `src/app/api/chat/route.ts`、`src/app/api/conversations/**`、`src/app/api/messages/route.ts`、`src/app/api/projects/**`、`src/app/api/chat/attachments/**`：解析默认分身并传 `AgentScope`。
- `src/app/api/admin/**`、`src/app/api/skills/route.ts`、`src/app/api/tasks/**`：用户级资源保留 user scope，分身级读写增加 agent scope。
- `src/agent-service/index.ts`、`src/server/agent/**`、`src/server/evolution/**`、`src/server/goals/**`：后台循环按默认分身逐个运行，不使用进程内“当前 Agent”。
- `src/server/admin/personal-data.ts`、`src/app/api/admin/data/export/route.ts`、`src/app/api/admin/data/clear/route.ts`：导出/清空带 agent 标识并停止连接前置。
- 所有现有 repository 与 route 测试：补充 `agentId` 和隔离断言。

### 任务 1：创建默认分身并完成非空 `agent_id` 迁移

**文件：**
- 修改：`src/server/db/schema.sql`
- 修改：`src/server/db/seed.ts`
- 修改：`tests/unit/schema.test.ts`
- 创建：`tests/integration/agent-scope-migration.test.ts`

- [ ] **步骤 1：编写失败的 schema 与迁移测试**

```ts
const AGENT_SCOPED_TABLES = [
  "projects", "conversations", "messages", "message_attachments",
  "conversation_summaries", "memory_entries", "tool_call_logs",
  "proactive_tasks", "channel_identities", "channel_messages",
  "interjection_decisions", "reflections", "skill_usage_logs",
  "task_runs", "task_artifacts", "llm_usage_logs", "memory_jobs",
  "goals", "goal_steps",
] as const;

it("为全部分身级表建立非空 agent_id", async () => {
  const columns = await readAgentColumns(pool);
  for (const table of AGENT_SCOPED_TABLES) {
    expect(columns.get(table)).toMatchObject({ isNullable: "NO", foreignTable: "digital_agents" });
  }
});
```

迁移测试先用旧 schema 形状插入两个用户的会话、记忆、目标、任务、附件和渠道消息，再执行新 `schema.sql` 两次；断言每个用户恰有一个默认分身、所有旧行归属本用户默认分身、无跨用户 FK、第二次迁移不新增分身。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/schema.test.ts tests/integration/agent-scope-migration.test.ts`

预期：FAIL，`digital_agents` 和 `agent_id` 不存在。

- [ ] **步骤 3：创建身份根与未来资源授权表**

```sql
CREATE TABLE IF NOT EXISTS digital_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL,
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  is_default boolean NOT NULL DEFAULT false,
  inherits_user_resources boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_agents_one_default
  ON digital_agents(user_id) WHERE is_default = true;

CREATE TABLE IF NOT EXISTS agent_resource_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES digital_agents(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('model','skill','tool')),
  resource_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, resource_type, resource_id)
);
```

- [ ] **步骤 4：实现幂等回填顺序**

对每个 agent-scoped 表按固定模板执行：先 `ADD COLUMN IF NOT EXISTS agent_id uuid`；从自身 `user_id` 或父表关联默认分身回填；若仍有 NULL 则抛错；再添加 FK 与 `SET NOT NULL`。在回填前执行：

```sql
INSERT INTO digital_agents (user_id, slug, display_name, persona, is_default)
SELECT users.id, 'digitalmate', 'DigitalMate', COALESCE(settings.persona, '{}'::jsonb), true
FROM users
LEFT JOIN settings ON settings.user_id = users.id
ON CONFLICT (user_id, slug) DO UPDATE
SET is_default = true, updated_at = now();
```

所有唯一索引把 `agent_id` 纳入业务边界；消息 turn 唯一索引改为 `(user_id, agent_id, client_turn_id, role)`；旧索引在新索引创建成功后才删除。

- [ ] **步骤 5：更新 seed 顺序**

```ts
const user = await repositories.users.ensureDefault();
const agent = await repositories.agents.ensureDefault(user.id);
await repositories.conversations.getOrCreateDefault({ userId: user.id, agentId: agent.id });
```

- [ ] **步骤 6：运行迁移测试两次**

运行：`npm test -- --run tests/unit/schema.test.ts tests/integration/agent-scope-migration.test.ts`

预期：PASS；重复迁移后每用户仍只有一个默认分身，全部目标表 `agent_id IS NOT NULL`。

- [ ] **步骤 7：提交 schema 迁移**

```bash
git add src/server/db/schema.sql src/server/db/seed.ts tests/unit/schema.test.ts tests/integration/agent-scope-migration.test.ts
git commit -m "feat(P0-8): 建立默认数字分身数据边界"
```

**回滚：** 稳定期前不删除新列；应用回滚只停止使用新入口，数据库保留新增结构。

**完成证据：** 双次迁移测试、非空/FK 查询和每用户单默认分身唯一索引。

### 任务 2：让仓储与执行链显式携带 `AgentScope`

**文件：**
- 创建：`src/server/agents/types.ts`
- 创建：`src/server/agents/repository.ts`
- 创建：`src/server/agents/service.ts`
- 创建：`src/server/agents/features.ts`
- 创建：`src/server/settings/agent-settings.ts`
- 修改：`src/server/db/repositories.ts`
- 修改：`src/server/settings/defaults.ts`
- 修改：`src/server/settings/update.ts`
- 创建：`tests/unit/agent-scope.test.ts`
- 修改：所有调用 `conversations`、`messages`、`memories`、`reflections`、`goals`、`proactiveTasks`、`channels`、`taskRuns`、`llmUsage` 的现有单测。

- [ ] **步骤 1：编写失败的类型与隔离测试**

```ts
it("同一用户的两个 agent 不能读取彼此记忆", async () => {
  await repositories.memories.createMany({ userId, agentId: agentA }, null, [memory("A")]);
  await repositories.memories.createMany({ userId, agentId: agentB }, null, [memory("B")]);
  await expect(repositories.memories.list({ userId, agentId: agentA }))
    .resolves.toEqual([expect.objectContaining({ content: "A", agentId: agentA })]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/agent-scope.test.ts tests/unit/repositories-memory.test.ts`

预期：FAIL，现有方法只接受 `userId`。

- [ ] **步骤 3：定义唯一作用域类型与能力门控**

```ts
export type AgentScope = Readonly<{ userId: string; agentId: string }>;

export const AGENT_FEATURES = Object.freeze({ multiAgent: false });

export function assertMultiAgentMutationAllowed(action: "create" | "clone" | "import" | "delete"): never {
  throw Object.assign(new Error("当前版本只启用默认数字分身"), {
    status: 501,
    code: "capability_disabled",
    details: { capability: `multi_agent_${action}` },
  });
}
```

- [ ] **步骤 4：拆分用户级与分身级设置**

新增 `agent_settings`：`user_id`、`agent_id`、`persona`、`proactivity`、`cadence`、`search`、`model_routing_override`、`revision`。迁移从旧 `settings` 复制数据；运行时只从 `agent_settings` 读 persona/proactivity/cadence/search，用户级 `settings.model_routing` 是默认模型路由，分身 override 只覆盖明确键。

```ts
export type EffectiveAgentSettings = {
  persona: PersonaSettings;
  proactivity: ProactivitySettings;
  cadence: CadenceSettings;
  search: SearchSettings;
  modelRouting: ModelRoutingSettings;
  revision: number;
};
```

- [ ] **步骤 5：逐仓储改为 `AgentScope`**

每个 agent-scoped SQL 的首个过滤条件固定为 `user_id = $1 AND agent_id = $2`。父 ID 查询也同时校验 scope；禁止只凭 `conversation_id`、`goal_id` 或 `message_id` 读取。用户级 `skills`、`toolRegistrations` 和模型目录继续接受 `userId`，其使用日志接受 `AgentScope`。

- [ ] **步骤 6：更新所有 Web 与后台调用方**

所有入口在最外层执行：

```ts
const user = await requireCurrentUser();
const agent = await repositories.agents.getDefault(user.id);
const scope = { userId: user.id, agentId: agent.id } satisfies AgentScope;
```

`runAgent`、反思、记忆抽取、压缩、目标循环、提醒和主动消息的输入都加入 `agentId`；`agent-service` 遍历 `agents.listActive()`，每个 tick 以独立 scope 执行，不能缓存一个全局当前 Agent。

- [ ] **步骤 7：运行分身级回归**

运行：`npm test -- --run tests/unit/agent-scope.test.ts tests/unit/repositories-memory.test.ts tests/unit/repositories-goals.test.ts tests/unit/chat-route.test.ts tests/unit/agent-service-shutdown.test.ts`

预期：PASS；测试中的查询断言同时包含 `user_id` 与 `agent_id`。

- [ ] **步骤 8：提交作用域改造**

```bash
git add src/server/agents/types.ts src/server/agents/service.ts src/server/agents/repository.ts src/server/agents/features.ts src/server/settings/agent-settings.ts src/server/settings/defaults.ts src/server/settings/update.ts src/server/db/repositories.ts src/app/api/chat/route.ts src/app/api/conversations/route.ts 'src/app/api/conversations/[conversationId]/route.ts' 'src/app/api/conversations/[conversationId]/messages/route.ts' src/app/api/messages/route.ts src/app/api/projects/route.ts 'src/app/api/projects/[projectId]/route.ts' src/app/api/chat/attachments/route.ts 'src/app/api/chat/attachments/[attachmentId]/route.ts' 'src/app/api/chat/attachments/[attachmentId]/download/route.ts' src/app/api/admin/data/clear/route.ts src/app/api/admin/data/export/route.ts src/app/api/admin/memories/delete/route.ts src/app/api/admin/memories/update/route.ts src/app/api/admin/reflections/status/route.ts src/app/api/admin/settings/route.ts src/app/api/admin/skills/create/route.ts src/app/api/admin/skills/import/route.ts src/app/api/admin/skills/revisions/route.ts src/app/api/admin/skills/status/route.ts src/app/api/admin/tool-registrations/create/route.ts src/app/api/admin/tool-registrations/status/route.ts src/app/api/skills/route.ts src/app/api/tasks/sandbox/route.ts src/app/api/tasks/csv/route.ts src/app/api/tasks/presentation/route.ts 'src/app/api/tasks/artifacts/[artifactId]/route.ts' src/agent-service/index.ts src/server/agent/compaction.ts src/server/agent/conversation-title.ts src/server/agent/memory-extraction.ts src/server/agent/memory.ts src/server/agent/persona.ts src/server/agent/proactive-delivery.ts src/server/agent/proactive-share.ts src/server/agent/reminders.ts src/server/agent/run-agent.ts src/server/agent/search-gate.ts src/server/agent/skill-command.ts src/server/agent/streaming.ts src/server/agent/tools/web-search.ts src/server/evolution/event-reflection.ts src/server/evolution/memory-consolidation.ts src/server/evolution/reflection.ts src/server/evolution/skill-improvement.ts src/server/evolution/skills.ts src/server/evolution/turn-review.ts src/server/goals/contract.ts src/server/goals/executor.ts src/server/goals/orchestrator.ts src/server/goals/state-machine.ts src/server/goals/verifier.ts tests/unit/agent-scope.test.ts tests/unit/repositories-memory.test.ts tests/unit/repositories-goals.test.ts tests/unit/repositories-reflections.test.ts tests/unit/chat-route.test.ts tests/unit/conversations-api.test.ts tests/unit/agent-service-shutdown.test.ts tests/unit/run-agent.test.ts tests/unit/memory-consolidation.test.ts tests/unit/reflection-scheduler.test.ts tests/unit/proactive-delivery.test.ts tests/unit/proactive-share.test.ts tests/unit/reminders.test.ts tests/unit/goal-orchestrator.test.ts tests/unit/goal-executor.test.ts tests/unit/goal-verifier.test.ts tests/unit/settings-update.test.ts
git commit -m "refactor(P0-8): 贯通默认分身执行作用域"
```

**回滚：** 代码可回滚到旧调用签名，数据库新列保留；不要将 `agent_id` 改回 nullable。

**完成证据：** 跨分身会话、消息、记忆、反思、目标、任务和日志隔离测试。

### 任务 3：实现同源与 CSRF 防护

**文件：**
- 创建：`src/server/http/csrf.ts`
- 创建：`tests/unit/admin-compat-router.test.ts`
- 修改：`src/server/auth/session.ts`
- 修改：`patches/qwenpaw-console/0003-route-auth.patch`
- 修改：`patches/qwenpaw-console/0004-api-compat.patch`

- [ ] **步骤 1：编写失败的 CSRF 测试**

```ts
it.each(["POST", "PUT", "PATCH", "DELETE"])("%s 缺少 CSRF 时拒绝", async (method) => {
  const response = await dispatchAdminCompat(new Request("https://mate.example/api/admin/compat/agents/default", {
    method,
    headers: { cookie: validSessionCookie, origin: "https://mate.example" },
  }));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
});
```

同时覆盖错误 Origin、过期 token、错 user、篡改 token、GET 无需 token、开发模式无 APP_PASSWORD 仍要求同源写操作。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts`

预期：FAIL，CSRF helper 和兼容 router 尚不存在。

- [ ] **步骤 3：实现短期签名 token**

```ts
export function createCsrfToken(input: { userId: string; sessionToken: string; secret: string; now?: Date }) {
  const expiresAt = Math.floor((input.now ?? new Date()).getTime() / 1000) + 1800;
  const nonce = randomBytes(18).toString("base64url");
  const sessionHash = createHash("sha256").update(input.sessionToken).digest("base64url");
  const payload = `${input.userId}.${sessionHash}.${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", input.secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
```

验证使用 `timingSafeEqual`，检查 user/session hash/过期时间；写请求要求 `Origin` 与经过可信代理解析后的 request origin 完全一致，并要求 `x-csrf-token`。

- [ ] **步骤 4：接入 Console 内存 token**

`/auth/status` 返回 `{enabled, authenticated, csrf_token}`；Console 只在内存保存 token，不写 localStorage。`request.ts` 对 POST/PUT/PATCH/DELETE 自动发送 `x-csrf-token`；401 跳 DigitalMate `/login?redirect=`，不展示上游登录页。

- [ ] **步骤 5：运行 CSRF 与补丁测试**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts tests/unit/qwenpaw-console-scripts.test.ts && npm run console:test`

预期：PASS；跨站写请求均为 403；合法 Cookie + Origin + token 成功进入 handler。

- [ ] **步骤 6：提交安全边界**

```bash
git add src/server/http/csrf.ts src/server/auth/session.ts tests/unit/admin-compat-router.test.ts patches/qwenpaw-console/0003-route-auth.patch patches/qwenpaw-console/0004-api-compat.patch
git commit -m "feat(P0-8): 统一 Console 登录态与 CSRF 防护"
```

**回滚：** 可回滚 Console 预览入口，但不得在保留写 API 时移除 CSRF；数据库不受影响。

**完成证据：** method 矩阵、Origin、过期、篡改、错 session 和合法写请求测试。

### 任务 4：建立兼容 API 路由和稳定错误合同

**文件：**
- 创建：`src/server/admin/compat/types.ts`
- 创建：`src/server/admin/compat/router.ts`
- 创建：`src/server/admin/compat/register-core.ts`
- 创建：`src/server/admin/compat/handlers/auth.ts`
- 创建：`src/server/admin/compat/handlers/preferences.ts`
- 创建：`src/server/admin/compat/handlers/capabilities.ts`
- 创建：`src/app/api/admin/compat/[...segments]/route.ts`
- 修改：`tests/unit/admin-compat-router.test.ts`

- [ ] **步骤 1：编写失败的 method/path 与错误体测试**

```ts
it("精确区分 method 并保持稳定错误体", async () => {
  const router = new AdminCompatRouter();
  router.get("/root", async () => ({ version: "digitalmate" }));
  expect((await router.dispatch(request("GET", "/root"))).status).toBe(200);
  const response = await router.dispatch(request("POST", "/root"));
  expect(response.status).toBe(405);
  await expect(response.json()).resolves.toEqual({
    error: { code: "invalid_request", message: "method_not_allowed" },
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts`

预期：FAIL，`AdminCompatRouter` 尚不存在。

- [ ] **步骤 3：实现路由上下文和错误映射**

```ts
export type AdminCompatContext = {
  request: Request;
  params: Record<string, string>;
  scope: AgentScope;
  csrfVerified: boolean;
};

export type AdminCompatHandler = (context: AdminCompatContext) => Promise<Response | unknown>;
```

Router 对路径段使用 `decodeURIComponent` 后再匹配，动态参数只匹配单段；所有 endpoint 先鉴权，写方法再 CSRF；ZodError→400、revision conflict→409、capability disabled→501、未知错误→500 且响应不含 stack/message 原文。

- [ ] **步骤 4：注册最小基础 API**

注册 `/auth/status`、`/auth/verify`、`/root`、`/language`、`/user-timezone`。`/root` 返回 DigitalMate 版本、Console 上游 tag 和 compat API revision；语言和时区写入用户级设置，不属于分身记忆。

- [ ] **步骤 5：运行路由合同测试**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts`

预期：PASS；404/405/400/401/403/409/501/500 的错误 JSON 形状稳定。

- [ ] **步骤 6：提交兼容路由骨架**

```bash
git add src/server/admin/compat src/app/api/admin/compat tests/unit/admin-compat-router.test.ts
git commit -m "feat(P0-8): 建立 Console 兼容 API 路由"
```

**回滚：** 删除 catch-all route 即可停止兼容 API；预览 Console 会显示连接错误而不会影响首页。

**完成证据：** 全状态码合同和未知异常脱敏测试。

### 任务 5：实现 revision、审计与加密 secret

**文件：**
- 修改：`src/server/db/schema.sql`
- 创建：`src/server/security/encrypted-secret.ts`
- 创建：`src/server/admin/audit.ts`
- 修改：`src/server/config/env.ts`
- 修改：`.env.example`
- 修改：`docker-compose.yml`
- 创建：`tests/unit/encrypted-secret.test.ts`
- 创建：`tests/integration/admin-audit.test.ts`

- [ ] **步骤 1：编写失败的加密与 revision 测试**

```ts
it("密文不含明文且篡改认证标签会失败", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret("super-secret", { key, keyVersion: 1 });
  expect(JSON.stringify(encrypted)).not.toContain("super-secret");
  expect(() => decryptSecret({ ...encrypted, authTag: flip(encrypted.authTag) }, key))
    .toThrow("secret_authentication_failed");
});
```

revision 集成测试并发提交相同 revision：一方成功并递增，一方得到 `config_revision_conflict`；审计只含 `configured: true`，全文搜索不能找到 secret。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/encrypted-secret.test.ts tests/integration/admin-audit.test.ts`

预期：FAIL，加密服务和表尚不存在。

- [ ] **步骤 3：增加连接、secret 和审计表**

```sql
CREATE TABLE IF NOT EXISTS channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES digital_agents(id) ON DELETE CASCADE,
  channel_type text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  runtime_node_id uuid,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  health_status text NOT NULL DEFAULT 'disabled'
    CHECK (health_status IN ('disabled','starting','connected','degraded','disconnected','blocked')),
  health_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  last_event_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_secrets (
  connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, field_name)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES digital_agents(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  before_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmation_source jsonb,
  status text NOT NULL CHECK (status IN ('success','failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **步骤 4：实现 AES-256-GCM 值对象**

使用 32-byte base64 `CHANNEL_SECRETS_KEY`、12-byte 随机 nonce、16-byte auth tag 和 `keyVersion=1`。解析 key 长度错误时启动连接管理器必须进入 blocked，不回退使用 `APP_SECRET`。解密错误只抛稳定码，日志不带 ciphertext、nonce、tag 或输入值。

- [ ] **步骤 5：实现原子 revision 更新与审计**

更新 SQL 使用：

```sql
UPDATE channel_connections
SET config = $4, revision = revision + 1, updated_at = now()
WHERE id = $1 AND user_id = $2 AND agent_id = $3 AND revision = $5
RETURNING *;
```

同一事务内 upsert secret 和插入 audit；0 行返回 409。audit summary 对 manifest 标为 secret 的字段统一写 `{configured:boolean}`。

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/encrypted-secret.test.ts tests/integration/admin-audit.test.ts`

预期：PASS；数据库转储、API JSON、audit JSON 和错误日志扫描均无测试 secret。

```bash
git add src/server/db/schema.sql src/server/security/encrypted-secret.ts src/server/admin/audit.ts src/server/config/env.ts .env.example docker-compose.yml tests/unit/encrypted-secret.test.ts tests/integration/admin-audit.test.ts
git commit -m "feat(P0-8): 增加 Console 配置版本与加密审计"
```

**回滚：** 禁用连接写 API即可；密文表和审计表保留，绝不把密文转存到环境或明文列。

**完成证据：** 篡改、错 key、并发 revision、secret 全链路搜索和审计事务测试。

### 任务 6：实现单 Agent Console 合同

**文件：**
- 创建：`src/server/admin/compat/handlers/agents.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-compat-agents.test.ts`
- 修改：`patches/qwenpaw-console/0004-api-compat.patch`

- [ ] **步骤 1：编写失败的上游 Agents API 测试**

```ts
it("只列出默认分身并保留 QwenPaw agent_id 字段", async () => {
  const body = await compatJson("GET", "/agents");
  expect(body.agents).toEqual([
    expect.objectContaining({ agent_id: defaultAgent.id, name: "DigitalMate", enabled: true, pinned: true }),
  ]);
});

it.each([
  ["POST", "/agents"],
  ["DELETE", `/agents/${defaultAgent.id}`],
  ["POST", "/agents/import"],
  ["POST", `/agents/${defaultAgent.id}/clone`],
])("%s %s 准确禁用第二分身", async (method, path) => {
  const response = await compat(method, path);
  expect(response.status).toBe(501);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "capability_disabled" } });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-agents.test.ts`

预期：FAIL，Agents handler 尚未注册。

- [ ] **步骤 3：实现 list/get/update 与禁用操作**

list/get 返回上游字段，但 `agent_id` 使用真实 UUID；update 只允许 display name、persona 和本期有效设置，带 revision；toggle default agent 为 false、删除、创建、clone、import 一律走 `assertMultiAgentMutationAllowed`。reorder 和 pin 在单元素输入时幂等成功，其他输入 501。

- [ ] **步骤 4：固定 Agent Selector 行为**

Console patch 保留原 selector/store/API 调用；隐藏新增/导入快捷入口或显示禁用说明，不删除 agent ID 参数。选择默认 Agent 后所有兼容请求发送 `x-digitalmate-agent-id`；服务端验证该 ID 属于当前用户且本期必须等于默认 Agent。

- [ ] **步骤 5：运行合同和 Console 组件测试**

运行：`npm test -- --run tests/unit/admin-compat-agents.test.ts && npm run console:test`

预期：PASS；selector 显示一个 Agent；创建、删除、克隆和导入有可见准确原因。

- [ ] **步骤 6：提交单 Agent 合同**

```bash
git add src/server/admin/compat/handlers/agents.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-agents.test.ts patches/qwenpaw-console/0004-api-compat.patch
git commit -m "feat(P0-8): 保留单数字分身 Console 数据通路"
```

**回滚：** 可退回只读 Agent 页面；数据库身份根保留。

**完成证据：** list/get/update/revision、selector header、跨用户 agent ID 拒绝和四种多分身操作禁用测试。

### 任务 7：实现 17 渠道 schema 与配置合同

**文件：**
- 创建：`src/server/channels/manifests/types.ts`
- 创建：`src/server/channels/manifests/catalog.ts`
- 创建：`src/server/admin/compat/handlers/channels.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-compat-channels.test.ts`

- [ ] **步骤 1：编写失败的完整渠道目录测试**

```ts
export const EXPECTED_CHANNEL_TYPES = [
  "imessage", "discord", "dingtalk", "feishu", "qq", "telegram",
  "mattermost", "mqtt", "matrix", "slack", "voice", "sip", "wecom",
  "xiaoyi", "yuanbao", "wechat", "onebot",
] as const;

it("Console 渠道目录完整且过滤开关强制开启", async () => {
  const types = await compatJson("GET", "/config/channels/types");
  expect(types).toEqual(EXPECTED_CHANNEL_TYPES);
  const schemas = await compatJson("GET", "/config/channels/schemas");
  for (const type of EXPECTED_CHANNEL_TYPES) {
    expect(schemas[type]).toBeDefined();
    expect(schemas[type].config_fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "filter_thinking", default: true, readonly: true }),
      expect.objectContaining({ name: "filter_tool_messages", default: true, readonly: true }),
    ]));
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-channels.test.ts`

预期：FAIL，manifest catalog 和 Channels handler 尚不存在。

- [ ] **步骤 3：定义 manifest 的可执行类型**

```ts
export type ChannelConfigField = Readonly<{
  name: string;
  label: string;
  kind: "text" | "number" | "boolean" | "select" | "secret";
  default?: unknown;
  readonly?: boolean;
}>;

export type ChannelManifest<TConfig extends Record<string, unknown>> = {
  type: ChannelType;
  label: string;
  description: string;
  runtime: "central" | "node" | "gateway" | "media";
  configSchema: z.ZodType<TConfig>;
  fields: readonly ChannelConfigField[];
  secretFields: readonly (keyof TConfig & string)[];
  capabilities: Readonly<{ typing: boolean; streaming: boolean; media: boolean; groups: boolean }>;
  prerequisites: readonly string[];
};
```

`catalog.ts` 按上游字段顺序录入 17 种配置。公共字段固定包括 enabled、bot_prefix、dm/group policy、allow_from、require_mention、dm/group disabled、`filter_thinking=true readonly`、`filter_tool_messages=true readonly`；平台字段逐项对应批准规格和上游 `config.py`。

- [ ] **步骤 4：实现上游 Channels API 形状**

实现 `/config/channels/types`、`/config/channels/schemas`、`/config/channels`、`/config/channels/:type` 的 GET/PUT。PUT 按 manifest 分离非敏感值与 secret；空密码表示保留旧值，显式 `{clear_secret:true}` 才删除；响应只返回 `configured`、`lastRotatedAt`。每个连接绑定当前 `agentId`，保存时强制两个 filter 为 true。

- [ ] **步骤 5：运行 17 渠道配置合同**

运行：`npm test -- --run tests/unit/admin-compat-channels.test.ts tests/integration/admin-audit.test.ts`

预期：PASS；17 个 schema 齐全；revision 冲突 409；secret 不回显；错误字段指向上游表单 name。

- [ ] **步骤 6：提交渠道配置合同**

```bash
git add src/server/channels/manifests src/server/admin/compat/handlers/channels.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-channels.test.ts
git commit -m "feat(P1-13): 建立十七渠道配置与密钥合同"
```

**回滚：** 关闭 Channels 写 API；连接默认 `enabled=false`，尚未启动任何平台网络连接。

**完成证据：** 17 类型、字段顺序、secret、revision、agent binding 和强制过滤测试。

### 任务 8：让导出与清空理解分身和连接 secret

**文件：**
- 修改：`src/server/admin/personal-data.ts`
- 修改：`src/app/api/admin/data/export/route.ts`
- 修改：`src/app/api/admin/data/clear/route.ts`
- 修改：`tests/unit/personal-data.test.ts`
- 修改：`tests/unit/admin-data-clear-route.test.ts`

- [ ] **步骤 1：编写失败的隐私测试**

```ts
it("普通导出含 agent 标识但排除渠道密钥材料", () => {
  const json = JSON.stringify(buildPersonalDataExport(fixture));
  expect(json).toContain(defaultAgentId);
  expect(json).not.toMatch(/ciphertext|nonce|auth_tag|super-secret|poll_token|temporary_url/);
});
```

清空测试断言顺序：取得用户级 mutation lock → 请求渠道管理器停止所有连接 → 删除附件和 artifact → 删除 channel secrets → 清数据库；任一步失败都不提前删除数据库定位行。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/personal-data.test.ts tests/unit/admin-data-clear-route.test.ts`

预期：FAIL，导出缺 agent 信息且清空不知道连接。

- [ ] **步骤 3：实现导出白名单**

导出显式列出允许字段，不使用 `SELECT *` 序列化；包含 agent、渠道非敏感 config、健康摘要、事件和发送审计；排除 `channel_secrets`、原始载荷、临时回复 token 和内部附件路径。

- [ ] **步骤 4：实现可重试清空协议**

本计划先定义 `ChannelShutdownPort.stopAll(scope)`；M3 注入真实管理器。本计划默认实现确认所有连接均 disabled。物理删除成功后同一事务删除业务数据和 agents；失败返回 `personal_data_clear_failed` 并保留定位数据。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/personal-data.test.ts tests/unit/admin-data-clear-route.test.ts`

预期：PASS；导出与日志扫描无 secret；失败路径可重复执行。

```bash
git add src/server/admin/personal-data.ts src/app/api/admin/data tests/unit/personal-data.test.ts tests/unit/admin-data-clear-route.test.ts
git commit -m "fix(P0-8): 扩展分身数据导出与安全清空"
```

**回滚：** 保留更严格导出白名单；若回滚连接停止 port，必须同时禁用清空入口，不能恢复不安全顺序。

**完成证据：** 导出白名单、secret 扫描、物理删除失败和连接停止失败测试。

### 任务 9：M2 总验证

**文件：**
- 创建：`docs/verification/qwenpaw-console-m2.md`
- 修改：本计划列出的测试夹具。

- [ ] **步骤 1：运行目标和全量测试**

```bash
npm test -- --run tests/unit/agent-scope.test.ts tests/unit/admin-compat-router.test.ts tests/unit/admin-compat-agents.test.ts tests/unit/admin-compat-channels.test.ts tests/unit/encrypted-secret.test.ts tests/integration/agent-scope-migration.test.ts tests/integration/admin-audit.test.ts
npm run console:test
npm run typecheck
npm test
npm run build
git diff --check
```

预期：全部 PASS。

- [ ] **步骤 2：运行数据库隔离审计**

运行：`rg -n "WHERE (id|conversation_id|goal_id|message_id) = \\$1" src/server/db src/server/agents`

预期：所有命中均经父查询验证 `AgentScope`，或同一 SQL 同时限定 `user_id` 和 `agent_id`；逐项在 code review 记录结论。

- [ ] **步骤 3：运行 secret 与多分身禁用扫描**

运行：`rg -n "APP_SECRET.*encrypt|decrypt.*APP_SECRET|filter_thinking.*false|filter_tool_messages.*false" src patches/qwenpaw-console`

预期：无命中。Agents API 的 create/clone/import/delete 测试全部返回 `501 capability_disabled`。

- [ ] **步骤 4：里程碑提交**

```bash
git add docs/verification/qwenpaw-console-m2.md
git commit -m "chore(P0-8): 完成数字分身与兼容层 M2 验收"
```

**回滚：** Console 继续停留 `/admin-preview`；数据库增量结构保留；所有渠道连接保持 disabled。

**完成证据：** 迁移、隔离、CSRF、revision、审计、secret、17 schema 和单 Agent Console 报告。
