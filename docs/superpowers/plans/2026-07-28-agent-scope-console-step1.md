# 智能体作用域后台开放（第一步）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理后台可以选中并编辑非默认智能体（Alvin），从而在 Alvin 作用域下配置钉钉连接。

**Architecture:** 服务端的按请求头解析作用域能力已完整存在，本计划只做两件事——后端把"当前可用的写操作"如实上报并按 slug 给出正确描述；Console 侧新增 `0005-agent-scope.patch`，把硬编码的"非默认智能体一律禁用"改为由后端能力驱动，并允许选择器列出与切换非默认智能体。

**Tech Stack:** TypeScript、Next.js App Router、vitest、zustand、Ant Design、React；vendored QwenPaw Console 通过 `patches/qwenpaw-console/*.patch` 叠加补丁后由 `scripts/qwenpaw-console/build.mjs` 打包到 `public/_admin-console`。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-07-28-agent-instance-management-design.md`，不得超出其第 3 节"第一步范围"。
- 第一步不新增任何写能力：任意新建、克隆、导入、删除、启用停用、置顶、排序全部保持关闭，后端继续返回 501 与稳定能力码。
- Web 前台（`src/app/**`）一行不改，首页聊天继续硬编码默认智能体。
- 不修改 `vendor/qwenpaw-console/**` 快照，也不修改 `patches/qwenpaw-console/0004-api-compat.patch`；Console 侧改动全部放进新增的 `0005-agent-scope.patch`。
- 与用户沟通、文档、commit message 用简体中文；代码标识符与代码注释用英文。
- 每个任务结束时必须跑通该任务列出的测试命令，并单独提交。
- 全部任务完成后跑一次 `npm run typecheck` 与 `npm test`，含 AGENTS.md 要求的四条回归用例（普通问候 0 次搜索、未授权实时问题 0 次搜索、遗留无授权分享不投递、同一主动任务重复执行只写入 1 条可见消息）。
- 本机跑 vitest 前若集成测试报 `could not create shared memory segment`，先清理孤立共享内存段：`for id in $(ipcs -mo | tail -n +4 | awk '$1=="m" && $NF==0 {print $2}'); do ipcrm -m $id; done`。

---

### Task 1: 后端能力常量、按 slug 描述与列表能力字段

**Files:**
- Modify: `src/server/admin/compat/handlers/agents.ts`
- Test: `tests/unit/admin-compat-agents.test.ts`

**Interfaces:**
- Consumes: `AdminAgentProfileSnapshot`（`src/server/admin/agent-profile.ts`）、`context.resources.agents.listActive/getActive` 返回的 `DigitalAgent`（含 `slug`、`isDefault`）。
- Produces: `GET /agents` 响应新增顶层字段 `capabilities: { multi_agent: boolean; create: boolean; import: boolean; clone: boolean; delete: boolean; toggle: boolean; pin: boolean; reorder: boolean }`；列表与详情响应的 `description` 按 `slug` 取值。Task 3 与 Task 5 的前端依赖这两点。

- [ ] **Step 1: 写失败测试——列表返回能力字段与按 slug 的描述**

在 `tests/unit/admin-compat-agents.test.ts` 中，把现有的 `it("lists DigitalMate and the independent Alvin agent")` 整体替换为下面两个用例（第一个是在原用例上补断言，第二个是新增）：

```ts
  it("lists DigitalMate and the independent Alvin agent", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      new Request("http://localhost/api/admin/compat/agents"),
      runtime(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agents: [
        expect.objectContaining({
          id: DEFAULT_AGENT_ID,
          name: "DigitalMate",
          description:
            "DigitalMate 默认数字分身，全渠道共享同一身份与记忆。",
          enabled: true,
          pinned: true,
          revision: 1,
        }),
        expect.objectContaining({
          id: OTHER_AGENT_ID,
          name: "Alvin",
          description: "独立的 MaaS 售前解决方案架构师。",
          enabled: true,
          is_default: false,
        }),
      ],
      capabilities: {
        multi_agent: true,
        create: false,
        import: false,
        clone: false,
        delete: false,
        toggle: false,
        pin: false,
        reorder: false,
      },
    });
  });

  it("keeps the profile capabilities identical to the list capabilities", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const list = await router.dispatch(
      new Request("http://localhost/api/admin/compat/agents"),
      runtime(),
    );
    const profile = await router.dispatch(
      new Request(
        `http://localhost/api/admin/compat/agents/${OTHER_AGENT_ID}`,
        {
          headers: { "x-digitalmate-agent-id": OTHER_AGENT_ID },
        },
      ),
      runtime(),
    );

    const listBody = (await list.json()) as { capabilities: unknown };
    const profileBody = (await profile.json()) as {
      capabilities: unknown;
      description: unknown;
    };

    expect(profileBody.capabilities).toEqual(listBody.capabilities);
    expect(profileBody.description).toBe(
      "独立的 MaaS 售前解决方案架构师。",
    );
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/admin-compat-agents.test.ts -t "lists DigitalMate"`
Expected: FAIL，实际响应缺少顶层 `capabilities`，且 Alvin 的 `description` 仍是默认分身文案。

- [ ] **Step 3: 实现最小改动**

在 `src/server/admin/compat/handlers/agents.ts` 顶部，把

```ts
const DEFAULT_AGENT_DESCRIPTION =
  "DigitalMate 默认数字分身，全渠道共享同一身份与记忆。";
```

替换为：

```ts
const DEFAULT_AGENT_DESCRIPTION =
  "DigitalMate 默认数字分身，全渠道共享同一身份与记忆。";
const ALVIN_AGENT_DESCRIPTION = "独立的 MaaS 售前解决方案架构师。";
const AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  digitalmate: DEFAULT_AGENT_DESCRIPTION,
  alvin: ALVIN_AGENT_DESCRIPTION,
});
// "create" reports whether the console may create arbitrary agents. The fixed
// Alvin instance is provisioned by an idempotent ops script, not by the UI.
const AGENT_CAPABILITIES = Object.freeze({
  multi_agent: true,
  create: false,
  import: false,
  clone: false,
  delete: false,
  toggle: false,
  pin: false,
  reorder: false,
});

function describeAgent(slug: string, displayName: string): string {
  return AGENT_DESCRIPTIONS[slug] ?? displayName;
}
```

把 `toAgentSummary` 与 `toAgentProfile` 改为接收智能体本体而不是布尔值：

```ts
function toAgentSummary(
  profile: AdminAgentProfileSnapshot,
  agent: { slug: string; isDefault: boolean },
) {
  return {
    id: profile.id,
    name: profile.displayName,
    display_name: profile.displayName,
    description: describeAgent(agent.slug, profile.displayName),
    workspace_dir: "",
    enabled: true,
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: agent.isDefault,
    revision: profile.revision,
  };
}

function toAgentProfile(
  profile: AdminAgentProfileSnapshot,
  agent: { slug: string; isDefault: boolean },
) {
  return {
    ...toAgentSummary(profile, agent),
    persona: profile.persona,
    settings: {
      proactivity: profile.proactivity,
      cadence: profile.cadence,
      search: profile.search,
    },
    capabilities: AGENT_CAPABILITIES,
  };
}
```

`createListAgentsHandler` 的 return 改为：

```ts
    return {
      agents: await Promise.all(
        agents.map(async (agent) =>
          toAgentSummary(
            await readProfile(
              {
                userId: context.scope.userId,
                agentId: agent.id,
              },
              context.signal,
            ),
            agent,
          )
        ),
      ),
      capabilities: AGENT_CAPABILITIES,
    };
```

`createGetAgentHandler` 的最后一行改为 `return toAgentProfile(profile, agent);`。

`createUpdateAgentHandler` 的 return 改为：

```ts
    return {
      id: context.scope.agentId,
      name: input.name,
      display_name: input.name,
      description: describeAgent(agent.slug, input.name),
      workspace_dir: "",
      enabled: true,
      pinned: true,
      startup_status: "running",
      active_model: null,
      is_default: agent.isDefault,
      persona: input.persona,
      settings: input.settings,
      revision: updated.revision,
      capabilities: AGENT_CAPABILITIES,
    };
```

`createAgent` 的 return 改为：

```ts
  return {
    id: agent.id,
    name: agent.displayName,
    display_name: agent.displayName,
    description: describeAgent(agent.slug, agent.displayName),
    workspace_dir: "",
    enabled: true,
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: false,
    capabilities: AGENT_CAPABILITIES,
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/admin-compat-agents.test.ts`
Expected: PASS，全部用例通过（含原有的 create/clone/import/delete 501 用例与 revision CAS 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/admin/compat/handlers/agents.ts tests/unit/admin-compat-agents.test.ts
git commit -m "feat(P1-14): 后台按 slug 描述智能体并上报可用写能力"
```

---

### Task 2: 建立补丁工作流并放开作用域请求头

**Files:**
- Create: `patches/qwenpaw-console/0005-agent-scope.patch`
- Modify: `scripts/qwenpaw-console/prepare.mjs:22-27`
- Modify: `tests/unit/qwenpaw-console-scripts.test.ts:2003-2013`、`tests/unit/qwenpaw-console-scripts.test.ts:2038-2045`、`tests/unit/qwenpaw-console-scripts.test.ts:2100`（用例标题中的"四个补丁"改为"五个补丁"）
- 补丁内改动：`src/api/agentScope.ts`、`src/api/authHeaders.ts:1-39`、`src/api/authHeaders.test.ts:1-48`

**Interfaces:**
- Consumes: Task 1 无依赖。
- Produces: `src/api/agentScope.ts` 导出 `isCanonicalAgentId(value: unknown): value is string`、`markValidatedAgents(agentIds: readonly string[], defaultAgentId: string | null): void`、`clearValidatedAgents(): void`、`isValidatedAgent(agentId: unknown): agentId is string`、`getValidatedDefaultAgent(): string | null`。Task 3 的 store 调用 `markValidatedAgents` 与 `clearValidatedAgents`。

- [ ] **Step 1: 建立补丁基线工作目录**

```bash
cd /Users/tang/Documents/DigitalMate
rm -rf /tmp/dm-console-work
mkdir -p /tmp/dm-console-work
cp -R vendor/qwenpaw-console/console/. /tmp/dm-console-work/
cd /tmp/dm-console-work
git init -q .
git add -A
git -c user.email=dev@local -c user.name=dev commit -qm upstream
for p in 0001-brand 0002-theme 0003-route-auth 0004-api-compat; do
  git apply /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/$p.patch
done
git add -A
git -c user.email=dev@local -c user.name=dev commit -qm patched
git log --oneline
```

Expected: 输出两条提交（`patched`、`upstream`）。`/tmp/dm-console-work` 即"有效 Console 源码"，后续 Task 2 至 Task 5 都在这里改，再导出 0005 补丁。

- [ ] **Step 2: 写失败测试——已校验的非默认智能体也要带作用域头**

编辑 `/tmp/dm-console-work/src/api/authHeaders.test.ts`：把文件顶部的 import 与前两个用例替换为：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHeaders, buildMutationHeaders } from "./authHeaders";
import { setCsrfToken } from "./config";
import { clearValidatedAgents, markValidatedAgents } from "./agentScope";

const DEFAULT_AGENT_ID = "10000000-0000-4000-8000-000000000011";
const SECONDARY_AGENT_ID = "10000000-0000-4000-8000-000000000012";

describe("auth headers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearValidatedAgents();
    sessionStorage.setItem(
      "qwenpaw-agent-storage",
      JSON.stringify({ state: { selectedAgent: "default" } }),
    );
    setCsrfToken(
      "csrf-value",
      Math.floor(Date.now() / 1_000) + 1_800,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not send the legacy placeholder before the first agent list", () => {
    expect(buildAuthHeaders()).toEqual({});
  });

  it("sends the real selected UUID through both compatibility headers", () => {
    sessionStorage.setItem(
      "qwenpaw-agent-storage",
      JSON.stringify({
        state: { selectedAgent: DEFAULT_AGENT_ID },
      }),
    );
    markValidatedAgents([DEFAULT_AGENT_ID], DEFAULT_AGENT_ID);
    expect(buildAuthHeaders()).toEqual({
      "X-Agent-Id": DEFAULT_AGENT_ID,
      "x-digitalmate-agent-id": DEFAULT_AGENT_ID,
    });
  });

  it("scopes requests to a listed non-default agent", () => {
    sessionStorage.setItem(
      "qwenpaw-agent-storage",
      JSON.stringify({
        state: { selectedAgent: SECONDARY_AGENT_ID },
      }),
    );
    markValidatedAgents(
      [DEFAULT_AGENT_ID, SECONDARY_AGENT_ID],
      DEFAULT_AGENT_ID,
    );
    expect(buildAuthHeaders()).toEqual({
      "X-Agent-Id": SECONDARY_AGENT_ID,
      "x-digitalmate-agent-id": SECONDARY_AGENT_ID,
    });
  });

  it("drops a selection that the agent list never returned", () => {
    sessionStorage.setItem(
      "qwenpaw-agent-storage",
      JSON.stringify({
        state: { selectedAgent: SECONDARY_AGENT_ID },
      }),
    );
    markValidatedAgents([DEFAULT_AGENT_ID], DEFAULT_AGENT_ID);
    expect(buildAuthHeaders()).toEqual({});
  });
```

（文件其余用例保持不动。）

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /tmp/dm-console-work
npm ci
npx vitest run src/api/authHeaders.test.ts
```

Expected: FAIL，报 `clearValidatedAgents`/`markValidatedAgents` 不存在。`npm ci` 需要网络。

- [ ] **Step 4: 实现最小改动**

把 `/tmp/dm-console-work/src/api/agentScope.ts` 整体替换为：

```ts
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let validatedAgentIds: ReadonlySet<string> = new Set<string>();
let validatedDefaultAgentId: string | null = null;

export function isCanonicalAgentId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

/** Records the agent ids the server listed for this account. */
export function markValidatedAgents(
  agentIds: readonly string[],
  defaultAgentId: string | null,
): void {
  validatedAgentIds = new Set(agentIds.filter(isCanonicalAgentId));
  validatedDefaultAgentId =
    isCanonicalAgentId(defaultAgentId) &&
    validatedAgentIds.has(defaultAgentId)
      ? defaultAgentId
      : null;
}

