# Console 全页面领域映射与旧后台收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M5：让固定 QwenPaw Console 的全部页面拥有真实 DigitalMate 数据或准确禁用状态，新增 Interjections、Goals、Memory、Reflections，同步收口旧后台但保留可回退入口。

**架构：** 32 个上游 API 模块进入一份机器可检验的合同 manifest；活跃模块调用专注领域 view/service，冻结模块返回稳定 `501 capability_disabled`，Chat 只重定向首页。Console 独有页面通过 `0004-api-compat.patch` 增加到原 route/menu registry，业务规则全部留在服务端。

**技术栈：** QwenPaw Console React 18/Ant Design、Next.js 16、TypeScript、PostgreSQL、fflate、Vitest、Testing Library、Playwright。

---

## 文件结构

**创建：**

- `src/server/admin/compat/upstream-contract.ts`：32 个模块、端点能力与状态清单。
- `src/server/admin/compat/handlers/inbox.ts`：审批、访问请求、Skill/工具/插件确认。
- `src/server/admin/compat/handlers/sessions.ts`：会话、消息、工具留痕和执行步骤。
- `src/server/admin/compat/handlers/schedules.ts`：Cron、Heartbeat、提醒、定时摘要和授权来源。
- `src/server/admin/compat/handlers/evolution.ts`：Memory、Reflections、Interjections、Goals。
- `src/server/admin/compat/handlers/workspace.ts`：数据库投影的虚拟 Workspace。
- `src/server/admin/compat/handlers/agent-resources.ts`：Skills、Tools、MCP、ACP、Config、Commands。
- `src/server/admin/compat/handlers/models.ts`：Models、providers、本地模型禁用、模型用途路由。
- `src/server/admin/compat/handlers/operations.ts`：Stats、Token Usage、Environments、Security、Debug、Voice。
- `src/server/admin/compat/handlers/backups.ts`：备份任务、导出、恢复和清理。
- `src/server/admin/compat/handlers/plugins.ts`：Skill Pool、Plugin Manager、Market 的确认/禁用状态。
- `src/server/admin/views/{inbox,sessions,schedules,evolution,stats,security}.ts`：只读投影视图。
- `src/server/admin/workspace/{files,service}.ts`：虚拟文件目录、读取和受控写回。
- `src/server/admin/backups/{types,repository,service,archive}.ts`：私有备份领域服务。
- `src/app/admin/[[...path]]/route.ts`：由 feature flag 提供新 Console 或跳 legacy。
- `tests/unit/admin-compat-{manifest,inbox,sessions,schedules,evolution,workspace,resources,models,operations,backups,plugins}.test.ts`
- `tests/unit/admin-workspace.test.ts`、`admin-backups.test.ts`
- `tests/e2e/admin-console-pages.spec.ts`：30 路由、交互、错误、禁用和三视口。
- `tests/e2e/admin-console.visual.spec.ts`：结构截图与允许差异遮罩。
- `docs/verification/console-pages-m5.md`：页面/API/状态覆盖报告。

**修改：**

- `src/server/admin/compat/register-core.ts`：注册所有映射。
- `src/server/db/schema.sql`：备份任务、审批统一视图所需状态和索引。
- `src/server/db/repositories.ts`：组合 admin view/backup repositories。
- `patches/qwenpaw-console/0004-api-compat.patch`：新增四页面、路由、菜单、错误/禁用呈现和 API 状态。
- `src/app/admin/**`：机械移动到 `src/app/admin-legacy/**`，修复内部链接。
- `src/components/admin/admin-nav.tsx`：改为 legacy 自身导航并加返回新 Console。
- `src/app/page.tsx` 或首页导航组件：后台链接仍为 `/admin`。
- `src/server/config/env.ts`、`.env.example`、`docker-compose.yml`：`ADMIN_CONSOLE_ENABLED`、备份私有目录、保留期和独立 `BACKUP_ENCRYPTION_KEY`。
- `package.json`、`package-lock.json`：把 `fflate` 固定为 runtime dependency。
- `next.config.ts`：新 `/admin` 静态资源缓存与 legacy no-store。

### 任务 1：建立 32 模块与端点能力 manifest

**文件：**
- 创建：`src/server/admin/compat/upstream-contract.ts`
- 创建：`tests/unit/admin-compat-manifest.test.ts`
- 修改：`src/server/admin/compat/router.ts`
- 修改：`src/server/admin/compat/register-core.ts`

