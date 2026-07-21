# QwenPaw Console 可复现基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M0–M1：建立可信测试边界，把 QwenPaw `v2.0.0.post3` Console 作为可校验快照和可重放补丁接入 `/admin-preview`，不影响现有 `/admin`。

**架构：** `vendor/qwenpaw-console/console` 保存原始 React 18/Vite 快照，`patches/qwenpaw-console` 只保存品牌、主题、路由鉴权和 API 基址差异，构建脚本在临时目录重放补丁并把静态产物写入 `public/_admin-console`。Next.js 只负责鉴权后的 SPA index 回退；React 18 测试与根 React 19 测试完全隔离。

**技术栈：** Node.js 22、Next.js 16、QwenPaw Console React 18/Vite 6、Vitest 4、Playwright、Git、SHA-256、Apache-2.0。

---

## 文件结构

**创建：**

- `scripts/qwenpaw-console/sync.mjs`：只从固定 tag/commit 获取 Console、LICENSE，并生成文件清单与哈希。
- `scripts/qwenpaw-console/verify-upstream.mjs`：验证快照来源、每个文件哈希、未混入 `node_modules`/`dist`。
- `scripts/qwenpaw-console/prepare.mjs`：复制原始快照到临时构建目录并顺序应用四个补丁。
- `scripts/qwenpaw-console/build.mjs`：在隔离依赖树中运行 Console 构建并原子替换 `public/_admin-console`。
- `scripts/qwenpaw-console/test.mjs`：运行固定快照的上游测试，不让根 Vitest 扫描上游目录。
- `vendor/qwenpaw-console/console/**`：QwenPaw 固定 Console 原始源文件与锁文件。
- `vendor/qwenpaw-console/reference/src/qwenpaw/app/channels/**`、`reference/src/qwenpaw/config/config.py`、`reference/src/qwenpaw/app/routers/config.py`：17 渠道实现与配置的只读审计快照。
- `vendor/qwenpaw-console/reference/tests/{unit,contract,fixtures}/channels/**`：上游渠道测试与 fixture 的只读审计快照。
- `vendor/qwenpaw-console/LICENSE`：上游 Apache-2.0 许可证原文。
- `vendor/qwenpaw-console/UPSTREAM.md`：tag、commit、URL、获取日期、目录哈希和本地修改类别。
- `vendor/qwenpaw-console/SHA256SUMS`：按相对路径排序的逐文件 SHA-256。
- `patches/qwenpaw-console/0001-brand.patch`：DigitalMate 可见名称、Logo、欢迎文案和 CSS prefix。
- `patches/qwenpaw-console/0002-theme.patch`：暖白/珊瑚主题变量。
- `patches/qwenpaw-console/0003-route-auth.patch`：`/admin` 与 `/admin-preview` basename、首页 Chat 跳转、共享 Cookie 登录。
- `patches/qwenpaw-console/0004-api-compat.patch`：API 基址、CSRF header 插槽和准确能力状态类型。
- `src/app/admin-preview/[[...path]]/route.ts`：鉴权后返回 Console index，并支持深层路由刷新。
- `src/server/admin/console-static.ts`：安全读取构建产物；禁止路径穿越。
- `tests/unit/qwenpaw-console-scripts.test.ts`：同步、哈希、补丁顺序和原子构建测试。
- `tests/unit/admin-console-static.test.ts`：未登录、index 回退、资源 MIME 和路径安全测试。
- `tests/e2e/admin-console-preview.spec.ts`：共享登录、全导航、首页聊天跳转和深层刷新测试。
- `docs/verification/qwenpaw-console-baseline.md`：M0/M1 命令、版本和结果记录。

**修改：**

- `vitest.config.ts`：排除 `.worktrees`、vendor、补丁、生成产物和 E2E。
- `package.json`、`package-lock.json`：加入隔离的 Console 同步、校验、测试和构建命令；根 `build` 先构建 Console。
- `Dockerfile`：构建阶段生成 Console 静态资源，运行阶段复制产物和第三方许可。
- `.gitignore`：忽略临时构建目录和 Console 构建产物，保留 vendor 源码。
- `next.config.ts`：给 `/_admin-console/assets/*` 配置 immutable 缓存，index 禁止长期缓存。
- `src/server/auth/session.ts`：只增加可复用的 Request Cookie 验证函数，不改变 Cookie 格式。

### 任务 1：收紧根测试扫描边界

