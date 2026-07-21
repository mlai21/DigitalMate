# Console 与十七渠道发布验收实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M6：用可复现构建、全量合同、三视口视觉、迁移/备份/恢复/清空、安全、真实平台和回滚证据证明交付，并只在全部硬门槛通过后把 `/admin` 正式切到新 Console。

**架构：** 发布脚本只编排已有验证并生成机器可读 manifest，不修改业务结果；每个门槛都有测试报告或演练记录。正式入口由 `ADMIN_CONSOLE_ENABLED` 切换，旧后台和增量数据库结构保留；单渠道、节点和新 Console 均可独立回退。

**技术栈：** Node.js、npm clean install、Git worktree、Vitest、Playwright、Docker Compose、PostgreSQL、Caddy、SHA-256、CycloneDX npm SBOM。

---

## 文件结构

**创建：**

- `scripts/release/qwenpaw-readiness.mjs`：运行门槛、解析报告并输出非零退出码。
- `scripts/release/collect-evidence.mjs`：生成不含 secret 的 `release-manifest.json`。
- `scripts/release/check-contract-coverage.mjs`：核对 M0–M5 报告、32 API 模块、30 路由、17 Adapter。
- `tests/unit/release-readiness.test.ts`：缺证据、失败命令、外部 pending 和全通过状态。
- `tests/e2e/admin-console-cutover.spec.ts`：正式 `/admin`、legacy、首页 Chat 与回退。
- `docs/verification/release-m6.md`：最终人工可读发布报告。
- `docs/verification/release-manifest.json`：版本、commit、哈希、测试、渠道状态和回滚演练。
- `docs/channels/smoke-matrix.md`：17 渠道真实平台八步签字矩阵。
- `docs/security/qwenpaw-console-channel-review.md`：威胁、依赖、secret、网络和节点安全评审。
- `THIRD_PARTY_NOTICES.md`：QwenPaw 与新增 runtime 依赖许可清单。
- `docs/operations/admin-console-rollback.md`：Console、单渠道、节点和数据恢复操作。
- `docs/operations/channel-node-certificate.md`：签发、轮换、吊销和事故处理。

**修改：**

- `package.json`、`package-lock.json`：增加 `verify:qwenpaw-release`。
- `src/server/config/env.ts`、`.env.example`、`docker-compose.yml`：M6 后默认启用新 Console，仍允许 false 回退。
- `tests/unit/docker-config.test.ts`：新端口、flag、secret key 和不暴露数据库断言。
- `README.md`、`docs/env.md`：安装、17 渠道状态语义、节点和回退。
- `docs/prd.md`：只在证据满足后更新实现状态，不改变已批准范围。
- `docs/verification/qwenpaw-channel-parity.md`：作为固定上游到 17 个 Adapter 的发布输入，不在 M6 临时补证据。

### 任务 1：实现机器可判定的发布门槛

**文件：**
- 创建：`scripts/release/qwenpaw-readiness.mjs`
- 创建：`scripts/release/check-contract-coverage.mjs`
- 创建：`tests/unit/release-readiness.test.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的 gate 测试**

```ts
it("任何硬门槛失败都会阻止 ready", async () => {
  const result = await evaluateReadiness({
    checks: [passed("typecheck"), failed("channel-contracts", 1)],
    channels: seventeen("automated_verified"),
  });
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain("channel-contracts");
});