- [ ] **步骤 1：编写失败的模块完整性测试**

```ts
const EXPECTED_MODULES = [
  "accessControl", "acp", "agent", "agentStats", "agents", "auth", "backup",
  "channel", "chat", "codingMode", "codingProject", "commands", "console", "cronjob",
  "debug", "env", "git", "heartbeat", "language", "localModel", "market", "mcp",
  "plugin", "pluginMarket", "provider", "root", "security", "skill", "tokenUsage",
  "tools", "userTimezone", "workspace",
] as const;

it("固定版本 32 个 API 模块都有审计状态", () => {
  expect(Object.keys(UPSTREAM_API_CONTRACT).sort()).toEqual([...EXPECTED_MODULES].sort());
  for (const module of EXPECTED_MODULES) {
    expect(UPSTREAM_API_CONTRACT[module].endpoints.length).toBeGreaterThan(0);
  }
});

it("固定快照包含 32 个 API 源模块和 31 个配套测试", async () => {
  const sources = await globVendorConsole("src/api/modules/*.ts", { ignore: "**/*.test.ts" });
  const tests = await globVendorConsole("src/api/modules/*.test.ts");
  expect(sources).toHaveLength(32);
  expect(tests).toHaveLength(31);
  expect(sources.length + tests.length).toBe(63);
  expect(findSourcesWithoutSiblingTest(sources, tests)).toEqual(["pluginMarket.ts"]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-manifest.test.ts`

预期：FAIL，manifest 尚不存在。

- [ ] **步骤 3：定义三种可审计状态**

```ts
export type UpstreamEndpointContract = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  status: "mapped" | "redirected" | "disabled";
  domain: string;
  disabledCode?: string;
};
```

模块归类固定如下：

| 状态 | 模块 |
|---|---|
| mapped | accessControl、agent、agentStats、agents、auth、backup、channel、commands、cronjob、debug、env、heartbeat、language、mcp、provider、root、security、skill、tokenUsage、tools、userTimezone、workspace |
| redirected | chat、console |
| disabled | acp、codingMode、codingProject、git、localModel、market、plugin、pluginMarket |

mapped 模块允许个别写端点 disabled，但必须逐 endpoint 记录；例如 MCP/Tools 读取 mapped，P2 新建/执行 disabled。

- [ ] **步骤 4：让 router 对注册表做启动自检**

启动时比较 manifest 与实际注册：mapped endpoint 必须有 handler；disabled 必须有能力码；redirected 必须有明确 URL。缺失、重复、mapped→501、disabled→200 均使 `npm run build` 失败。

- [ ] **步骤 5：运行 manifest 测试并提交**

运行：`npm test -- --run tests/unit/admin-compat-manifest.test.ts`

预期：PASS，32 模块全部出现；当前尚未注册的 mapped endpoint 会在测试中列出明确路径并推动后续任务。

```bash
git add src/server/admin/compat/upstream-contract.ts src/server/admin/compat/router.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-manifest.test.ts
git commit -m "test(P0-8): 固化 Console 三十二模块兼容清单"
```

**回滚：** manifest 可回滚但不得在发布时缺失；不会改数据。

**完成证据：** 32 模块、全部端点和启动自检报告。

### 任务 2：映射 Inbox、访问控制与 Sessions

**文件：**
- 创建：`src/server/admin/views/inbox.ts`
- 创建：`src/server/admin/views/sessions.ts`
- 创建：`src/server/admin/compat/handlers/inbox.ts`
- 创建：`src/server/admin/compat/handlers/sessions.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-compat-inbox.test.ts`
- 创建：`tests/unit/admin-compat-sessions.test.ts`

- [ ] **步骤 1：编写失败的 Inbox 聚合测试**

```ts
it("Inbox 合并审批且不跨 agent", async () => {
  const inbox = await listInbox(scopeA, { status: "pending", cursor: null, limit: 20 });
  expect(inbox.items.map((item) => item.kind).sort()).toEqual([
    "channel_access", "skill_revision", "tool_registration",
  ]);
  expect(inbox.items.every((item) => item.agent_id === scopeA.agentId)).toBe(true);
});
```

测试 approve/deny/dismiss/remark、旧 revision 409、确认来源审计、密钥不出现在摘要。

- [ ] **步骤 2：编写失败的 Sessions 测试**

