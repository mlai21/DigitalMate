# 聊天滚动与防遮挡实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让聊天框任何高度都不遮挡消息，并在用户阅读历史时保持视口、以“新消息”按钮代替强制滚到底部。

**架构：** 将 `.messages` 变成会话内唯一滚动容器，输入框相对 `.chat-stage` 底部定位并用 `ResizeObserver` 提供实时留白。新增独立的滚动控制 Hook：首次载入定位到底部，靠近底部时自然跟随，离开底部后只累计新消息 ID，不因流式片段更新重复计数。

**技术栈：** React 19、TypeScript、CSS、Vitest、Testing Library、Playwright

---

## 文件结构

- 创建 `src/components/chat/chat-scroll-state.ts`：80px 阈值、底部距离、新消息 ID 去重等纯函数。
- 创建 `src/components/chat/use-chat-scroll.ts`：封装 DOM 滚动监听、首次定位、跟随状态、新消息计数和跳转操作。
- 创建 `tests/unit/chat-scroll-state.test.ts`：纯状态逻辑单测。
- 修改 `src/components/chat/chat-shell.tsx`：接入滚动 Hook、独立滚动容器和新消息按钮，移除无条件 `scrollIntoView`。
- 修改 `src/app/globals.css`：固定会话视口、消息容器滚动、输入框相对定位、新消息按钮与响应式规则。
- 修改 `tests/unit/chat-ui.test.tsx`：组件层验证流式去重、会话切换和按钮交互。
- 修改 `tests/e2e/chat.spec.ts`：浏览器验证防遮挡、保持历史位置和点击跳转。
- 修改 `DESIGN.md`：把“自动滚到底部”改为已确认的条件式跟随规则。

### 任务 1：建立可测试的滚动状态规则

**文件：**
- 创建：`src/components/chat/chat-scroll-state.ts`
- 创建：`tests/unit/chat-scroll-state.test.ts`

- [ ] **步骤 1：编写底部判定和新消息去重的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { collectUnreadMessageIds, isNearChatBottom } from "@/components/chat/chat-scroll-state";