it("pending_external 不伪装 smoke_verified", async () => {
  const result = await evaluateReadiness({ checks: allPassed, channels: seventeen("pending_external") });
  expect(result.channels.every((item) => item.codeComplete)).toBe(true);
  expect(result.channels.every((item) => item.liveVerified)).toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/release-readiness.test.ts`

预期：FAIL，release scripts 尚不存在。

- [ ] **步骤 3：定义硬门槛类型**

```ts
export const REQUIRED_CHECKS = Object.freeze([
  "upstream-verify", "upstream-tests", "console-build", "typecheck", "unit-tests",
  "integration-tests", "channel-contracts", "console-e2e", "visual-regression",
  "migration-rehearsal", "backup-restore", "clear-data", "security-review", "rollback-rehearsal",
]);

export type ChannelReleaseState = "automated_verified" | "pending_external" | "smoke_verified";
```

`ready` 要求所有 REQUIRED_CHECKS pass、17 个渠道 `codeComplete=true`、manifest/registry/smoke matrix 类型集合相等；`pending_external` 允许发布代码但 Console 必须 blocked/pending_external，不能计入 liveVerified。

- [ ] **步骤 4：实现 exact coverage 检查**

脚本导入 `UPSTREAM_API_CONTRACT`、Console route list、manifest catalog、Adapter registry，断言 32/30/17；先运行 `node scripts/qwenpaw-console/audit-channel-parity.mjs --require-all`，并断言 parity 账本、固定上游目录、manifest、registry 和 smoke matrix 的渠道集合完全相等。读取 M0–M5 验证文档存在并且 commit 不早于相关代码 commit。缺文件、重复渠道、hash 漂移、mapped endpoint 501、路由缺状态截图都退出 1。

- [ ] **步骤 5：增加根命令并运行测试**

`package.json` 增加：

```json
{
  "verify:qwenpaw-release": "node scripts/release/qwenpaw-readiness.mjs"
}
```

运行：`npm test -- --run tests/unit/release-readiness.test.ts`

预期：PASS。

- [ ] **步骤 6：提交 gate**

```bash
git add scripts/release/qwenpaw-readiness.mjs scripts/release/check-contract-coverage.mjs tests/unit/release-readiness.test.ts package.json package-lock.json
git commit -m "test(P0-8/P1-13): 建立 Console 渠道发布门槛"
```

**回滚：** gate 可删除但不得在没有等价门槛时发布；不改运行时。

**完成证据：** 缺证据、失败命令、集合不等、pending external 和全通过五类测试。

### 任务 2：验证全新检出可复现构建与许可

**文件：**
- 创建：`scripts/release/collect-evidence.mjs`
- 创建：`THIRD_PARTY_NOTICES.md`
- 创建：`docs/security/qwenpaw-console-channel-review.md`
- 修改：`tests/unit/release-readiness.test.ts`

- [ ] **步骤 1：编写失败的 manifest 脱敏测试**

```ts
it("release manifest 只含版本、哈希和状态", async () => {
  const manifest = await collectEvidence(fixtureReports);
  const text = JSON.stringify(manifest);
  expect(text).not.toMatch(/token|secret|password|nonce|auth_tag|storage_key|context_token/i);
  expect(manifest.upstream.commit).toBe("fef7e64d984f4332d0b84a343cd209bd3ea5d316");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/release-readiness.test.ts`

预期：FAIL，collector 尚不存在。

- [ ] **步骤 3：实现证据 collector**

输出字段固定为 appCommit、builtAt、node/npm version、upstream tag/commit/checksum、patch hashes、route/API/channel counts、test report hashes、SBOM hash、migration/backup/security/rollback 状态和 17 渠道状态。collector 遇到键名匹配 secret/token/password/nonce/authTag/storageKey/contextToken 直接失败。

- [ ] **步骤 4：在全新临时 worktree 验证**

运行：

```bash
verification_dir="$(mktemp -d)"
git worktree add --detach "$verification_dir/repo" HEAD
npm --prefix "$verification_dir/repo" ci
npm --prefix "$verification_dir/repo" run console:verify-upstream
npm --prefix "$verification_dir/repo" run console:test
npm --prefix "$verification_dir/repo" run build
git worktree remove "$verification_dir/repo"
rmdir "$verification_dir"
```

预期：全部退出 0；vendor checksum 与当前工作区一致；生成产物不依赖未提交文件。

- [ ] **步骤 5：生成 SBOM 与第三方许可**

运行：`npm sbom --sbom-format cyclonedx > /tmp/digitalmate-qwenpaw-sbom.json`

`THIRD_PARTY_NOTICES.md` 至少列 QwenPaw Apache-2.0、React/Vite/Ant Design 上游快照依赖、ws、Discord.js、Slack Bolt、飞书 SDK、钉钉 SDK、MQTT.js、matrix-js-sdk、WeCom SDK、protobufjs、Twilio、LiveKit。记录包名、锁定版本、许可证、来源，不复制冗长许可证正文；QwenPaw LICENSE 单独保留原文。

- [ ] **步骤 6：运行 collector 测试并提交**

运行：`npm test -- --run tests/unit/release-readiness.test.ts && npm run console:verify-upstream`

预期：PASS。

```bash
git add scripts/release/collect-evidence.mjs tests/unit/release-readiness.test.ts THIRD_PARTY_NOTICES.md docs/security/qwenpaw-console-channel-review.md
git commit -m "chore(P0-8): 固化可复现构建与第三方许可"
```

**回滚：** 不影响运行时；许可证文件应随使用的依赖保留，不能因代码回滚误删仍在分发的许可。

**完成证据：** clean worktree 输出、checksum、SBOM hash、third-party notices 和 manifest 脱敏测试。

### 任务 3：演练旧数据迁移与跨分身隔离

**文件：**
- 修改：`tests/integration/agent-scope-migration.test.ts`
- 创建：`tests/integration/release-migration-rehearsal.test.ts`
- 修改：`scripts/release/qwenpaw-readiness.mjs`

- [ ] **步骤 1：编写失败的完整旧数据 fixture**

fixture 覆盖旧 schema 中 user/settings/projects/conversations/messages/attachments/summaries/memory/tool logs/proactive/channel identity/message/interjection/reflection/skills/usage/tasks/artifacts/llm usage/memory jobs/goals/steps，插入可验证行数和关联。

```ts
it("旧数据库执行新 schema 两次后数据不丢失且全部归默认 agent", async () => {
  await loadLegacyFixture(pool);
  await migrateTwice(pool);
  expect(await countBusinessRows(pool)).toEqual(LEGACY_EXPECTED_COUNTS);
  expect(await countNullAgentIds(pool)).toBe(0);
  expect(await countCrossAgentReferences(pool)).toBe(0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/integration/release-migration-rehearsal.test.ts`

预期：若 M2 有遗漏则 FAIL 并指出表名；不得通过删除 fixture 行修复。

- [ ] **步骤 3：补齐迁移和约束**

只修改 `schema.sql` 的增量顺序：默认 agent insert → parent agent_id backfill → child backfill → FK/NOT NULL → 新唯一索引 → 旧索引保留到稳定期。对任何孤儿行抛清晰错误并停止 migration，不静默删除。

- [ ] **步骤 4：加入跨分身故障注入**

测试手工创建第二个 disabled agent，仅用于隔离验证；分别创建会话/记忆/事件/Delivery/goal，使用另一个 scope 的 repository/API 读取必须 404 或空；测试结束回滚事务，不改变“本期只能创建默认分身”的产品 API。

- [ ] **步骤 5：运行迁移套件并提交**

运行：`npm test -- --run tests/integration/agent-scope-migration.test.ts tests/integration/release-migration-rehearsal.test.ts`

预期：PASS；两次迁移行数相同。

```bash
git add src/server/db/schema.sql tests/integration/agent-scope-migration.test.ts tests/integration/release-migration-rehearsal.test.ts scripts/release/qwenpaw-readiness.mjs
git commit -m "test(P0-8): 完成旧数据与分身隔离迁移演练"
```

**回滚：** 数据库不降级；应用可回滚，新增列/表保留。

**完成证据：** 全表行数、双次迁移、零 NULL、零跨 agent 引用和孤儿失败测试。

### 任务 4：演练备份、恢复、清空和物理文件失败

**文件：**
- 修改：`tests/unit/admin-backups.test.ts`
- 修改：`tests/unit/admin-data-clear-route.test.ts`
- 创建：`tests/integration/release-data-lifecycle.test.ts`
- 修改：`src/server/admin/backups/service.ts`
- 修改：`src/server/admin/backups/archive.ts`
- 修改：`src/app/api/admin/data/clear/route.ts`
- 修改：`scripts/release/qwenpaw-readiness.mjs`

- [ ] **步骤 1：编写失败的完整数据生命周期测试**

```ts
it("备份→清空→恢复保持业务数据和附件哈希", async () => {
  const before = await snapshotUserData(scope);
  const backup = await createBackup(scope, { encryptionKey: backupKey });
  await clearPersonalData(scope);
  expect(await countUserRows(userId)).toBe(0);
  await restoreBackup(scope, backup, { confirmed: true, encryptionKey: backupKey });
  expect(await snapshotUserData(scope)).toEqual(before);
});
```

覆盖连接先停止、节点解绑、secret 撤销、附件/Matrix store/artifact/backup archive；普通个人数据导出不含任何渠道密钥材料或 Matrix store，外层加密的完整灾难恢复包则恢复原有 `channel_secrets` 密文行和 Matrix crypto store，但任何位置都不出现 secret 明文。物理删除第 N 个文件失败时数据库定位仍在，重试成功。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/integration/release-data-lifecycle.test.ts`

预期：若任何资源未纳入生命周期则 FAIL 并列资源类型。

- [ ] **步骤 3：补齐生命周期端口与事务**

停止顺序固定：disable/stop connections → revoke node sessions/QR sessions → 删除外部临时凭据 → 删除私有物理文件 → DB transaction。恢复先验证所有 archive entry，再写任何数据；文件移动和 DB commit 失败执行补偿并保留 staging 诊断 ID。

- [ ] **步骤 4：运行生命周期与隐私扫描**

运行：`npm test -- --run tests/unit/admin-backups.test.ts tests/unit/admin-data-clear-route.test.ts tests/integration/release-data-lifecycle.test.ts tests/unit/personal-data.test.ts`

预期：PASS；恢复后业务、附件、渠道 secret 密文和 Matrix store 哈希一致；失败路径可重试；个人导出无密钥材料，灾难恢复包原始字节无 secret 明文且错备份 key 无法认证。

- [ ] **步骤 5：提交演练**

```bash
git add src/server/admin/backups/service.ts src/server/admin/backups/archive.ts src/app/api/admin/data/clear/route.ts tests/unit/admin-backups.test.ts tests/unit/admin-data-clear-route.test.ts tests/integration/release-data-lifecycle.test.ts scripts/release/qwenpaw-readiness.mjs
git commit -m "test(P0-8): 完成数据备份恢复与清空演练"
```

**回滚：** 暂停恢复/清空入口，不删除可重试诊断；备份仍可下载。

**完成证据：** 完整 round trip、文件哈希、停止顺序、物理失败和 secret 排除测试。

### 任务 5：完成安全评审与攻击面测试

**文件：**
- 修改：`docs/security/qwenpaw-console-channel-review.md`
- 修改：`tests/unit/admin-compat-router.test.ts`
- 修改：`tests/unit/encrypted-secret.test.ts`
- 修改：`tests/unit/channels/gateway/router.test.ts`
- 修改：`tests/unit/channels/gateway/node-server.test.ts`
- 修改：`tests/unit/channels/gateway/tls.test.ts`
- 修改：`scripts/release/qwenpaw-readiness.mjs`

- [ ] **步骤 1：增加攻击用例**

测试 CSRF/Origin 绕过、session fixation、path traversal、agent ID 越权、revision lost update、secret 回显、二维码 token 猜测/重放、webhook signature、WS origin/token、mTLS 错 CA/吊销/绑定、OneBot flood、Twilio replay、附件 SSRF/redirect/private IP、压缩炸弹和日志注入。

```ts
it("渠道附件下载拒绝私网和重定向到私网", async () => {
  await expect(fetchInboundAttachment("http://127.0.0.1/secret")).rejects.toThrow("attachment_source_forbidden");
  await expect(fetchInboundAttachment(publicUrlRedirectingToPrivate)).rejects.toThrow("attachment_source_forbidden");
});
```

- [ ] **步骤 2：运行安全测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts tests/unit/encrypted-secret.test.ts tests/unit/channels/gateway tests/unit/attachment-validation.test.ts`

预期：发现的缺口直接修复；不把攻击测试标 skip。

- [ ] **步骤 3：运行依赖和 secret 扫描**

```bash
npm audit --omit=dev
git grep -nE '(xox[baprs]-|sk-[A-Za-z0-9]|BEGIN (RSA |EC )?PRIVATE KEY|twilio_auth_token[=:].+|app_secret[=:].+)' -- ':!package-lock.json' ':!tests/fixtures'
```

预期：audit 无 high/critical 未处置项；git grep 无真实凭据。测试 fixture 使用明显假值且单独说明。

- [ ] **步骤 4：完成安全文档**

文档逐项记录资产、信任边界、攻击面、控制、测试和残余风险；特别记录 QwenPaw vendor 补丁、17 平台网络、加密 key 轮换、节点证书、iMessage FDA、OneBot 风控、Voice/SIP 音频和附件 SSRF。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-compat-router.test.ts tests/unit/encrypted-secret.test.ts tests/unit/channels/gateway tests/unit/attachment-validation.test.ts`

预期：PASS。

```bash
git add docs/security/qwenpaw-console-channel-review.md tests/unit/admin-compat-router.test.ts tests/unit/encrypted-secret.test.ts tests/unit/channels/gateway/router.test.ts tests/unit/channels/gateway/node-server.test.ts tests/unit/channels/gateway/tls.test.ts tests/unit/attachment-validation.test.ts scripts/release/qwenpaw-readiness.mjs
git commit -m "security(P0-8/P1-13): 完成 Console 渠道安全评审"
```

**回滚：** 安全加固不回滚；若依赖事故无法修复，disable 受影响 Adapter并阻止发布。

**完成证据：** 攻击测试、audit、secret scan 和安全评审签字。

### 任务 6：执行 17 渠道真实平台 smoke 矩阵

**文件：**
- 创建：`docs/channels/smoke-matrix.md`
- 修改：`docs/verification/channels-standard-m4a.md`
- 修改：`docs/verification/channels-protocol-m4b.md`
- 修改：`docs/verification/channels-edge-m4c.md`
- 修改：`scripts/release/qwenpaw-readiness.mjs`

- [ ] **步骤 1：创建固定八步矩阵**

每个渠道固定检查：连接/健康、接收、回复、重复事件、断线重连、权限拒绝、主动发送、停用。矩阵每格只能是 `pass`、`fail`、`pending_external`，并记录执行日期、平台环境、脱敏证据 ID 和执行人。

- [ ] **步骤 2：自动导入已完成合同状态**

脚本读取 17 个 Adapter test report，把 code/contract 标 `automated_verified`；它不能自动写 live smoke 为 pass。真实凭据不写文档或测试 fixture。

- [ ] **步骤 3：对用户已提供条件的渠道执行八步 smoke**

每个平台通过 Console 创建/启用单独 connection；发送由脚本生成的唯一文本（格式示例：`smoke-telegram-20260721-0001`），重复投递使用平台允许的回放方法，验证 messages/Delivery 唯一；断线后重连；测试拒绝名单；创建带持久来源的主动发送；最后 disable。

- [ ] **步骤 4：准确记录缺失条件**

未提供账号/凭据/资格/运行环境时写 `pending_external` 和精确 prerequisite：iMessage macOS/FDA/imsg，微信内测，OneBot companion/风控，Twilio 账号/号码/公网，SIP PBX/Trunk或LiveKit/UDP，其余平台凭据/权限/网络。Console 必须显示相同状态。

- [ ] **步骤 5：运行矩阵一致性检查并提交**

运行：`node scripts/release/check-contract-coverage.mjs`

预期：17 行、每行 8 项；代码完成全部 true；live 状态与 Console health 完全一致。

```bash
git add docs/channels/smoke-matrix.md docs/verification/channels-standard-m4a.md docs/verification/channels-protocol-m4b.md docs/verification/channels-edge-m4c.md scripts/release/qwenpaw-readiness.mjs
git commit -m "test(P1-13): 记录十七渠道真实平台验收"
```

**回滚：** smoke 后保持连接 disabled，除非用户明确要求上线；删除测试消息按平台能力执行，不删中心审计。

**完成证据：** 17×8 矩阵、平台证据 ID和 pending_external prerequisite。

### 任务 7：演练 Console、单渠道与节点回滚

**文件：**
- 创建：`docs/operations/admin-console-rollback.md`
- 创建：`docs/operations/channel-node-certificate.md`
- 创建：`tests/e2e/admin-console-cutover.spec.ts`
- 修改：`tests/unit/admin-console-cutover.test.ts`
- 修改：`scripts/release/qwenpaw-readiness.mjs`

- [ ] **步骤 1：编写失败的正式入口与回退 E2E**

```ts
test("新 Console 与 legacy 可在不改数据时切换", async ({ page }) => {
  await setConsoleFlag(true);
  await page.goto("/admin/channels");
  await expect(page.getByText("Channels")).toBeVisible();
  await setConsoleFlag(false);
  await page.reload();
  await expect(page).toHaveURL(/\/admin-legacy\/channels/);
  expect(await countBusinessRows()).toEqual(beforeCounts);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test:e2e:app -- tests/e2e/admin-console-cutover.spec.ts`

预期：测试环境 flag 控制或数据计数尚未完成时 FAIL。

- [ ] **步骤 3：完成四类回滚文档和测试端口**

文档给出：`ADMIN_CONSOLE_ENABLED=false` + 只重启 web；单 connection disable + manager stop；节点 cert revoke + socket close；备份恢复 preview/confirm。每个操作列验证查询和“不会删除什么”。E2E 通过测试配置注入 flag，不暴露生产管理端点。

- [ ] **步骤 4：演练单渠道和节点回滚**

在 fixture 环境让一个 Adapter 持续 500、另一个正常；disable 故障连接后正常连接继续收发，Web chat 正常。revoke node A 后只关闭 A，node B 继续；waiting_node Delivery 不丢失。

- [ ] **步骤 5：运行回滚测试并提交**

运行：`npm run test:e2e:app -- tests/e2e/admin-console-cutover.spec.ts && npm test -- --run tests/unit/admin-console-cutover.test.ts tests/unit/channels/connection-manager.test.ts tests/unit/channels/gateway/node-server.test.ts`

预期：PASS。

```bash
git add docs/operations/admin-console-rollback.md docs/operations/channel-node-certificate.md tests/e2e/admin-console-cutover.spec.ts tests/unit/admin-console-cutover.test.ts scripts/release/qwenpaw-readiness.mjs
git commit -m "test(P0-8/P1-13): 完成 Console 渠道回滚演练"
```

**回滚：** 文档本身保留；feature flag false 是正式紧急回退手段。

**完成证据：** Console 数据不变、单渠道隔离、节点隔离和 queued Delivery 保留测试。

### 任务 8：正式切换 `/admin` 并完成最终报告

**文件：**
- 修改：`src/server/config/env.ts`
- 修改：`.env.example`
- 修改：`docker-compose.yml`
- 修改：`tests/unit/docker-config.test.ts`
- 修改：`README.md`
- 修改：`docs/env.md`
- 修改：`docs/prd.md`
- 创建：`docs/verification/release-m6.md`
- 创建：`docs/verification/release-manifest.json`

- [ ] **步骤 1：在切换前运行完整 gate**

```bash
npm run console:verify-upstream
npm run console:test
npm run console:build
npm run typecheck
npm test
npm run test:e2e
npm run channel-node:build
npm run build
npm run verify:qwenpaw-release
git diff --check
```

预期：全部退出 0；readiness 输出 `ready: true`。若任何检查失败，保持 `ADMIN_CONSOLE_ENABLED=false`。

- [ ] **步骤 2：切换默认 flag**

`readEnv` 的 `ADMIN_CONSOLE_ENABLED` 默认仍在代码中使用明确布尔解析；M6 将 `.env.example` 与 `docker-compose.yml` 默认值设为 `true`。生产现有环境必须显式设置 true 才切换，避免镜像更新隐式改变入口。`/admin-legacy` 和 false 分支继续保留。

- [ ] **步骤 3：运行正式入口三视口测试**

运行：`ADMIN_CONSOLE_ENABLED=true npm run test:e2e:app -- tests/e2e/admin-console-cutover.spec.ts tests/e2e/admin-console-pages.spec.ts tests/e2e/admin-console.visual.spec.ts`

预期：PASS；`/admin` 默认 Inbox；Chat 跳 `/`；30 路由刷新；legacy 仍可访问。

- [ ] **步骤 4：生成最终机器和人工报告**

运行：`node scripts/release/collect-evidence.mjs > docs/verification/release-manifest.json`

`release-m6.md` 引用 manifest hash，逐项写 M0–M6、32 模块、30 路由、17 渠道、外部 pending、迁移、备份恢复、清空、安全、许可和回滚结论。只有直接证据支持的能力标“完成”。

- [ ] **步骤 5：更新 README/env/PRD 实现状态**

README 明确 Console 基线、首页聊天、17 渠道状态三态、单默认分身和 P2 冻结；env 文档分别列 `CHANNEL_SECRETS_KEY`、`BACKUP_ENCRYPTION_KEY`、gateway/node/flag，并声明两个 32-byte key 及 `APP_SECRET` 必须互不相同；PRD 只更新实现状态和证据链接，不改变功能编号或红线。

- [ ] **步骤 6：运行最终验证**

```bash
npm test -- --run tests/unit/docker-config.test.ts tests/unit/release-readiness.test.ts tests/unit/admin-console-cutover.test.ts
npm run verify:qwenpaw-release
git diff --check
```

预期：PASS；manifest 无 secret；Git 只包含本任务文件和用户原有未跟踪文档。

- [ ] **步骤 7：最终提交**

```bash
git add src/server/config/env.ts .env.example docker-compose.yml tests/unit/docker-config.test.ts README.md docs/env.md docs/prd.md docs/verification/release-m6.md docs/verification/release-manifest.json
git commit -m "feat(P0-8/P1-13): 正式切换 Console 与十七渠道"
```

**回滚：** 生产设置 `ADMIN_CONSOLE_ENABLED=false` 并只重启 web；数据库、Agent service、连接和 legacy 不回滚。协议事故单独 disable 受影响 connection。

**完成证据：** `release-m6.md`、`release-manifest.json`、全 gate、正式入口 E2E 和最终 commit。

### 任务 9：切换后有界观察与目标完成审计

**文件：**
- 修改：`docs/verification/release-m6.md`
- 修改：`docs/channels/smoke-matrix.md`

- [ ] **步骤 1：观察一个完整 24 小时窗口**

每小时记录：Console 5xx、compat 4xx/409、connection 状态、重复 event count、Agent执行次数/事件、Delivery retry/dead letter、node heartbeat、search redline、附件工具 guard。记录聚合数，不复制消息正文或 secret。

- [ ] **步骤 2：执行重复与恢复抽样**

对至少一个 webhook/long-poll/WebSocket/node 渠道各抽样一个 event：数据库查询确认一个 inbound、一个 user、一个 assistant、一个 Delivery；重启 agent service 后不新增 Agent step。没有真实平台条件的类别使用已通过故障注入证据并在报告注明自动化来源。

- [ ] **步骤 3：处理异常门槛**

若出现重复 Agent/回复、secret 泄露、附件触发工具、未授权联网、跨 agent 读取或无法回滚，立即 false 切回 legacy并 disable 受影响连接；修复后重跑本计划全部 gate，不能只重跑失败用例。

- [ ] **步骤 4：完成逐项审计**

逐一对照已批准规格第 21 节十项验收标准；每项写直接证据链接。任何一项无证据则目标继续保持进行中；`pending_external` 渠道只影响真实可用标记，不抹掉已完成的代码/自动化覆盖。

- [ ] **步骤 5：提交观察结果**

```bash
git add docs/verification/release-m6.md docs/channels/smoke-matrix.md
git commit -m "chore(P0-8/P1-13): 记录 Console 渠道切换后观察"
```

**回滚：** 观察期内始终可执行 false flag、单渠道 disable 和证书 revoke；不删除审计。

**完成证据：** 24 小时聚合、四传输类别抽样和规格第 21 节逐项证据。