```ts
it("Session 详情区分可见消息和内部留痕", async () => {
  const detail = await getSession(scope, conversationId);
  expect(detail.messages).toEqual([userMessage, assistantMessage]);
  expect(detail.internal_steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "tool", visible_to_user: false }),
  ]));
});
```

覆盖分页、channel、agent、工具日志、事件步骤、raw payload/secret/系统提示不返回、删除会话 scope。

- [ ] **步骤 3：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-inbox.test.ts tests/unit/admin-compat-sessions.test.ts`

预期：FAIL，view 与 handler 不存在。

- [ ] **步骤 4：实现 Inbox 和 accessControl API**

统一 item 包含 id/kind/title/summary/status/agent_id/revision/created_at/actions。accessControl 模块的 whitelist/blacklist/remark/pending approve/deny/dismiss/username 映射到 `channel_access_rules/requests`；每次写入同事务 audit 并通知连接 manager。

- [ ] **步骤 5：实现 Sessions API**

列表从 conversations 聚合 message count/last message/channel/updated；详情把 messages 与脱敏 tool logs/execution steps 分区。Console 过滤/分页使用稳定 cursor `(updated_at,id)`，删除走现有 conversation domain service并同时清私有附件。

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-compat-inbox.test.ts tests/unit/admin-compat-sessions.test.ts tests/unit/admin-compat-manifest.test.ts`

预期：PASS。

```bash
git add src/server/admin/views/inbox.ts src/server/admin/views/sessions.ts src/server/admin/compat/handlers/inbox.ts src/server/admin/compat/handlers/sessions.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-inbox.test.ts tests/unit/admin-compat-sessions.test.ts
git commit -m "feat(P0-8): 映射 Console 收件箱与会话"
```

**回滚：** handler 可取消注册；原业务数据不改，审批写入保留审计。

**完成证据：** 聚合、分页、approve/deny/revision、跨 agent 和敏感字段排除测试。

### 任务 3：映射 Cron、Heartbeat、Interjections 与 Goals

**文件：**
- 创建：`src/server/admin/views/schedules.ts`
- 创建：`src/server/admin/views/evolution.ts`
- 创建：`src/server/admin/compat/handlers/schedules.ts`
- 创建：`src/server/admin/compat/handlers/evolution.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-compat-schedules.test.ts`
- 创建：`tests/unit/admin-compat-evolution.test.ts`

- [ ] **步骤 1：编写失败的持久授权测试**

```ts
it("没有 authorization type/source ID 的联网 Cron 不能启用", async () => {
  const response = await updateCron(scope, {
    kind: "scheduled_digest", network_enabled: true, authorization: null,
  });
  expect(response).toMatchObject({ status: 400, code: "persistent_authorization_required" });
});

it("Heartbeat 默认关闭且普通记忆不能创建任务", async () => {
  expect((await getHeartbeat(scope)).enabled).toBe(false);
  await ingestOrdinaryMemory("AI 新闻");
  expect(await listBackgroundNetworkTasks(scope)).toEqual([]);
});
```

- [ ] **步骤 2：编写失败的插话与目标测试**

覆盖插话策略/频率/静默/退避/平台不可读非 @ 限制，目标合同/授权来源/budget/status/steps；任何 internal reasoning 只在 debug 留痕，不进 messages。