**文件：**
- 修改：`vitest.config.ts`
- 创建：`tests/unit/vitest-config.test.ts`

- [ ] **步骤 1：编写失败的配置测试**

```ts
import config from "../../vitest.config";

it("只扫描 DigitalMate 当前工作区测试", () => {
  const exclude = config.test?.exclude ?? [];
  expect(exclude).toEqual(expect.arrayContaining([
    "node_modules/**",
    "tests/e2e/**",
    ".worktrees/**",
    "vendor/**",
    "patches/**",
    ".generated/**",
    "public/_admin-console/**",
  ]));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/vitest-config.test.ts`

预期：FAIL，输出缺少 `.worktrees/**`、`vendor/**`、`patches/**`、`.generated/**` 和 `public/_admin-console/**`。

- [ ] **步骤 3：实现精确排除列表**

```ts
exclude: [
  "node_modules/**",
  "tests/e2e/**",
  ".worktrees/**",
  "vendor/**",
  "patches/**",
  ".generated/**",
  "public/_admin-console/**",
],
```

- [ ] **步骤 4：运行目标测试与根基线**

运行：`npm test -- --run tests/unit/vitest-config.test.ts && npm run typecheck && npm test`

预期：配置测试 PASS；根测试不再输出 `.worktrees/chat-scroll-attachments` 或上游依赖测试路径。

- [ ] **步骤 5：提交测试边界**

```bash
git add vitest.config.ts tests/unit/vitest-config.test.ts
git commit -m "test(P0-8): 隔离 Console 与根测试边界"
```

**回滚：** 还原这两个文件即可；没有数据变更。

**完成证据：** 根 `npm test` 的收集列表只包含 `tests/unit`，结果写入 `docs/verification/qwenpaw-console-baseline.md`。

### 任务 2：建立固定上游同步与哈希校验

**文件：**
- 创建：`scripts/qwenpaw-console/sync.mjs`
- 创建：`scripts/qwenpaw-console/verify-upstream.mjs`
- 创建：`tests/unit/qwenpaw-console-scripts.test.ts`
- 创建：`vendor/qwenpaw-console/UPSTREAM.md`
- 创建：`vendor/qwenpaw-console/SHA256SUMS`
- 创建：`vendor/qwenpaw-console/LICENSE`
- 创建：`vendor/qwenpaw-console/console/**`
- 创建：`vendor/qwenpaw-console/reference/src/qwenpaw/app/channels/**`
- 创建：`vendor/qwenpaw-console/reference/src/qwenpaw/config/config.py`
- 创建：`vendor/qwenpaw-console/reference/src/qwenpaw/app/routers/config.py`
- 创建：`vendor/qwenpaw-console/reference/tests/{unit,contract,fixtures}/channels/**`
- 修改：`package.json`
- 修改：`package-lock.json`

- [ ] **步骤 1：编写失败的来源与安全测试**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";

