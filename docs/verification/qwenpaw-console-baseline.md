# QwenPaw Console M0–M1 基线

- 记录日期：2026-07-24
- 适用范围：Foundation 任务 6（`/admin-preview` 导航与视觉基线）
- Node.js：`v22.22.3`
- npm：`10.9.8`
- 上游 tag：`v2.0.0.post3`
- 上游 commit：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`
- 上游目录 SHA-256：`04459760c48b596c2521dbfcd182660c5784adbecc654ed98d3eb4dc7e85a53a`

## 本任务新鲜证据

| 验证项 | 命令 | 结果 |
|---|---|---|
| RED：初始导航与视觉测试 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts` | 27/29 通过；主题变量缺失、截图基线缺失，符合预期 |
| RED：可重放主题补丁契约 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts -t '真实验证并应用四个补丁'` | 先因 `--dm-color-primary` 缺失失败；补齐变量后通过 |
| RED：实际页面背景 | 同上 | 先因上游显式 `#f9f8f4` 覆盖暖白 token 失败；改为 `--dm-color-bg-layout` 后通过 |
| RED：未知路由与响应式 Chat 入口 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep 'Chat 入口\|未知路由'` | 1/6 通过、5/6 失败：三个视口的旧外壳断言均误收未知路由；iPad 与手机因折叠按钮无业务可访问名称而误点“心跳” |
| RED：折叠导航可访问名称补丁契约 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts -t '真实验证并应用四个补丁'` | 先因 `Sidebar.tsx` 缺少 `aria-label={String(item.label)}` 失败；补齐可重放补丁后通过 |
| RED：页面身份与规范化 URL | 同上及完整 E2E | 补丁契约先因页面身份缺失失败；首次完整 E2E 78/90 通过，暴露 `/ACP` 未规范化及三个 M2 重试态页面无标题 |
| RED：响应式项目误扩散 | `npx playwright test tests/e2e/chat.spec.ts --list` | 修复前列出 9 项：Desktop Chrome、iPad Mini、Mobile Chrome 各运行 3 条 chat 用例 |
| RED：项目选择配置守护 | `npm test -- --run tests/unit/playwright-config.test.ts` | 修复前 1/3 通过；iPad Mini 与 Mobile Chrome 均因 `testMatch` 缺失失败 |
| RED：非 ACP 路由大小写语义 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep '深层刷新 /models'` | 修复前 0/3 通过；三个视口的 `/MODELS` 都得到带 `core.models` 身份的空页面 |
| RED：安全标签与局部大小写补丁契约 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts -t '真实验证并应用四个补丁'` | 先因 ReactNode 安全标签回退及 ACP 专属 `caseSensitive` 表达式缺失失败；补齐后通过 |
| Playwright 项目列表 | `npx playwright test tests/e2e/chat.spec.ts --list`；`npx playwright test tests/e2e/admin-console-preview.spec.ts --list` | chat 仅 Desktop Chrome 3 项；Console preview 三项目共 90 项 |
| 项目选择配置守护 | `npm test -- --run tests/unit/playwright-config.test.ts` | 3/3 通过 |
| 既有 chat app E2E | `npm run test:e2e:app -- tests/e2e/chat.spec.ts` | 仅 Desktop Chrome 运行，3/3 通过，耗时 49.7 秒 |
| `/models` 大小写兼容 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep '深层刷新 /models'` | 三个视口 3/3 通过；每项同时验证 `/models` 与 `/MODELS` 非空渲染，耗时 44.1 秒 |
| 关键路由、负向护栏与 Chat | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep '深层刷新 /ACP\|深层刷新 /models\|深层刷新 /agent-config\|深层刷新 /security\|Chat 入口\|未知路由'` | 21/21 通过，耗时 48.9 秒 |
| Console 脚本与补丁回归 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts` | 153/153 通过，耗时 27.56 秒 |
| 三视口截图刷新 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --update-snapshots` | 90/90 通过，耗时约 1.2 分钟；截图像素未变化 |
| 三视口普通复验 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts` | 90/90 通过；同一 `/models` 用例包含大写路径回归，耗时 2.2 分钟 |
| TypeScript | `npm run typecheck` | 退出码 0 |
| 改动文件 lint | `npm run lint -- playwright.config.ts tests/e2e/admin-console-preview.spec.ts tests/e2e/admin-console.routes.ts tests/unit/qwenpaw-console-scripts.test.ts tests/unit/playwright-config.test.ts` | 退出码 0 |
| 补丁空白检查 | `git diff --check` | 退出码 0 |

Playwright 的 `webServer` 在每轮 E2E 启动前执行 `npm run console:build`；上述两轮 90 项验证均成功完成 Console 构建后才启动应用。构建存在上游既有 peer dependency、循环 chunk 和大 chunk 警告，没有构建失败。

## 导航与交互基线

- `tests/e2e/admin-console.routes.ts` 固定 26 个上游内置路由，并为 25 个非 Chat 页面逐项声明期望 URL、稳定路由 ID 与页面文本。
- 除 `/chat` 外的 25 个 Console 路由均在 Desktop Chrome、iPad Mini、Mobile Chrome 下完成鉴权后的深层刷新，共 75 个路由用例；每项同时断言精确 URL、`data-console-route`、非空页面和稳定文本，不再以 Console 外壳出现作为成功。
- `/admin-preview/` 规范化到 `/admin-preview/inbox`；大小写别名 `/admin-preview/ACP` 规范化到 `/admin-preview/acp`。两条 ACP 注册路由采用大小写敏感匹配，确保别名重定向不会被前置 `/acp` 路由截获。
- 大小写敏感只应用于已确认的 `core.acp` 与 `core.acp-alias` 两条路由；其他内置路由和插件路由保持上游默认的大小写不敏感语义。`/admin-preview/MODELS` 在三个视口均继续渲染 `core.models` 页面且保持非空。
- 未知路由在三个视口均保持原 URL，页面容器为空；负向用例证明它不能满足任一注册页面基线。
- `/chat` 不创建第二套后台聊天：三个视口直接刷新 `/admin-preview/chat` 均跳转 `/`；三个视口也都会点击各自响应式 Console Chat 入口并验证同一行为。折叠侧栏按钮通过可访问名称稳定暴露业务含义。
- 折叠侧栏的可访问名称仅直接采用字符串标签；若插件提供 ReactNode 标签，则稳定回退到 route key，避免暴露 `[object Object]`。
- Desktop Chrome 继续运行全部 app E2E；iPad Mini 与 Mobile Chrome 通过项目级 `testMatch` 只运行 `admin-console-preview.spec.ts`，避免与 Desktop 并发共享 seeded 用户、会话和附件数据。
- `/admin-preview` 使用真实 `/api/login` 生成的 `dm_session`。尚属 M2 的 `/api/admin/compat/auth/status` 只在该 E2E 内做局部浏览器 mock，没有新增兼容 API。
- 模型、运行配置与安全页依赖的 M2 API 尚未实现，当前基线明确断言对应路由 ID、非空重试态与规范 URL；没有用额外浏览器 mock 伪造页面数据。
- 旧 `/admin` 在三个项目中均断言 `.admin-shell` 和“管理后台”标题，仍由现有 Next 页面提供，没有发生正式切换。
- 主题断言同时检查 `--dm-color-primary: #E8684A` 与实际 Console layout 背景 `rgb(250, 247, 242)`。