- [ ] **步骤 3：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-schedules.test.ts tests/unit/admin-compat-evolution.test.ts`

预期：FAIL，handler 尚不存在。

- [ ] **步骤 4：实现 Cron 与 Heartbeat 映射**

Cron 把 reminder/follow_up/scheduled_digest/topic_subscription 投影成上游 job；share 旧占位不允许启用。启用联网任务强制 `{authorizationType,authorizationSourceId}` 且 source 实体存在/启用。Heartbeat config 存 agent_settings，默认 off；只允许明确合同 trigger，禁止读取 memory 自动生成。

- [ ] **步骤 5：实现 Interjections 与 Goals API**

Interjections 提供 policy、decision list、reason、频率统计和下次可插话时间；若 manifest/platform 不支持非 @ 事件返回 `capability_limited`。Goals 映射现有 contract/state/steps/budget/needs human，确认/暂停/恢复均 revision + audit。

- [ ] **步骤 6：运行强制红线与提交**

运行：`npm test -- --run tests/unit/admin-compat-schedules.test.ts tests/unit/admin-compat-evolution.test.ts tests/unit/proactive-delivery.test.ts tests/unit/proactive-share.test.ts tests/unit/interjection.test.ts tests/unit/goal-orchestrator.test.ts`

预期：PASS。

```bash
git add src/server/admin/views/schedules.ts src/server/admin/views/evolution.ts src/server/admin/compat/handlers/schedules.ts src/server/admin/compat/handlers/evolution.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-schedules.test.ts tests/unit/admin-compat-evolution.test.ts
git commit -m "feat(P0-8): 映射调度插话与目标管理"
```

**回滚：** 关闭 Heartbeat/Cron 写入口；已有授权任务保持原状态，不从 UI 删除。

**完成证据：** 授权来源、默认 off、普通记忆 0 后台任务、插话限制和目标状态测试。

### 任务 4：实现虚拟 Workspace、Skills、Tools、MCP 与进化页面

**文件：**
- 创建：`src/server/admin/workspace/files.ts`
- 创建：`src/server/admin/workspace/service.ts`
- 创建：`src/server/admin/compat/handlers/workspace.ts`
- 创建：`src/server/admin/compat/handlers/agent-resources.ts`
- 修改：`src/server/admin/compat/handlers/evolution.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-workspace.test.ts`
- 创建：`tests/unit/admin-compat-resources.test.ts`
- 修改：`tests/unit/admin-compat-evolution.test.ts`

- [ ] **步骤 1：编写失败的虚拟文件安全测试**

```ts
it("Workspace 只暴露受控投影", async () => {
  const files = await workspace.list(scope);
  expect(files.map((file) => file.path)).toEqual([
    "/AGENT.md", "/PROACTIVITY.md", "/CHANNELS.md", "/RUNTIME.json",
  ]);
  expect(JSON.stringify(files)).not.toMatch(/DATABASE_URL|APP_SECRET|storage_key|system prompt/i);
});
```

覆盖 AGENT/PROACTIVITY 可写回、CHANNELS/RUNTIME 只读、path traversal、revision 409、无第二套磁盘真相。

- [ ] **步骤 2：编写失败的资源与进化测试**

Skills/Skill Pool list/detail/version/enable 需要确认；Tools/MCP 读取真实注册，P2 create/execute 501；ACP 全模块 501；Memory list/update/delete 分层；Reflections list/apply/dismiss，应用人设建议需确认和 revision。

- [ ] **步骤 3：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-workspace.test.ts tests/unit/admin-compat-resources.test.ts tests/unit/admin-compat-evolution.test.ts`

预期：FAIL，workspace/resources handler 尚不存在。

- [ ] **步骤 4：实现固定虚拟文件表**

```ts
export const VIRTUAL_FILES = Object.freeze({
  "/AGENT.md": { writable: true, source: "agent_persona" },
  "/PROACTIVITY.md": { writable: true, source: "agent_proactivity" },
  "/CHANNELS.md": { writable: false, source: "channel_summary" },
  "/RUNTIME.json": { writable: false, source: "runtime_summary" },
});
```

download/watch/upload API 映射此投影；上传 zip/任意文件禁用。写回解析严格格式，走 agent settings domain service；不把系统提示全文或凭据投影。

- [ ] **步骤 5：实现资源 mapped/disabled 边界**

Skills 与版本/修订使用现有 repositories，启用/导入/沉淀保留确认。Tools/MCP 列表、状态、权限可读；P2 新建运行环境、执行脚本、动态 MCP 启用返回 501。ACP、git、coding project 全端点准确禁用。commands 从 enabled Skills 生成 slash command catalog。

- [ ] **步骤 6：实现 Memory/Reflections**

Memory 查询严格 scope，返回 kind/content/confidence/source/time，不回传 embedding；update/delete audit。Reflection apply 只把用户明确选择的建议合并 persona，不能自动应用；dismiss 记录状态。