export function clearValidatedAgents(): void {
  validatedAgentIds = new Set<string>();
  validatedDefaultAgentId = null;
}

export function isValidatedAgent(agentId: unknown): agentId is string {
  return isCanonicalAgentId(agentId) && validatedAgentIds.has(agentId);
}

export function getValidatedDefaultAgent(): string | null {
  return validatedDefaultAgentId;
}
```

把 `/tmp/dm-console-work/src/api/authHeaders.ts` 的第 7 至 10 行 import 改为：

```ts
import { isValidatedAgent } from "./agentScope";
```

并把第 27 至 33 行的判断改为：

```ts
      if (isValidatedAgent(selectedAgent)) {
        headers["X-Agent-Id"] = selectedAgent;
        headers["x-digitalmate-agent-id"] = selectedAgent;
      }
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /tmp/dm-console-work
npx vitest run src/api/authHeaders.test.ts
```

Expected: PASS。

- [ ] **Step 6: 导出 0005 补丁并登记**

```bash
cd /tmp/dm-console-work
git add -A
git diff HEAD > /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch
grep -c "^+++ b/" /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch
grep -n " $" /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch || echo "no trailing whitespace"
```

Expected: 3 个目标文件（`agentScope.ts`、`authHeaders.ts`、`authHeaders.test.ts`），且无行尾空白。

把 `scripts/qwenpaw-console/prepare.mjs:22-27` 改为：

```js
export const PATCHES = Object.freeze([
  "0001-brand.patch",
  "0002-theme.patch",
  "0003-route-auth.patch",
  "0004-api-compat.patch",
  "0005-agent-scope.patch",
]);
```

- [ ] **Step 7: 更新脚本测试并跑通**

在 `tests/unit/qwenpaw-console-scripts.test.ts` 中：

把 `it("固定四个补丁的不可变应用顺序")` 改为：

```ts
  it("固定五个补丁的不可变应用顺序", () => {
    expect(PATCHES).toEqual([
      "0001-brand.patch",
      "0002-theme.patch",
      "0003-route-auth.patch",
      "0004-api-compat.patch",
      "0005-agent-scope.patch",
    ]);
    expect(Object.isFrozen(PATCHES)).toBe(true);
    expect(Reflect.set(PATCHES, 0, "changed.patch")).toBe(false);
    expect(PATCHES[0]).toBe("0001-brand.patch");
  });