describe("chat scroll state", () => {
  it("treats at most 80px as near the bottom", () => {
    expect(isNearChatBottom({ scrollHeight: 1000, scrollTop: 620, clientHeight: 300 })).toBe(true);
    expect(isNearChatBottom({ scrollHeight: 1000, scrollTop: 619, clientHeight: 300 })).toBe(false);
  });

  it("counts a streaming message id once even when its content changes", () => {
    const seen = new Set(["assistant-stream"]);
    const next = collectUnreadMessageIds(seen, ["assistant-stream", "assistant-next"]);
    expect([...next]).toEqual(["assistant-stream", "assistant-next"]);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/chat-scroll-state.test.ts`

预期：FAIL，提示无法解析 `@/components/chat/chat-scroll-state`。

- [ ] **步骤 3：实现最小纯函数**

```ts
export const CHAT_BOTTOM_THRESHOLD_PX = 80;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isNearChatBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
}

export function collectUnreadMessageIds(current: ReadonlySet<string>, ids: string[]): Set<string> {
  const next = new Set(current);
  for (const id of ids) next.add(id);
  return next;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- tests/unit/chat-scroll-state.test.ts`

预期：2 个测试 PASS。

- [ ] **步骤 5：提交**

```bash
git add src/components/chat/chat-scroll-state.ts tests/unit/chat-scroll-state.test.ts
git commit -m "test(P0-10): 固化聊天滚动状态规则"
```

### 任务 2：实现滚动控制 Hook

**文件：**
- 创建：`src/components/chat/use-chat-scroll.ts`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：为 Hook 行为编写失败的组件测试**

在 `tests/unit/chat-ui.test.tsx` 中增加 `ChatScrollHarness`，传入消息 ID 列表并渲染 Hook 返回的计数与按钮：

```tsx
function ChatScrollHarness({ conversationId, messageIds }: { conversationId: string; messageIds: string[] }) {
  const scroll = useChatScroll({ conversationId, messageIds });
  return (
    <div ref={scroll.containerRef} data-testid="scroll-container">
      <span data-testid="unread-count">{scroll.unreadCount}</span>
      <button onClick={scroll.jumpToLatest}>到最新</button>
      <div ref={scroll.endRef} />
    </div>
  );
}
```

测试必须覆盖：初次载入调用无动画跳转；离开底部后新增同一 ID 的内容更新不增加计数；新增第二个 ID 后计数为 2；点击按钮清零；切换 `conversationId` 清零。

- [ ] **步骤 2：运行组件测试确认失败**

运行：`npm test -- tests/unit/chat-ui.test.tsx`

预期：FAIL，提示 `use-chat-scroll` 不存在。

- [ ] **步骤 3：实现 Hook**

Hook 对外类型固定为：

```ts
export function useChatScroll(input: {
  conversationId?: string;
  messageIds: string[];
}): {
  containerRef: RefObject<HTMLDivElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  unreadCount: number;
  jumpToLatest: () => void;
};
```

实现要求：

```ts
const followLatestRef = useRef(true);
const previousIdsRef = useRef(new Set<string>());
const unreadIdsRef = useRef(new Set<string>());

function jumpToLatest() {
  endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  followLatestRef.current = true;
  unreadIdsRef.current.clear();
  setUnreadCount(0);
}
```

滚动监听用 `isNearChatBottom(container)` 更新 `followLatestRef`；消息变化时只取 `previousIdsRef` 中不存在的 ID。若处于底部，用 `requestAnimationFrame` 滚到末端；若处于历史区，将新 ID 放入 Set 后更新计数。同一 ID 的流式内容变化不会进入新集合。首次挂载和会话 ID 变化时用 `behavior: "auto"` 定位到底部并重置两个 Set。

- [ ] **步骤 4：运行组件测试确认通过**

运行：`npm test -- tests/unit/chat-ui.test.tsx`

预期：新增滚动测试和原有 ChatInput/MessageBubble 测试全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add src/components/chat/use-chat-scroll.ts tests/unit/chat-ui.test.tsx
git commit -m "feat(P0-10): 增加用户可控的聊天滚动状态"
```

### 任务 3：接入 ChatShell 并移除强制滚动

**文件：**
- 修改：`src/components/chat/chat-shell.tsx`
- 修改：`tests/unit/chat-ui.test.tsx`

- [ ] **步骤 1：编写新消息按钮的失败测试**

渲染 `ChatShell`，模拟滚动容器离底部超过 80px，然后让轮询返回一个新消息。断言：

```ts
expect(await screen.findByRole("button", { name: "查看 1 条新消息" })).toBeInTheDocument();
expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));

fireEvent.click(screen.getByRole("button", { name: "查看 1 条新消息" }));
expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- tests/unit/chat-ui.test.tsx`

预期：FAIL，页面不存在“查看 1 条新消息”按钮。

- [ ] **步骤 3：接入 Hook 和按钮**

在 `ChatShell` 中：

```tsx
const chatScroll = useChatScroll({
  conversationId: activeConversationId,
  messageIds: messages.map((message) => message.id),
});
```

将 `chatScroll.containerRef` 绑定到 `.messages`，`chatScroll.endRef` 绑定到 `.chat-scroll-anchor`。删除原先依赖 `[messages, isStreaming]` 的无条件 `scrollIntoView` effect。输入框前增加：

```tsx
{chatScroll.unreadCount > 0 ? (
  <button
    type="button"
    className="new-message-button"
    aria-label={`查看 ${chatScroll.unreadCount} 条新消息`}
    onClick={chatScroll.jumpToLatest}
  >
    ↓ {chatScroll.unreadCount} 条新消息
  </button>
) : null}
```

保留现有输入框高度 `ResizeObserver`，但让它只更新 `--chat-input-clearance`，不负责滚动。

- [ ] **步骤 4：运行相关测试**

运行：`npm test -- tests/unit/chat-scroll-state.test.ts tests/unit/chat-ui.test.tsx`

预期：全部 PASS，原有搜索开关、Skill 和乐观消息合并测试不回归。

- [ ] **步骤 5：提交**

```bash
git add src/components/chat/chat-shell.tsx tests/unit/chat-ui.test.tsx
git commit -m "fix(P0-10): 新消息到达时不打断历史阅读"
```

### 任务 4：改造布局并完成浏览器验收

**文件：**
- 修改：`src/app/globals.css`
- 修改：`tests/e2e/chat.spec.ts`

- [ ] **步骤 1：把旧的自动滚动 E2E 改成三个失败场景**

测试场景：

1. 将输入框高度设为 168px 后，最后一条消息底部仍至少比输入框顶部高 8px。
2. 把 `.messages.scrollTop` 移到历史位置，再通过 Playwright 拦截 `/api/messages` 返回一个新消息，`scrollTop` 保持不变且按钮出现；不得只向 DOM 手工 append，因为那不会经过 React 滚动状态机。
3. 点击按钮后，列表距底部不超过 2px且按钮消失。

核心断言：

```ts
expect(latestBubbleBox!.y + latestBubbleBox!.height).toBeLessThanOrEqual(inputBox!.y - 8);
expect(afterScrollTop).toBe(beforeScrollTop);
await expect(page.getByRole("button", { name: /查看 1 条新消息/ })).toBeVisible();
expect(await page.locator(".messages").evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
```

- [ ] **步骤 2：运行 E2E 确认失败**

运行：`npm run test:e2e -- tests/e2e/chat.spec.ts`

预期：至少布局或新消息按钮场景 FAIL。

- [ ] **步骤 3：实现稳定布局 CSS**

关键规则：

```css
.chat-stage {
  position: relative;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.chat-stage .messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: var(--chat-input-clearance, 128px);
  scrollbar-gutter: stable;
}

.chat-input-shell {
  position: absolute;
  left: 50%;
  bottom: max(24px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
}

.new-message-button {
  position: absolute;
  left: 50%;
  bottom: calc(var(--chat-input-clearance, 128px) - 12px);
  transform: translateX(-50%);
  z-index: 6;
}
```

移动端把底部偏移改为 `max(12px, env(safe-area-inset-bottom))`，按钮维持 44px 最小高度。不得使用弹跳动画。

- [ ] **步骤 4：运行 E2E 与单测确认通过**

运行：`npm test -- tests/unit/chat-scroll-state.test.ts tests/unit/chat-ui.test.tsx && npm run test:e2e -- tests/e2e/chat.spec.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add src/app/globals.css tests/e2e/chat.spec.ts
git commit -m "fix(P0-10): 聊天框动态增高时为消息保留空间"
```

### 任务 5：同步设计规范并做回归验证

**文件：**
- 修改：`DESIGN.md`

- [ ] **步骤 1：修订相冲突的滚动规则**

将“键盘弹起时消息列表自动滚到底部”改为：

```md
- 键盘弹起时输入栏跟随上移；仅当用户原本位于会话底部附近时继续跟随最新消息。用户正在阅读历史内容时不得强制滚动，应显示“新消息”按钮供用户主动跳转。
```

在输入栏规则增加：

```md
- 输入栏增高时，消息列表必须按输入栏实时高度预留底部空间，禁止覆盖最后一条消息。
```

- [ ] **步骤 2：运行完整静态验证**

运行：`npm run lint && npm run typecheck && npm test && npm run build`

预期：四条命令退出码均为 0。

- [ ] **步骤 3：检查差异范围**

运行：`git diff --check && git status --short`

预期：无空白错误，只包含本计划列出的文件。

- [ ] **步骤 4：提交**

```bash
git add DESIGN.md
git commit -m "docs(P0-10): 明确聊天滚动与防遮挡规范"
```