- [ ] **步骤 7：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-workspace.test.ts tests/unit/admin-compat-resources.test.ts tests/unit/admin-compat-evolution.test.ts tests/unit/memory.test.ts tests/unit/reflection-skill.test.ts`

预期：PASS。

```bash
git add src/server/admin/workspace src/server/admin/compat/handlers/workspace.ts src/server/admin/compat/handlers/agent-resources.ts src/server/admin/compat/handlers/evolution.ts src/server/admin/compat/register-core.ts tests/unit/admin-workspace.test.ts tests/unit/admin-compat-resources.test.ts tests/unit/admin-compat-evolution.test.ts
git commit -m "feat(P0-8): 映射虚拟工作区与 Agent 资源"
```

**回滚：** Workspace 可切只读；Memory/Reflection 原数据保留；冻结端点继续禁用。

**完成证据：** 虚拟文件白名单、path/revision、资源确认、P2/ACP 禁用和记忆隐私测试。

### 任务 5：映射 Models、Stats、Usage、Environment、Security、Debug 与 Voice

**文件：**
- 创建：`src/server/admin/views/stats.ts`
- 创建：`src/server/admin/views/security.ts`
- 创建：`src/server/admin/compat/handlers/models.ts`
- 创建：`src/server/admin/compat/handlers/operations.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 创建：`tests/unit/admin-compat-models.test.ts`
- 创建：`tests/unit/admin-compat-operations.test.ts`

- [ ] **步骤 1：编写失败的模型和运维视图测试**

```ts
it("Models 映射用途路由且不返回 API key", async () => {
  const models = await compatJson("GET", "/providers");
  expect(models.routes).toMatchObject({ main: expect.any(String), light: expect.any(String) });
  expect(JSON.stringify(models)).not.toMatch(/api.?key|Bearer /i);
});

it("Debug 只返回脱敏内部留痕", async () => {
  const debug = await compatJson("GET", "/debug/events");
  expect(JSON.stringify(debug)).not.toMatch(/system prompt|ciphertext|nonce|raw_payload|storage_key/i);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-models.test.ts tests/unit/admin-compat-operations.test.ts`

预期：FAIL，handler 尚不存在。

- [ ] **步骤 3：实现 Models/provider/localModel**

provider 列表来自现有 LLM catalog；用途 route main/light 映射用户默认 + agent override，write 用 revision。自定义 model ID 只允许 catalog 支持的 provider shape。localModel 整模块 501，Console 显示当前未启用本地模型，不假造空列表。

- [ ] **步骤 4：实现 Stats/Usage/Environment**

Stats 按 agent 汇总 conversation/message/memory/task/channel/error；Token Usage 按时间、purpose、model聚合并保留用户总览。Environment 只读展示 web/agent/channel-node 版本与健康，不返回 env 值；P2 sandbox environment 写操作 501。

- [ ] **步骤 5：实现 Security/Debug/Voice**

Security 展示 channel access、agent grants、admin audit、证书状态和 tool permissions；secret 只 configured。Debug 展示脱敏事件/step/delivery/connection诊断并有 cursor/保留期。Voice Transcription 聚合 Voice/SIP config 与 health，secret 只状态；修改走 channel revision。

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-compat-models.test.ts tests/unit/admin-compat-operations.test.ts tests/unit/token-usage.test.ts tests/unit/llm-router.test.ts`

预期：PASS。

```bash
git add src/server/admin/views/stats.ts src/server/admin/views/security.ts src/server/admin/compat/handlers/models.ts src/server/admin/compat/handlers/operations.ts src/server/admin/compat/register-core.ts tests/unit/admin-compat-models.test.ts tests/unit/admin-compat-operations.test.ts
git commit -m "feat(P0-8): 映射模型统计与安全运维页面"
```

**回滚：** 运维 handler 可退只读；模型 route 数据不回滚，revision 保留。

**完成证据：** 模型 route、usage 聚合、环境只读、audit/secret redaction、debug retention 和 voice config测试。

### 任务 6：实现自有备份/恢复与插件准确状态

**文件：**
- 创建：`src/server/admin/backups/{types,repository,service,archive}.ts`
- 创建：`src/server/admin/compat/handlers/backups.ts`
- 创建：`src/server/admin/compat/handlers/plugins.ts`
- 修改：`src/server/db/schema.sql`
- 修改：`src/server/admin/compat/register-core.ts`
- 修改：`src/server/config/env.ts`
- 修改：`.env.example`
- 修改：`docker-compose.yml`
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`tests/unit/admin-backups.test.ts`
- 创建：`tests/unit/admin-compat-backups.test.ts`
- 创建：`tests/unit/admin-compat-plugins.test.ts`
- 修改：`tests/unit/env.test.ts`

- [ ] **步骤 1：编写失败的备份隐私与恢复 scope 测试**

```ts
it("灾难恢复包外层加密并保留可恢复的密文与 Matrix 状态", async () => {
  const archive = await backups.create(scope, { encryptionKey: backupKey });
  const raw = await readFile(archive.path);
  expect(raw.toString("utf8")).not.toMatch(/manifest\.json|super-secret|context_token|temporary_url/);
  const restored = await inspectEncryptedArchive(archive.path, backupKey);
  expect(restored.entries).toEqual(expect.arrayContaining([
    "manifest.json", "database/channel_secrets.json", "matrix/connections/connection-a/crypto-store.bin",
  ]));
  expect(restored.text).not.toContain("super-secret");
  await expect(inspectEncryptedArchive(archive.path, wrongBackupKey))
    .rejects.toThrow("backup_authentication_failed");
});