## 三视口截图

| 项目 | 视口 | 快照 |
|---|---:|---|
| Desktop Chrome | 1280 × 720 | `admin-console-inbox-Desktop-Chrome-darwin.png` |
| iPad Mini | 768 × 1024 | `admin-console-inbox-iPad-Mini-darwin.png` |
| Mobile Chrome | 393 × 873 | `admin-console-inbox-Mobile-Chrome-darwin.png` |

截图固定为收件箱布局，禁用动画、过渡和光标；时间、随机标识、连接状态及 M2 API 尚未接入时产生的瞬时消息只在截图层隐藏。此次刷新确认三张截图像素未变化。测试仍会等待真实 Console shell、`core.inbox` 页面身份与收件箱内容，不以空 `#root` 或空页面容器作为通过条件。

## M0–M1 总验证边界

本文件在任务 6 只记录导航、视觉和相关静态检查，不把任务 7 的总验证提前标记为完成。

| 总验证项 | 当前状态 |
|---|---|
| 固定 Console 上游测试数量 | 既有 Foundation 基线为 1165 项；任务 7 将重新执行并写入新鲜结果 |
| 根 `npm test` | 待任务 7 新鲜执行 |
| 根 `npm run build` | 待任务 7 新鲜执行；本任务只确认 E2E 前置的 Console build |
| `npm run console:verify-upstream` | 待任务 7 新鲜执行 |
| 许可与构建产物品牌扫描 | 待任务 7 新鲜执行 |