describe("QwenPaw Console snapshot", () => {
  it("固定 tag、commit 并拒绝未登记文件", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dm-qwenpaw-"));
    await expect(verifySnapshot(root)).rejects.toThrow("UPSTREAM.md missing");
    const upstream = await readFile("vendor/qwenpaw-console/UPSTREAM.md", "utf8");
    expect(upstream).toContain("v2.0.0.post3");
    expect(upstream).toContain("fef7e64d984f4332d0b84a343cd209bd3ea5d316");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts`

预期：FAIL，`verify-upstream.mjs` 和 vendor 元数据尚不存在。

- [ ] **步骤 3：实现同步脚本的固定常量与目录规则**

```js
export const UPSTREAM = Object.freeze({
  repository: "https://github.com/agentscope-ai/QwenPaw.git",
  tag: "v2.0.0.post3",
  commit: "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
});

export const SNAPSHOT_PATHS = Object.freeze([
  "console",
  "LICENSE",
  "reference/src/qwenpaw/app/channels",
  "reference/src/qwenpaw/config/config.py",
  "reference/src/qwenpaw/app/routers/config.py",
  "reference/tests/unit/channels",
  "reference/tests/contract/channels",
  "reference/tests/fixtures/channels",
]);

export const FORBIDDEN_SEGMENTS = Object.freeze([
  "node_modules",
  "dist",
  ".git",
]);
```

`sync.mjs` 必须使用 `mkdtemp()` 创建临时目录，执行浅克隆后验证 `git rev-parse HEAD` 与固定 commit 完全相等；复制 `console`、根 `LICENSE`，以及只读审计所需的 `src/qwenpaw/app/channels`、`src/qwenpaw/config/config.py`、`src/qwenpaw/app/routers/config.py`、`tests/unit/channels`、`tests/contract/channels`、`tests/fixtures/channels` 到 `reference/`。对所有普通文件计算 SHA-256，按 POSIX 相对路径排序写入 `SHA256SUMS`，最后用目录 rename 替换 vendor。任何校验失败都删除临时目录且不改现有快照。

- [ ] **步骤 4：实现验证器的完整判定**

```js
export async function verifySnapshot(root = "vendor/qwenpaw-console") {
  const metadata = await readFile(path.join(root, "UPSTREAM.md"), "utf8").catch(() => {
    throw new Error("UPSTREAM.md missing");
  });
  if (!metadata.includes(UPSTREAM.tag) || !metadata.includes(UPSTREAM.commit)) {
    throw new Error("upstream identity mismatch");
  }
  const expected = await readChecksums(path.join(root, "SHA256SUMS"));
  const actual = await hashSnapshotFiles(root, FORBIDDEN_SEGMENTS);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("snapshot checksum mismatch");
  }
  return { files: actual.length, commit: UPSTREAM.commit };
}
```

- [ ] **步骤 5：加入精确脚本并执行同步**

`package.json` 增加：

```json
{
  "console:sync": "node scripts/qwenpaw-console/sync.mjs",
  "console:verify-upstream": "node scripts/qwenpaw-console/verify-upstream.mjs"
}
```

运行：`npm run console:sync && npm run console:verify-upstream`

预期：输出 commit `fef7e64d984f4332d0b84a343cd209bd3ea5d316`、文件总数和 `snapshot verified`；`git status` 不包含 `node_modules` 或 `dist`。

- [ ] **步骤 6：运行测试并提交原始快照**

运行：`npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts && git diff --check`

```bash
git add scripts/qwenpaw-console/sync.mjs scripts/qwenpaw-console/verify-upstream.mjs tests/unit/qwenpaw-console-scripts.test.ts vendor/qwenpaw-console package.json package-lock.json
git commit -m "chore(P0-8): 固定 QwenPaw Console 上游快照"
```

**回滚：** 删除本任务新增脚本和 vendor 目录，并还原 package 文件；没有运行时入口变化。

**完成证据：** `UPSTREAM.md`、`SHA256SUMS`、Apache-2.0 `LICENSE` 和校验命令输出。

### 任务 3：建立可重放补丁与隔离测试命令

**文件：**
- 创建：`scripts/qwenpaw-console/prepare.mjs`
- 创建：`scripts/qwenpaw-console/test.mjs`
- 创建：`patches/qwenpaw-console/0001-brand.patch`
- 创建：`patches/qwenpaw-console/0002-theme.patch`
- 创建：`patches/qwenpaw-console/0003-route-auth.patch`
- 创建：`patches/qwenpaw-console/0004-api-compat.patch`
- 修改：`tests/unit/qwenpaw-console-scripts.test.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的补丁顺序测试**

```ts
import { PATCHES, prepareConsole } from "../../scripts/qwenpaw-console/prepare.mjs";

it("只按批准顺序重放四个 Console 补丁", async () => {
  expect(PATCHES).toEqual([
    "0001-brand.patch",
    "0002-theme.patch",
    "0003-route-auth.patch",
    "0004-api-compat.patch",
  ]);
  const result = await prepareConsole({ keep: true });
  expect(result.applied).toEqual(PATCHES);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts`

预期：FAIL，`prepare.mjs` 和 `PATCHES` 尚不存在。

- [ ] **步骤 3：实现原子准备器**

```js
export const PATCHES = Object.freeze([
  "0001-brand.patch",
  "0002-theme.patch",
  "0003-route-auth.patch",
  "0004-api-compat.patch",
]);

export async function prepareConsole({ keep = false } = {}) {
  await verifySnapshot();
  const workdir = await mkdtemp(path.join(tmpdir(), "digitalmate-console-"));
  await cp("vendor/qwenpaw-console/console", workdir, { recursive: true });
  for (const patchName of PATCHES) {
    run("git", ["apply", "--check", path.resolve("patches/qwenpaw-console", patchName)], workdir);
    run("git", ["apply", path.resolve("patches/qwenpaw-console", patchName)], workdir);
  }
  if (!keep) process.once("exit", () => rmSync(workdir, { recursive: true, force: true }));
  return { workdir, applied: [...PATCHES] };
}
```

补丁内容必须达到以下可执行结果：可见 `QwenPaw`/`Qwen` 名称和 Logo 改为 DigitalMate；`ConfigProvider` 使用 `#E8684A` 与 `#FAF7F2`；Router 同时识别 `/admin` 和 `/admin-preview`；`/chat` 使用 `window.location.assign("/")`；AuthGuard 只调用同源 `/api/admin/compat/auth/status`；API 基址为 `/api/admin/compat`；写请求读取内存中的 CSRF token 并发送 `x-csrf-token`。许可证文件头不改。

- [ ] **步骤 4：实现隔离的上游测试命令**

`test.mjs` 调用 `prepareConsole({keep:true})`，在准备目录运行 `npm ci` 和 `npm run test:run`，始终删除准备目录，并把退出码原样返回。根 `package.json` 增加：

```json
{
  "console:prepare": "node scripts/qwenpaw-console/prepare.mjs",
  "console:test": "node scripts/qwenpaw-console/test.mjs"
}
```

- [ ] **步骤 5：运行补丁、上游测试和品牌扫描**

运行：`npm run console:prepare && npm run console:test`

运行：`rg -n "QwenPaw|Qwen" patches/qwenpaw-console --glob '!0001-brand.patch'`

预期：补丁全部通过 `git apply --check`；上游测试 PASS；品牌扫描只允许许可证、上游说明和内部不可见兼容标识，不允许用户可见字符串。

- [ ] **步骤 6：提交补丁系统**

```bash
git add scripts/qwenpaw-console/prepare.mjs scripts/qwenpaw-console/test.mjs patches/qwenpaw-console tests/unit/qwenpaw-console-scripts.test.ts package.json package-lock.json
git commit -m "feat(P0-8): 建立 Console 可重放品牌与兼容补丁"
```

**回滚：** 删除四个补丁和准备/测试脚本，vendor 快照仍保持原样可校验。

**完成证据：** 四个补丁的 `git apply --check`、上游测试报告和品牌字符串扫描。

### 任务 4：构建并原子发布 Console 静态产物

**文件：**
- 创建：`scripts/qwenpaw-console/build.mjs`
- 修改：`tests/unit/qwenpaw-console-scripts.test.ts`
- 修改：`package.json`
- 修改：`.gitignore`
- 修改：`next.config.ts`
- 修改：`Dockerfile`

- [ ] **步骤 1：编写失败的构建发布测试**

```ts
it("只在完整构建成功后替换 Console 产物", async () => {
  const publish = vi.fn();
  await expect(buildConsole({ runBuild: async () => { throw new Error("vite failed"); }, publish }))
    .rejects.toThrow("vite failed");
  expect(publish).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts`

预期：FAIL，`buildConsole` 尚不存在。

- [ ] **步骤 3：实现临时构建与 rename 发布**

```js
export async function buildConsole(deps = defaultDeps) {
  const prepared = await prepareConsole({ keep: true });
  const publishRoot = path.resolve("public/_admin-console");
  const stagingRoot = path.resolve("public/.admin-console-staging");
  try {
    await deps.runBuild(prepared.workdir);
    await rm(stagingRoot, { recursive: true, force: true });
    await cp(path.join(prepared.workdir, "dist"), stagingRoot, { recursive: true });
    await deps.publish(stagingRoot, publishRoot);
  } finally {
    await rm(prepared.workdir, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
```

`defaultDeps.runBuild` 在准备目录运行 `npm ci` 和 `npm run build:prod`；`defaultDeps.publish` 先把现有产物 rename 到同父目录备份，再 rename staging，成功后删除备份，失败则恢复备份。

- [ ] **步骤 4：接入根构建与缓存头**

`package.json` 使用：

```json
{
  "build": "npm run console:build && next build",
  "console:build": "node scripts/qwenpaw-console/build.mjs"
}
```

`next.config.ts` 为 `/_admin-console/assets/:path+` 设置一年 immutable；`/_admin-console/index.html` 设置 `no-store`。`.gitignore` 忽略 `public/_admin-console/`、`public/.admin-console-staging/` 和 `.generated/`。

- [ ] **步骤 5：更新容器复制范围**

`Dockerfile` 的 runner 阶段在现有 `public` 复制之外增加：

```dockerfile
COPY --from=builder /app/vendor/qwenpaw-console/LICENSE ./third-party/qwenpaw-console/LICENSE
COPY --from=builder /app/vendor/qwenpaw-console/UPSTREAM.md ./third-party/qwenpaw-console/UPSTREAM.md
```

- [ ] **步骤 6：运行构建测试和生产构建**

运行：`npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts && npm run console:build && npm run build`

预期：PASS；`public/_admin-console/index.html` 存在；Console 资源使用内容哈希文件名；根 Next 构建成功。

- [ ] **步骤 7：提交构建链路**

```bash
git add scripts/qwenpaw-console/build.mjs tests/unit/qwenpaw-console-scripts.test.ts package.json package-lock.json .gitignore next.config.ts Dockerfile
git commit -m "build(P0-8): 集成隔离 Console 构建产物"
```

**回滚：** 还原根 build 命令、Dockerfile 和缓存头；静态目录是忽略的生成物，可安全重新生成。

**完成证据：** Console build、Next build、镜像内许可证路径和失败不替换旧产物的单测。

### 任务 5：提供鉴权后的 `/admin-preview` SPA 回退

**文件：**
- 创建：`src/server/admin/console-static.ts`
- 创建：`src/app/admin-preview/[[...path]]/route.ts`
- 修改：`src/server/auth/session.ts`
- 创建：`tests/unit/admin-console-static.test.ts`

- [ ] **步骤 1：编写失败的鉴权与路径测试**

```ts
it.each(["../package.json", "%2e%2e/package.json", "assets/../../package.json"])(
  "拒绝 Console 路径穿越 %s",
  async (pathname) => {
    await expect(readAdminConsoleAsset(pathname)).rejects.toMatchObject({ code: "invalid_asset_path" });
  },
);

it("未登录访问预览入口时跳转登录并保留返回路径", async () => {
  const response = await GET(new Request("https://mate.example/admin-preview/channels"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://mate.example/login?redirect=%2Fadmin-preview%2Fchannels");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-console-static.test.ts`

预期：FAIL，路由和资源读取器尚不存在。

- [ ] **步骤 3：实现安全资源读取器**

```ts
const ADMIN_ROOT = path.resolve(process.cwd(), "public", "_admin-console");

export async function readAdminConsoleAsset(requestPath: string) {
  const decoded = decodeURIComponent(requestPath || "index.html");
  const relative = decoded.startsWith("assets/") ? decoded : "index.html";
  const absolute = path.resolve(ADMIN_ROOT, relative);
  if (absolute !== ADMIN_ROOT && !absolute.startsWith(`${ADMIN_ROOT}${path.sep}`)) {
    throw Object.assign(new Error("invalid_asset_path"), { code: "invalid_asset_path" });
  }
  return { body: await readFile(absolute), contentType: contentTypeFor(absolute) };
}
```

- [ ] **步骤 4：实现 Request Cookie 鉴权和 SPA 路由**

`session.ts` 新增 `verifySessionRequest(request, defaultUserId, secret)`：从 Request 的 `cookie` header 读取 `dm_session` 并复用 `verifySessionToken`，不得依赖 `next/headers`。路由先验证用户；失败 307 到 `/login?redirect=`；成功时 assets 返回实际资源，其余路径返回 `index.html`，index header 为 `no-store`。

- [ ] **步骤 5：运行单测与深层资源检查**

运行：`npm test -- --run tests/unit/admin-console-static.test.ts`

预期：PASS；`/admin-preview/channels`、`/admin-preview/agents` 返回 index；`/admin-preview/assets/不存在.js` 返回 404；穿越路径返回 400。

- [ ] **步骤 6：提交预览入口**

```bash
git add src/server/admin/console-static.ts src/app/admin-preview src/server/auth/session.ts tests/unit/admin-console-static.test.ts
git commit -m "feat(P0-8): 提供鉴权 Console 预览入口"
```

**回滚：** 删除预览路由和资源读取器；原 `/admin` 不受影响。

**完成证据：** 未登录、登录、深层刷新、资源 MIME、缓存与路径穿越单测。

### 任务 6：建立 Console 导航与视觉基线

**文件：**
- 创建：`tests/e2e/admin-console-preview.spec.ts`
- 修改：`playwright.config.ts`
- 创建：`tests/e2e/admin-console.routes.ts`
- 创建：`docs/verification/qwenpaw-console-baseline.md`

- [ ] **步骤 1：定义 26 个上游路由基线**

```ts
export const QWENPAW_BUILTIN_ROUTES = [
  "/chat", "/coding", "/channels", "/sessions", "/inbox", "/cron-jobs",
  "/heartbeat", "/skills", "/skill-pool", "/tools", "/mcp", "/acp", "/ACP",
  "/workspace", "/agents", "/models", "/environments", "/agent-config", "/security",
  "/token-usage", "/agent-stats", "/voice-transcription", "/debug", "/backups",
  "/plugin-manager", "/",
] as const;
```

- [ ] **步骤 2：编写失败的导航与视觉 E2E**

```ts
for (const route of QWENPAW_BUILTIN_ROUTES.filter((value) => value !== "/chat")) {
  test(`Console route ${route}`, async ({ page }) => {
    await page.goto(`/admin-preview${route}`);
    await expect(page.locator("#root")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });
}

test("Chat 入口只跳转 DigitalMate 首页", async ({ page }) => {
  await page.goto("/admin-preview/inbox");
  await page.getByRole("button", { name: /Chat|聊天/ }).click();
  await expect(page).toHaveURL("/");
});
```

- [ ] **步骤 3：运行 E2E 验证失败**

运行：`npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts`

预期：首次运行至少有路由、登录兼容 API或 Console build 前置条件失败；不得用 `test.skip` 消除失败。

- [ ] **步骤 4：补齐 E2E 启动前的 Console 构建与三视口项目**

`playwright.config.ts` 在 webServer command 前执行 `npm run console:build`，并增加 `Desktop Chrome`、`iPad Mini`、`Mobile Chrome` 三个项目。截图固定隐藏时间、随机 ID 和平台连接状态，只比较布局；主题断言 `--dm-color-primary: #E8684A` 与背景 `#FAF7F2`。

- [ ] **步骤 5：运行导航、深层刷新与截图基线**

运行：`npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --update-snapshots`

运行：`npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts`

预期：三个视口全部 PASS；所有 26 个路由可刷新；Chat 只跳首页；旧 `/admin` 仍由现有 Next 页面提供。

- [ ] **步骤 6：记录 M0/M1 基线并提交**

`docs/verification/qwenpaw-console-baseline.md` 记录 Node/npm 版本、上游 tag/commit、Console 测试数量、根 typecheck/test/build、E2E 三视口结果和旧后台未切换结论。

```bash
git add tests/e2e/admin-console-preview.spec.ts tests/e2e/admin-console.routes.ts playwright.config.ts docs/verification/qwenpaw-console-baseline.md
git commit -m "test(P0-8): 固化 Console 导航与三视口基线"
```

**回滚：** 删除本任务测试和证据文档不会改变运行时；不要删除已经固定的上游快照。

**完成证据：** 26 路由 × 3 视口报告、结构截图、Chat 跳转、深层刷新和旧 `/admin` 保持测试。

### 任务 7：M0–M1 总验证

**文件：** 本计划列出的全部文件。

- [ ] **步骤 1：运行完整验证**

```bash
npm run console:verify-upstream
npm run console:test
npm run console:build
npm run typecheck
npm test
npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts
npm run build
git diff --check
```

预期：全部 PASS；根测试不扫描 vendor 和 `.worktrees`；构建产物不进入 Git；`git status --short` 只显示本计划文件和用户原有未跟踪文档。

- [ ] **步骤 2：核对许可与品牌**

运行：`test -f vendor/qwenpaw-console/LICENSE && test -f vendor/qwenpaw-console/UPSTREAM.md && test -f vendor/qwenpaw-console/SHA256SUMS`

运行：`rg -n "QwenPaw|Qwen" public/_admin-console --glob '*.js' --glob '*.html'`

预期：许可文件齐全；构建产物不出现用户可见上游品牌文案，内部兼容键若保留必须列入 `UPSTREAM.md`。

- [ ] **步骤 3：里程碑提交**

```bash
git add docs/verification/qwenpaw-console-baseline.md
git commit -m "chore(P0-8): 完成 Console M0-M1 基线验收"
```

**回滚：** `/admin-preview` 可整路由删除，现有 `/admin` 和数据库均未改变。

**完成证据：** `docs/verification/qwenpaw-console-baseline.md` 中每条命令都有日期、退出码和结果摘要。