it("恢复到不同 agent 必须显式选择且校验", async () => {
  await expect(backups.restore(scopeB, archiveA, { sourceAgentId: agentA }))
    .rejects.toThrow("backup_agent_mismatch");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-backups.test.ts tests/unit/admin-compat-backups.test.ts tests/unit/admin-compat-plugins.test.ts tests/unit/env.test.ts`

预期：FAIL，backup/plugin handler 尚不存在。

- [ ] **步骤 3：创建备份任务表与私有 archive**

`backup_jobs` 含 user/agent/status/kind/storage_key/checksum/size/error/created/expires；storage path 永不进 API。把 `fflate@0.8.3` 从 dev dependency 移为 exact runtime dependency。完整灾难恢复包先生成 versioned manifest、白名单 JSON 表、私有附件、`channel_secrets` 的既有 AES-GCM 密文行和 Matrix crypto store，再用独立 32-byte base64 `BACKUP_ENCRYPTION_KEY` 做 AES-256-GCM 外层加密；该 key 不得等于或回退复用 `APP_SECRET`、`CHANNEL_SECRETS_KEY`，也绝不写入 archive。包内不含任何 secret 明文、二维码/上下文临时 token、临时 URL、原始供应商 payload 或模型载荷。普通个人数据导出仍完全排除 ciphertext、nonce、auth tag 和 Matrix crypto store。

外层仅暴露无敏感信息的 format version、key version、nonce 和 auth tag；解密 staging 权限为 `0700`、文件为 `0600`，成功或失败都清理。manifest 记录 `CHANNEL_SECRETS_KEY` 的非可逆 key fingerprint，恢复时不匹配则返回 `channel_secret_key_mismatch`，不写入任何数据。

环境解析测试覆盖 key 缺失、不是 32 bytes，以及与 `APP_SECRET`/`CHANNEL_SECRETS_KEY` 相同三种失败；未配置时只把备份能力标记为 blocked，不影响聊天与渠道运行。

- [ ] **步骤 4：实现两阶段恢复**

先用独立备份 key 认证并解密到私有 staging，验证 checksum/schema/user/agent 选择、渠道密钥 fingerprint 和附件 MIME；生成 restore preview（新增/覆盖计数）供用户确认；确认后取得 mutation lock、停止目标 agent 连接、事务恢复业务数据与 `channel_secrets` 密文行、原子移动附件和 Matrix crypto store，失败恢复旧文件索引。默认不能跨 agent；显式选择仍需重新绑定到目标 agent 并记录 audit。恢复后的渠道一律为 disabled，由用户复核前置条件后显式启用。

- [ ] **步骤 5：实现 Plugin/Market 状态**

Skill Pool 映射现有 Skills；Plugin Manager 列出内置渠道/工具/Skill 状态。`plugin`/`pluginMarket`/`market` 的远程安装、上传、启用端点全部 501，并显示“插件扩展需单独确认且当前冻结”；不调用外部 marketplace。

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-backups.test.ts tests/unit/admin-compat-backups.test.ts tests/unit/admin-compat-plugins.test.ts tests/unit/personal-data.test.ts tests/unit/env.test.ts`

预期：PASS。

```bash
git add src/server/admin/backups src/server/admin/compat/handlers/backups.ts src/server/admin/compat/handlers/plugins.ts src/server/db/schema.sql src/server/admin/compat/register-core.ts src/server/config/env.ts .env.example docker-compose.yml tests/unit/admin-backups.test.ts tests/unit/admin-compat-backups.test.ts tests/unit/admin-compat-plugins.test.ts tests/unit/env.test.ts package.json package-lock.json
git commit -m "feat(P0-8): 增加自有备份恢复与插件门控"
```

**回滚：** 禁止创建/恢复新 job；私有 archive 按保留期清理，已完成数据不删除。

**完成证据：** archive 白名单、checksum、preview/confirm、跨 agent、失败回滚和 plugin 501 测试。

### 任务 7：补齐四个 DigitalMate 页面和全部导航状态

**文件：**
- 修改：`patches/qwenpaw-console/0004-api-compat.patch`
- 修改：`tests/e2e/admin-console.routes.ts`
- 创建：`tests/e2e/admin-console-pages.spec.ts`
- 创建：`tests/e2e/admin-console.visual.spec.ts`

- [ ] **步骤 1：扩展失败的 30 路由基线**

```ts
export const DIGITALMATE_ADMIN_ROUTES = [
  ...QWENPAW_BUILTIN_ROUTES,
  "/interjections", "/goals", "/memory", "/reflections",
] as const;

expect(new Set(DIGITALMATE_ADMIN_ROUTES).size).toBe(30);
```

- [ ] **步骤 2：编写失败的独有页面交互测试**

Interjections 测策略保存/revision/平台限制；Goals 测状态筛选/详情/暂停确认；Memory 测 kind筛选/编辑/删除确认；Reflections 测 apply/dismiss/确认。所有页面测 loading/empty/error/disabled 中适用状态。

- [ ] **步骤 3：运行 E2E 验证失败**

运行：`npm run test:e2e:app -- tests/e2e/admin-console-pages.spec.ts`

预期：FAIL，四页面尚未在上游 registry 注册。

- [ ] **步骤 4：在 0004 补丁中增加页面与路由**

四页面复用 QwenPaw 的 PageContainer、Card、Table、Drawer、Form、Pagination、Empty、Result 和 confirm 交互；菜单位置固定：Interjections/Goals 在 Control，Memory/Reflections 在 Agent。禁止复制旧后台 CSS；所有数据经 compat API。

- [ ] **步骤 5：实现准确禁用与第三方许可入口**

Coding 保留页面壳但主操作 disabled 并解释 P2 冻结；ACP/local model/plugin/git 同样显示稳定原因。Settings/Debug 或底部提供 Third-party licenses 链接，展示 QwenPaw Apache-2.0 来源与 commit，但不使用上游品牌作为 DigitalMate 产品名。

- [ ] **步骤 6：运行三视口交互和视觉测试**

运行：`npm run console:test && npm run test:e2e:app -- tests/e2e/admin-console-pages.spec.ts tests/e2e/admin-console.visual.spec.ts --update-snapshots`

运行：`npm run test:e2e:app -- tests/e2e/admin-console-pages.spec.ts tests/e2e/admin-console.visual.spec.ts`

预期：30 路由 × 三视口 PASS；关键几何差异 ≤1px，允许差异仅品牌、珊瑚主题、动态时间/状态遮罩。

- [ ] **步骤 7：提交页面补丁**

```bash
git add patches/qwenpaw-console/0004-api-compat.patch tests/e2e/admin-console.routes.ts tests/e2e/admin-console-pages.spec.ts tests/e2e/admin-console.visual.spec.ts
git commit -m "feat(P0-8): 补齐 DigitalMate Console 独有页面"
```

**回滚：** 还原 0004 补丁可回到上游页面集合；领域 API 保留。

**完成证据：** 30 路由、四独有交互、禁用说明、许可入口和三视口视觉报告。

### 任务 8：迁移旧后台到 `/admin-legacy` 并建立 feature flag

**文件：**
- 移动：`src/app/admin/**` → `src/app/admin-legacy/**`
- 创建：`src/app/admin/[[...path]]/route.ts`
- 修改：`src/components/admin/admin-nav.tsx`
- 修改：所有指向旧后台子路由的本地链接和 redirect。
- 修改：`src/server/config/env.ts`
- 修改：`.env.example`
- 修改：`docker-compose.yml`
- 创建：`tests/unit/admin-console-cutover.test.ts`
- 修改：`tests/unit/admin-nav.test.tsx`

- [ ] **步骤 1：编写失败的切换与回退测试**

```ts
it("flag 关闭时 /admin 跳 legacy，开启时服务 Console", async () => {
  expect((await adminRoute(request("/admin/channels"), { enabled: false })).headers.get("location"))
    .toBe("/admin-legacy/channels");
  expect((await adminRoute(request("/admin/channels"), { enabled: true })).headers.get("content-type"))
    .toContain("text/html");
});
```

覆盖未登录 redirect 保留原 path、legacy 仅管理员登录可访问、首页后台链接始终 `/admin`、Console Chat `/`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-console-cutover.test.ts tests/unit/admin-nav.test.tsx`

预期：FAIL，旧目录仍占 `/admin`。

- [ ] **步骤 3：机械移动旧页面并修复链接**

使用 `git mv src/app/admin src/app/admin-legacy`；旧 nav 的 href 全部以 `/admin-legacy` 开头，并增加“返回新控制台”指向 `/admin`。数据 API 路径不移动。

- [ ] **步骤 4：实现 flag route**

`ADMIN_CONSOLE_ENABLED` 默认 false；false 时 `/admin` 的任意子路径原样保留后缀并 307 到 `/admin-legacy`（例如 `/admin/channels` → `/admin-legacy/channels`），true 时复用 `console-static` 返回 index。`/admin-preview` 始终新 Console；`/admin-legacy` 始终旧后台直到 M6 稳定期结束。

- [ ] **步骤 5：运行路由与全导航测试**

运行：`npm test -- --run tests/unit/admin-console-cutover.test.ts tests/unit/admin-nav.test.tsx && npm run test:e2e:app -- tests/e2e/admin-console-pages.spec.ts`

预期：PASS；默认部署仍进 legacy；preview 完整工作。

- [ ] **步骤 6：提交旧后台收口**

```bash
git add src/app/admin src/app/admin-legacy src/components/admin/admin-nav.tsx src/server/config/env.ts .env.example docker-compose.yml tests/unit/admin-console-cutover.test.ts tests/unit/admin-nav.test.tsx
git commit -m "refactor(P0-8): 保留旧后台回退并准备 Console 切换"
```

**回滚：** flag 设 false；若代码回滚，数据库与兼容 API可保留。

**完成证据：** false/true、preview、legacy、登录 redirect 和首页 Chat 测试。

### 任务 9：M5 全模块与全页面审计

**文件：**
- 创建：`docs/verification/console-pages-m5.md`
- 修改：`tests/unit/admin-compat-manifest.test.ts`

- [ ] **步骤 1：运行 32 模块合同**

```bash
npm test -- --run tests/unit/admin-compat-manifest.test.ts tests/unit/admin-compat-router.test.ts tests/unit/admin-compat-agents.test.ts tests/unit/admin-compat-channels.test.ts tests/unit/admin-compat-inbox.test.ts tests/unit/admin-compat-sessions.test.ts tests/unit/admin-compat-schedules.test.ts tests/unit/admin-compat-evolution.test.ts tests/unit/admin-compat-resources.test.ts tests/unit/admin-compat-models.test.ts tests/unit/admin-compat-operations.test.ts tests/unit/admin-compat-backups.test.ts tests/unit/admin-compat-plugins.test.ts
```

预期：PASS；mapped endpoint 0 个 501/假空数据，disabled endpoint 0 个 2xx，redirected endpoint 只返回首页行为。

- [ ] **步骤 2：运行 Console 和三视口 E2E**

```bash
npm run console:verify-upstream
npm run console:test
npm run console:build
npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts tests/e2e/admin-console-pages.spec.ts tests/e2e/admin-console.visual.spec.ts
```

预期：PASS。

- [ ] **步骤 3：写入覆盖报告**

`docs/verification/console-pages-m5.md` 列出 32 模块 × endpoint 状态、30 路由 × UI 状态、四独有页面、旧后台 path、许可入口、mapped/disabled/redirected 总数和测试证据。

- [ ] **步骤 4：运行全仓验证与假成功扫描**

```bash
npm run typecheck
npm test
npm run build
rg -n "return \[\]|return \{\}|success: true" src/server/admin/compat
git diff --check
```

预期：前三项 PASS；扫描命中逐项由测试证明是合法空状态，不得用于替代未实现能力。

- [ ] **步骤 5：里程碑提交**

```bash
git add docs/verification/console-pages-m5.md tests/unit/admin-compat-manifest.test.ts
git commit -m "chore(P0-8): 完成 Console 全页面 M5 验收"
```

**回滚：** `ADMIN_CONSOLE_ENABLED=false` 保持 legacy；不回滚 M2–M4 数据。

**完成证据：** 32 模块合同、30 路由、三视口、独有页面、许可和 legacy 回退报告。