```

把 `it("四个补丁使用普通 unified diff 上下文且没有行尾空白")` 标题改为 `it("五个补丁使用普通 unified diff 上下文且没有行尾空白")`（循环体已按 `PATCHES` 迭代，无需改动逻辑）。

把 `it("0004 对每个目标文件只保留一个 canonical diff header")` 改为同时覆盖 0005：

```ts
  it.each([
    "0004-api-compat.patch",
    "0005-agent-scope.patch",
  ])("%s 对每个目标文件只保留一个 canonical diff header", async (patchName) => {
    const patchSource = await readFile(
      path.resolve("patches/qwenpaw-console", patchName),
      "utf8",
    );
    const counts = new Map<string, number>();
```

（该用例后续断言逻辑保持不动。）

把 `it("真实验证并应用四个补丁，生成 DigitalMate Console 集成树")` 标题改为 `it("真实验证并应用五个补丁，生成 DigitalMate Console 集成树")`。

Run: `npx vitest run tests/unit/qwenpaw-console-scripts.test.ts`
Expected: PASS（含真实应用五个补丁的用例）。

- [ ] **Step 8: 提交**

```bash
git add patches/qwenpaw-console/0005-agent-scope.patch scripts/qwenpaw-console/prepare.mjs tests/unit/qwenpaw-console-scripts.test.ts
git commit -m "feat(P1-14): 后台请求头支持已校验的非默认智能体作用域"
```

---

### Task 3: store 记录能力并保留合法的非默认选择

**Files:**
- Modify（补丁内）: `/tmp/dm-console-work/src/api/types/agents.ts:49-59`、`/tmp/dm-console-work/src/stores/agentStore.ts:1-140`
- Test（补丁内）: `/tmp/dm-console-work/src/stores/agentStore.test.ts`
- Modify: `patches/qwenpaw-console/0005-agent-scope.patch`（重新导出）

**Interfaces:**
- Consumes: Task 1 的 `GET /agents` 顶层 `capabilities`；Task 2 的 `markValidatedAgents` / `clearValidatedAgents`。
- Produces: `AgentCapabilities` 新增 `toggle`、`pin`、`reorder` 三个 boolean；`AgentListResponse` 新增可选 `capabilities?: AgentCapabilities`；`useAgentStore` 新增 `capabilities: AgentCapabilities` 状态字段，默认全 false。Task 4 与 Task 5 从 store 读取该字段。

- [ ] **Step 1: 写失败测试——保留合法选择、记录能力、缺省全关**

在 `/tmp/dm-console-work/src/stores/agentStore.test.ts` 中，把第 5 行 import 改为：

```ts
import { clearValidatedAgents } from "@/api/agentScope";
```

把 `beforeEach` 里的 `clearValidatedDefaultAgent();` 改为 `clearValidatedAgents();`，并在 `it("starts headerless, then scopes later requests to the listed default UUID")` 之后插入三个新用例：

```ts
  it("keeps a listed non-default selection across refresh", async () => {
    const secondaryId = "10000000-0000-4000-8000-000000000012";
    useAgentStore.setState({ selectedAgent: secondaryId, agents: [] });
    const defaultAgent = {
      ...mockAgent(DEFAULT_AGENT_ID),
      is_default: true,
      enabled: true,
      pinned: true,
    };
    const secondaryAgent = {
      ...mockAgent(secondaryId),
      is_default: false,
      enabled: true,
      pinned: true,
    };
    mocks.listAgents.mockResolvedValue({
      agents: [defaultAgent, secondaryAgent],
    });

    await useAgentStore.getState().refreshAgents();

    expect(useAgentStore.getState().selectedAgent).toBe(secondaryId);
    expect(buildAuthHeaders()).toEqual({
      "X-Agent-Id": secondaryId,
      "x-digitalmate-agent-id": secondaryId,
    });
  });

  it("stores the capabilities reported by the agent list", async () => {
    mocks.listAgents.mockResolvedValue({
      agents: [],
      capabilities: {
        multi_agent: true,
        create: false,
        import: false,
        clone: false,
        delete: false,
        toggle: false,
        pin: false,
        reorder: false,
      },
    });

    await useAgentStore.getState().refreshAgents();

    expect(useAgentStore.getState().capabilities.multi_agent).toBe(true);
    expect(useAgentStore.getState().capabilities.delete).toBe(false);
  });

  it("treats a missing capabilities payload as all disabled", async () => {
    mocks.listAgents.mockResolvedValue({ agents: [] });

    await useAgentStore.getState().refreshAgents();

    expect(useAgentStore.getState().capabilities).toEqual({
      multi_agent: false,
      create: false,
      import: false,
      clone: false,
      delete: false,
      toggle: false,
      pin: false,
      reorder: false,
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /tmp/dm-console-work
npx vitest run src/stores/agentStore.test.ts
```

Expected: FAIL，`clearValidatedAgents` 不存在于旧 import 之外的断言失败，`capabilities` 未定义，且非默认选择被强制重置为默认 UUID。

- [ ] **Step 3: 实现最小改动**

`/tmp/dm-console-work/src/api/types/agents.ts` 的 `AgentCapabilities` 与 `AgentListResponse` 改为：

```ts
export interface AgentCapabilities {
  multi_agent: boolean;
  create: boolean;
  import: boolean;
  clone: boolean;
  delete: boolean;
  toggle: boolean;
  pin: boolean;
  reorder: boolean;
}

export const DISABLED_AGENT_CAPABILITIES: AgentCapabilities = {
  multi_agent: false,
  create: false,
  import: false,
  clone: false,
  delete: false,
  toggle: false,
  pin: false,
  reorder: false,
};

export interface AgentListResponse {
  agents: AgentSummary[];
  capabilities?: AgentCapabilities;
}
```

`/tmp/dm-console-work/src/stores/agentStore.ts` 的第 3 至 8 行 import 改为：

```ts
import {
  DISABLED_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentSummary,
} from "../api/types/agents";
import { agentsApi } from "../api/modules/agents";
import {
  clearValidatedAgents,
  markValidatedAgents,
} from "../api/agentScope";
```

`AgentStore` 接口新增字段（放在 `agents: AgentSummary[];` 之后）：

```ts
  capabilities: AgentCapabilities;
```

初始状态新增（放在 `agents: [],` 之后）：

```ts
      capabilities: { ...DISABLED_AGENT_CAPABILITIES },
```

`setSelectedAgent` 中删除 `markValidatedDefaultAgent` / `clearValidatedDefaultAgent` 分支，改为只保留选择与持久化（已校验集合由 `refreshAgents` 统一维护）：

```ts
      setSelectedAgent: (agentId) => {
        set({ selectedAgent: agentId });
        menuRegistry.refresh();
        // Persist to localStorage so new tabs inherit this choice
        try {
          localStorage.setItem(LAST_USED_AGENT_KEY, agentId);
        } catch {
          /* ignore */
        }
      },
```

`refreshAgents` 整体替换为：

```ts
      refreshAgents: async () => {
        if (agentRefreshPromise !== null) {
          return agentRefreshPromise;
        }

        agentRefreshPromise = agentsApi.listAgents().then((response) => {
          const defaultAgent = response.agents.find(
            (agent) => agent.is_default === true,
          );
          if (response.agents.length === 0) {
            clearValidatedAgents();
          } else {
            markValidatedAgents(
              response.agents.map((agent) => agent.id),
              defaultAgent?.id ?? null,
            );
          }
          const previousSelected = get().selectedAgent;
          const selectionIsUsable = response.agents.some(
            (agent) => agent.id === previousSelected && agent.enabled,
          );
          const nextSelected = selectionIsUsable
            ? previousSelected
            : defaultAgent?.id ?? previousSelected;
          set({
            agents: response.agents,
            capabilities: response.capabilities ?? {
              ...DISABLED_AGENT_CAPABILITIES,
            },
            selectedAgent: nextSelected,
          });
          if (nextSelected !== previousSelected) {
            menuRegistry.refresh();
            try {
              localStorage.setItem(LAST_USED_AGENT_KEY, nextSelected);
            } catch {
              /* ignore */
            }
          }
        });
        try {
          await agentRefreshPromise;
        } finally {
          agentRefreshPromise = null;
        }
      },
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /tmp/dm-console-work
npx vitest run src/stores/agentStore.test.ts src/api/authHeaders.test.ts
```

Expected: PASS。

- [ ] **Step 5: 重新导出补丁并提交**

```bash
cd /tmp/dm-console-work
git add -A
git diff HEAD > /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch
cd /Users/tang/Documents/DigitalMate
npx vitest run tests/unit/qwenpaw-console-scripts.test.ts
git add patches/qwenpaw-console/0005-agent-scope.patch
git commit -m "feat(P1-14): 后台记录智能体能力并保留合法的非默认选择"
```

Expected: 脚本测试 PASS（五个补丁仍可真实应用）。

---

### Task 4: 选择器列出并可切换非默认智能体

**Files:**
- Modify（补丁内）: `/tmp/dm-console-work/src/components/AgentSelector/index.tsx:73-115`、`:164-190`、`:327`
- Test（补丁内）: `/tmp/dm-console-work/src/components/AgentSelector/AgentSelector.test.tsx`
- Modify: `patches/qwenpaw-console/0005-agent-scope.patch`（重新导出）

**Interfaces:**
- Consumes: Task 3 的 `useAgentStore().capabilities`（`AgentCapabilities`，含 `toggle`、`pin`）。
- Produces: 侧栏选择器可选中任意 `enabled` 的智能体；不引入新的导出符号。

- [ ] **Step 1: 写失败测试——列出并可切换非默认智能体**

在 `/tmp/dm-console-work/src/components/AgentSelector/AgentSelector.test.tsx` 末尾（`describe` 内）追加：

```ts
  it("lists a non-default agent and switches scope to it", async () => {
    const secondaryId = "10000000-0000-4000-8000-000000000012";
    useAgentStore.setState({
      selectedAgent: DEFAULT_AGENT_ID,
      agents: [
        {
          id: DEFAULT_AGENT_ID,
          name: "DigitalMate",
          description: "默认分身",
          workspace_dir: "",
          enabled: true,
          pinned: true,
          startup_status: "running",
          is_default: true,
        },
        {
          id: secondaryId,
          name: "Alvin",
          description: "独立的 MaaS 售前解决方案架构师。",
          workspace_dir: "",
          enabled: true,
          pinned: true,
          startup_status: "running",
          is_default: false,
        },
      ] as AgentSummary[],
    });

    render(
      <MemoryRouter>
        <AgentSelector />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alvin")).toBeInTheDocument();
    });

    useAgentStore.getState().setSelectedAgent(secondaryId);
    expect(useAgentStore.getState().selectedAgent).toBe(secondaryId);
  });
```

若该测试文件尚未 import `AgentSummary`、`waitFor`、`screen`、`render`、`MemoryRouter`、`useAgentStore` 或未定义 `DEFAULT_AGENT_ID`，按文件现有 import 风格补齐；`DEFAULT_AGENT_ID` 取 `"10000000-0000-4000-8000-000000000011"`。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /tmp/dm-console-work
npx vitest run src/components/AgentSelector/AgentSelector.test.tsx
```

Expected: FAIL，`Alvin` 不在 DOM 中（`visibleAgents` 过滤掉了非默认智能体），且切换后被 effect 重置回默认。

- [ ] **Step 3: 实现最小改动**

`/tmp/dm-console-work/src/components/AgentSelector/index.tsx` 的第 35 至 36 行改为同时取出能力：

```ts
  const {
    selectedAgent,
    agents,
    capabilities,
    setSelectedAgent,
    setAgents,
    refreshAgents,
  } = useAgentStore();
```

第 73 至 76 行的 `visibleAgents` 改为：

```ts
  const visibleAgents = useMemo(() => agents, [agents]);
```

删除第 110 至 115 行的强制回默认 effect（选择兜底已由 store 的 `refreshAgents` 统一处理）：

```ts
  useEffect(() => {
    const defaultAgent = agents.find((agent) => agent.is_default === true);
    if (!defaultAgent || selectedAgent === defaultAgent.id) return;

    setSelectedAgent(defaultAgent.id);
  }, [agents, message, selectedAgent, setSelectedAgent, t]);
```

在 `handlePinAgent` 开头加入能力门（第 166 行的判断改为）：

```ts
      if (
        !capabilities.pin ||
        agent.is_default === true ||
        pinningAgentId !== null
      )
        return;
```

并把该 `useCallback` 的依赖数组改为：

```ts
    [agents, capabilities.pin, loadAgents, message, pinningAgentId, setAgents, t],
```

第 327 行的下拉项内联启停按钮改为受能力控制：

```ts
        {agent.is_default !== true &&
          capabilities.toggle &&
          renderToggleButton(agent, !agent.enabled)}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /tmp/dm-console-work
npx vitest run src/components/AgentSelector/AgentSelector.test.tsx src/stores/agentStore.test.ts
```

Expected: PASS。

- [ ] **Step 5: 重新导出补丁并提交**

```bash
cd /tmp/dm-console-work
git add -A
git diff HEAD > /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch
cd /Users/tang/Documents/DigitalMate
npx vitest run tests/unit/qwenpaw-console-scripts.test.ts
git add patches/qwenpaw-console/0005-agent-scope.patch
git commit -m "feat(P1-14): 后台侧栏可列出并切换非默认智能体"
```

---

### Task 5: 管理页按能力门控并开放非默认编辑

**Files:**
- Modify（补丁内）: `/tmp/dm-console-work/src/pages/Settings/Agents/index.tsx:19-39`、`:113-133`、`:135-176`
- Modify（补丁内）: `/tmp/dm-console-work/src/pages/Settings/Agents/components/AgentTable.tsx:26-36`、`:42-52`、`:71-81`、`:83-103`、`:175-235`、`:269-294`
- Test（补丁内）: `/tmp/dm-console-work/src/pages/Settings/Agents/components/AgentTable.test.tsx`
- Modify: `patches/qwenpaw-console/0005-agent-scope.patch`（重新导出）

**Interfaces:**
- Consumes: Task 3 的 `useAgentStore().capabilities`。
- Produces: `AgentTable` 的 props 由 `secondaryAgentActionsDisabled?: boolean` 改为 `capabilities: AgentCapabilities`（必填）。无其它模块依赖该组件。

- [ ] **Step 1: 写失败测试——能力关闭时禁用写操作、编辑始终可用**

在 `/tmp/dm-console-work/src/pages/Settings/Agents/components/AgentTable.test.tsx` 中，把所有 `secondaryAgentActionsDisabled={...}` 用法替换为 `capabilities={...}`，并追加：

```ts
  it("disables capability-gated actions but keeps editing available", () => {
    const secondaryId = "10000000-0000-4000-8000-000000000012";
    const agents = [
      {
        id: secondaryId,
        name: "Alvin",
        description: "独立的 MaaS 售前解决方案架构师。",
        workspace_dir: "",
        enabled: true,
        pinned: true,
        startup_status: "running",
        is_default: false,
      },
    ] as AgentSummary[];
    const onEdit = vi.fn();

    render(
      <AgentTable
        agents={agents}
        loading={false}
        reordering={false}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onPin={vi.fn()}
        onReorder={vi.fn()}
        capabilities={{
          multi_agent: true,
          create: false,
          import: false,
          clone: false,
          delete: false,
          toggle: false,
          pin: false,
          reorder: false,
        }}
      />,
    );

    const editButton = screen.getByLabelText("agent.edit");
    expect(editButton).not.toBeDisabled();
    fireEvent.click(editButton);
    expect(onEdit).toHaveBeenCalledWith(agents[0]);
  });
```

若文件尚未 import `AgentSummary`、`fireEvent`、`screen`、`render`、`vi`，按现有 import 风格补齐。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /tmp/dm-console-work
npx vitest run src/pages/Settings/Agents/components/AgentTable.test.tsx
```

Expected: FAIL，`AgentTable` 不接受 `capabilities` prop（TypeScript 报错或断言失败）。

- [ ] **Step 3: 实现 AgentTable 改动**

`/tmp/dm-console-work/src/pages/Settings/Agents/components/AgentTable.tsx` 第 18 行 import 补上能力类型：

```ts
import type {
  AgentCapabilities,
  AgentSummary,
} from "../../../../api/types/agents";
```

props 接口第 35 行改为：

```ts
  capabilities: AgentCapabilities;
```

解构第 51 行改为：

```ts
  capabilities,
```

`handleDragEnd` 第 72 行的判断改为：

```ts
    if (!capabilities.reorder) {
      return;
    }
```

拖拽手柄第 93 至 98 行改为：

```ts
              disabled={
                reordering ||
                loading ||
                isDefaultAgent(record) ||
                !capabilities.reorder
              }
```

操作列第 179 至 193 行改为：

```ts
        const toggleDisabled =
          isDefaultAgent(record) ||
          startupInProgress ||
          !capabilities.toggle;
        const deleteDisabled =
          isDefaultAgent(record) ||
          startupInProgress ||
          !capabilities.delete;
        const pinDisabled =
          isDefaultAgent(record) || !capabilities.pin;
        const pinActionLabel = isDefaultAgent(record)
          ? t("agent.defaultPinned")
          : !capabilities.pin
          ? t("agent.secondaryAgentUnsupported")
          : record.pinned
          ? t("agent.unpinAgent")
          : t("agent.pinAgent");
```

置顶按钮第 210 至 215 行改为：

```ts
                disabled={pinDisabled}
                style={pinDisabled ? disabledStyle : iconStyle}
```

编辑按钮第 224 至 234 行改为（编辑对非默认开放，不再受能力门控）：

```ts
              style={iconStyle}
```

并删除该按钮上的 `disabled={secondaryActionsDisabled}` 与 `title={...}` 两个属性。

启停按钮 title 第 258 至 266 行改为：

```ts
                title={
                  isDefaultAgent(record)
                    ? t("agent.defaultNotDisablable")
                    : startupInProgress
                    ? t("agent.status.waitUntilStarted")
                    : !capabilities.toggle
                    ? t("agent.secondaryAgentUnsupported")
                    : undefined
                }
```

删除按钮 title 第 284 至 292 行改为：

```ts
                title={
                  isDefaultAgent(record)
                    ? t("agent.defaultNotDeletable")
                    : startupInProgress
                    ? t("agent.status.waitUntilStarted")
                    : !capabilities.delete
                    ? t("agent.secondaryAgentUnsupported")
                    : undefined
                }
```

- [ ] **Step 4: 实现管理页改动**

`/tmp/dm-console-work/src/pages/Settings/Agents/index.tsx` 删除第 19 行的 `const SECONDARY_AGENT_CAPABILITY = "unsupported";`，把第 32 行改为：

```ts
  const { selectedAgent, capabilities, setSelectedAgent } = useAgentStore();
```

删除第 38 至 39 行的 `secondaryAgentActionsDisabled` 定义。

`handleReorder` 开头（第 113 行之后）加入能力门：

```ts
  const handleReorder = async (activeId: string, overId: string) => {
    if (!capabilities.reorder) {
      return;
    }
```

新建按钮第 142 至 152 行改为：

```ts
            <Tooltip
              title={
                capabilities.create
                  ? undefined
                  : t("agent.secondaryAgentUnsupported")
              }
            >
              <span>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!capabilities.create}
                >
                  {t("agent.create")}
                </Button>
              </span>
            </Tooltip>
```

传给表格的 prop 第 174 行改为：

```ts
          capabilities={capabilities}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /tmp/dm-console-work
npx vitest run src/pages/Settings/Agents
npx tsc --noEmit
```

Expected: 两条命令都 PASS（`tsc` 用于确认 props 类型改动没有遗漏调用点）。

- [ ] **Step 6: 跑通完整 Console 测试与构建**

```bash
cd /tmp/dm-console-work
git add -A
git diff HEAD > /Users/tang/Documents/DigitalMate/patches/qwenpaw-console/0005-agent-scope.patch
cd /Users/tang/Documents/DigitalMate
npm run console:test
npm run console:build
ls public/_admin-console/index.html
```

Expected: `console:test` 在隔离目录内跑通上游加五个补丁的全部前端测试；`console:build` 产出 `public/_admin-console/index.html` 且资源前缀校验通过。两条命令都需要网络。

- [ ] **Step 7: 提交**

```bash
git add patches/qwenpaw-console/0005-agent-scope.patch
git commit -m "feat(P1-14): 后台智能体管理页按后端能力门控并开放非默认编辑"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/prd.md:9`（修订记录）、`docs/prd.md:148`（P1-14 行）
- Modify: `docs/alvin-mvp.md:17-28`（第 2 节）、`docs/alvin-mvp.md:15`（首期不交付清单）
- Modify: `docs/superpowers/specs/2026-07-28-agent-instance-management-design.md`（4.1 节措辞精确化）

**Interfaces:**
- Consumes: Task 1 至 Task 5 的最终行为。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 PRD 的 P1-14 口径**

把 `docs/prd.md:148` 中的 `首期不开放克隆、导入、删除、协作、客户空间、自动报价或多智能体备份恢复` 改为：

```
首期分两步开放后台能力：第一步开放选中非默认智能体、查看与编辑其人设，Alvin 实例由幂等运维脚本创建；第二步再评估任意智能体新建与删除。克隆、导入、删除、启用停用、置顶、排序、协作、客户空间、自动报价与多智能体备份恢复继续关闭，后台按后端上报的能力字段禁用对应控件
```

在 `docs/prd.md` 修订记录顶部（第 9 行之前）插入一条：

```
> - v0.16（2026-07-28）：细化 **P1-14 后台智能体作用域**——管理后台第一步开放选中非默认智能体、查看与编辑其人设与主动性设置，所有 Console 页面跟随选中作用域；可用写操作由后端 `capabilities` 字段统一上报，前端不再硬编码门控。任意智能体新建、删除、克隆、导入、启用停用、置顶、排序继续关闭；Alvin 实例由幂等运维脚本创建，Web 前台聊天继续固定默认智能体。
```

同时把版本号从 `v0.15` 改为 `v0.16`、日期改为 `2026-07-28`。

- [ ] **Step 2: 更新 Alvin 上线手册**

把 `docs/alvin-mvp.md` 第 2 节的第一段（第 19 行）改为：

```
Alvin 实例由幂等运维脚本创建：在生产 web 容器内调用 `createAgentRepository().createAlvin(userId)`，重复执行只会得到同一个 `slug=alvin` 的智能体，且不会重复写入售前 Skill。后台不提供"新建智能体"入口。
```

把第 28 行改为：

```
`GET /api/admin/compat/agents` 应同时返回默认 DigitalMate 和非默认 Alvin，并在顶层返回 `capabilities`。在后台侧栏切换到 Alvin 后，所有页面数据与写入都落在 Alvin 作用域；路径中带 Agent ID 的接口必须与侧栏选中项一致。
```

把第 15 行的首期不交付清单改为：

```
首期不交付任意智能体创建、克隆、导入、删除、启用停用、置顶、排序、多智能体协作、客户空间、自动报价、多智能体备份恢复和自动修改岗位章程。
```

- [ ] **Step 3: 精确化设计规格措辞**

把 `docs/superpowers/specs/2026-07-28-agent-instance-management-design.md` 中 4.1 节的句子

```
收敛为单一常量源，并同时用于列表摘要、详情、创建与更新响应（当前列表摘要不返回该字段，前端因此无从判断能力）。
```

改为：

```
收敛为单一常量源，用于详情、创建与更新响应，并新增到列表响应的顶层（当前列表完全不返回该字段，前端因此无从判断能力）。能力是账号级的，不按实例区分，因此放在列表顶层而不是每个摘要里。
```

- [ ] **Step 4: 提交**

```bash
git add docs/prd.md docs/alvin-mvp.md docs/superpowers/specs/2026-07-28-agent-instance-management-design.md
git commit -m "docs(P1-14): 同步后台智能体作用域第一步口径"
```

---

### Task 7: 全量校验、部署与线上验收

**Files:**
- 无源码改动。产出：`public/_admin-console`（构建产物，git 忽略）、生产环境更新。

**Interfaces:**
- Consumes: Task 1 至 Task 6 的全部提交。
- Produces: 生产可用的"切换到 Alvin 配置钉钉"能力。

- [ ] **Step 1: 本地全量校验**

```bash
cd /Users/tang/Documents/DigitalMate
npm run typecheck
npm test
```

Expected: `typecheck` 无输出错误；`npm test` 171+ 个文件全部通过（若集成测试报共享内存错误，先按 Global Constraints 清理孤立段再重跑）。

- [ ] **Step 2: 推送到 GitHub**

```bash
git push origin main
git log --oneline -1 origin/main
```

Expected: `origin/main` 指向本轮最后一个提交。

- [ ] **Step 3: 打包代码与 Console 产物**

```bash
cd /Users/tang/Documents/DigitalMate
git archive --format=tar.gz -o /tmp/dm-slim.tar.gz HEAD $(git ls-tree --name-only HEAD | grep -Ev '^(docs|vendor)$' | tr '\n' ' ')
tar -czf /tmp/dm-console-artifact.tar.gz public/_admin-console
ls -lh /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz
shasum -a 256 /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz
```

Expected: slim 包约 12 MB，Console 产物包数 MB。记录两个 SHA256 供服务器侧校验。

- [ ] **Step 4: 上传并解包**

```bash
SSH_OPTS="-i /Users/tang/Documents/API-trans/api-key-platform-demo.pem -o IdentitiesOnly=yes -o ControlMaster=auto -o ControlPath=~/.ssh/cm/%r@%h-%p -o ControlPersist=60m"
scp $SSH_OPTS /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz ecs-user@47.88.93.94:/tmp/
ssh $SSH_OPTS ecs-user@47.88.93.94 'set -euo pipefail
cd /home/ecs-user/digitalmate
sha256sum /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz
cp .env /home/ecs-user/dm-env-backup-$(date +%Y%m%d%H%M%S)
tar -xzf /tmp/dm-slim.tar.gz -C /home/ecs-user/digitalmate
rm -rf public/_admin-console
tar -xzf /tmp/dm-console-artifact.tar.gz -C /home/ecs-user/digitalmate
echo CONSOLE_FILES=$(find public/_admin-console -type f | wc -l)
grep -n "PREBUILT_CONSOLE" .env'
```

Expected: 两端 SHA256 一致；`CONSOLE_FILES` 大于 300；`.env` 仍有 `PREBUILT_CONSOLE=1`。先删旧 `public/_admin-console` 再解包，避免新旧 hash 资源混杂。

- [ ] **Step 5: 服务器后台构建并起服务**

```bash
ssh $SSH_OPTS ecs-user@47.88.93.94 'set -euo pipefail
cd /home/ecs-user/digitalmate
sudo docker compose config >/tmp/dm-compose-config.out 2>/tmp/dm-compose-config.err && echo COMPOSE_CONFIG_OK
grep -n "PREBUILT_CONSOLE" /tmp/dm-compose-config.out
rm -f /home/ecs-user/dm-build.log
setsid nohup /home/ecs-user/dm-build.sh > /home/ecs-user/dm-build.log 2>&1 < /dev/null &
sleep 10
tail -5 /home/ecs-user/dm-build.log'
```

随后每 150 秒轮询一次直到出现 `=== DONE`：

```bash
ssh $SSH_OPTS ecs-user@47.88.93.94 'uptime; free -m | head -2; grep -E "=== (BUILD|UP|DONE)" /home/ecs-user/dm-build.log; tail -12 /home/ecs-user/dm-build.log'
```

Expected: `BUILD RC=0`、`UP RC=0`、四个容器 Up；构建期间可用内存不低于 1 GB（`PREBUILT_CONSOLE=1` 只跑 `build:next`）。

- [ ] **Step 6: 线上验收**

```bash
curl -sS -o /dev/null -w "home: %{http_code}\n" --max-time 40 https://ginkgo.xin/home
curl -sS -o /dev/null -w "console asset: %{http_code}\n" --max-time 30 https://ginkgo.xin/_admin-console/index.html
ssh $SSH_OPTS ecs-user@47.88.93.94 'cd /home/ecs-user/digitalmate
sudo docker compose logs web --tail 20
sudo docker compose exec -T postgres psql -U digitalmate -d digitalmate -c "select slug, display_name, is_default, status from digital_agents order by is_default desc;"'
```

Expected: `/home` 与 Console 资源均 200；web 日志出现 `Database migration completed.`；数据库里同时有 `digitalmate` 与 `alvin` 两条活跃记录。

- [ ] **Step 7: 清理临时文件并交付人工验收**

```bash
ssh $SSH_OPTS ecs-user@47.88.93.94 'rm -f /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz; sudo docker image prune -f | tail -1; df -h / | tail -1'
rm -f /tmp/dm-slim.tar.gz /tmp/dm-console-artifact.tar.gz
rm -rf /tmp/dm-console-work
```

交付给用户的人工验收清单：

1. 打开 `https://ginkgo.xin/admin`，侧栏能看到 DigitalMate 与 Alvin 两项。
2. 切到 Alvin，"智能体"管理页的编辑按钮可用，新建、删除、启停、置顶、拖拽排序均为禁用并显示不支持提示。
3. 在 Alvin 作用域下新建钉钉连接，填入 `client_id`、`client_secret`、`allow_from`、`admin_from`、`require_mention` 后保存成功。
4. 切回 DigitalMate，确认看不到该钉钉连接。

---

## 自审记录

**规格覆盖**：设计规格 4.1（能力收敛与扩展）→ Task 1；4.2（按 slug 描述）→ Task 1；4.3（不改 features.ts）→ Global Constraints；第 5 节五个前端文件与补丁生成方式 → Task 2 至 Task 5；第 6 节错误处理沿用既有语义，不新增代码 → 由 Task 3 的 store 兜底与既有后端行为共同满足，Task 5 Step 6 的 `console:test` 覆盖；第 7 节测试 → Task 1/2/3/4/5 的分步测试加 Task 7 Step 1 全量；第 8 节文档与上线 → Task 6 与 Task 7。

**类型一致性**：`AgentCapabilities` 八个字段在 Task 1（后端常量）、Task 3（前端类型与 store）、Task 4（选择器读 `toggle`/`pin`）、Task 5（表格读 `reorder`/`toggle`/`delete`/`pin`，页面读 `create`/`reorder`）中保持同名同义；`markValidatedAgents(agentIds, defaultAgentId)` 在 Task 2 定义、Task 3 调用，签名一致；`AgentTable` 的 `capabilities` prop 在 Task 5 内定义与消费。

**已知未覆盖项（有意为之）**：`playwright.admin-cutover.config.ts` 相关 E2E 未纳入分步任务，改为在 Task 7 Step 1 的全量校验中观察；若其断言依赖"只存在默认智能体"，在该步一并修正。列表摘要的 `pinned` 继续对所有智能体返回 `true`，因为置顶能力本期关闭，改动其语义属于第二步范围。
