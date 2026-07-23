# QwenPaw Console M0–M1 基线

- 记录日期：2026-07-24
- 适用范围：Foundation 任务 6–7（`/admin-preview` 导航与视觉基线、M0–M1 总验证）
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
| RED：可见品牌自动化契约 | 临时在现有路由循环中注入可见 `QwenPaw`，再运行 `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep 'Console 深层刷新 /inbox$'` | 三个视口 0/3 通过、退出码 1；均由新增的 `body` 可见文本断言捕获，证明契约会对泄漏报错 |
| GREEN：可见品牌自动化契约 | 移除临时故障注入后，运行 `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep 'Console 深层刷新 /inbox$'` | 三个视口 3/3 通过、退出码 0，耗时 37.8 秒 |
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

## M0–M1 总验证新鲜证据

以下结果均于 2026-07-24 在 `codex/qwenpaw-console` 分支重新执行。退出码来自完整命令，
没有用历史结果替代。

| 验证项 | 精确命令 | 退出码 | 数量 / 结果摘要 |
|---|---|---:|---|
| 固定上游校验 | `npm run console:verify-upstream` | 0 | commit `fef7e64d984f4332d0b84a343cd209bd3ea5d316`；864 个文件通过快照校验 |
| Console 全量测试 | `npm run console:test` | 0 | 131 个测试文件、1165 项测试全部通过；测试后的 Console 生产构建成功 |
| Console 独立构建 | `npm run console:build` | 0 | TypeScript 与 Vite 生产构建成功，转换 15110 个模块；静态产物原子发布到 `public/_admin-console` |
| 根 TypeScript | `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| 根全量测试 | `npm test` | 0 | 83 个测试文件、828 项测试全部通过 |
| Console 三视口 E2E | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts` | 0 | Desktop Chrome、iPad Mini、Mobile Chrome 共 90/90 通过，耗时 1.3 分钟；其中 25 个非 Chat 路由 × 3 个视口包含 75 次可见 `QwenPaw` 负向断言 |
| 根生产构建 | `npm run build` | 0 | 再次完成 Console 构建；Next.js 生产编译、TypeScript、34 个静态页面生成和路由收集全部成功 |
| 空白检查 | `git diff --check` | 0 | 执行总验证后与文档更新后复验均无空白错误 |

Console 构建继续报告上游既有 peer dependency、循环 chunk、大 chunk 与多 lockfile
提示；这些均为 warning，所有独立构建命令和根构建的最终退出码均为 0。
临时上游依赖安装的 `npm audit` 摘要为 29 项（1 low、11 moderate、17 high）；
固定上游依赖未在本验收任务中升级，该结果作为后续上游依赖安全评审输入保留。

根 `vitest.config.ts` 明确排除 `.worktrees/**` 与 `vendor/**`，
`tests/unit/vitest-config.test.ts` 对该边界有回归断言。本轮根测试只运行仓库自身的
83 个测试文件，没有扫描固定上游或其他工作树。

## 许可、哈希与品牌核对

| 核对项 | 精确命令 | 退出码 | 结果 |
|---|---|---:|---|
| 许可与元数据存在 | `test -f vendor/qwenpaw-console/LICENSE && test -f vendor/qwenpaw-console/UPSTREAM.md && test -f vendor/qwenpaw-console/SHA256SUMS` | 0 | Apache License 2.0、来源说明与哈希清单齐全 |
| 清单摘要与逐文件校验 | `shasum -a 256 vendor/qwenpaw-console/SHA256SUMS && (cd vendor/qwenpaw-console && shasum -a 256 -c SHA256SUMS --quiet)` | 0 | 864 项逐一通过；清单 SHA-256 为 `04459760c48b596c2521dbfcd182660c5784adbecc654ed98d3eb4dc7e85a53a`，与 `UPSTREAM.md` 一致 |
| 构建产物原始品牌扫描 | `rg -n -e 'QwenPaw' -e 'Qwen' public/_admin-console --glob '*.js' --glob '*.html'` | 0 | 仅 1 个主 bundle 命中；分类如下 |
| `QwenPaw` 原始命中计数 | `rg -o 'QwenPaw' public/_admin-console --glob '*.js' --glob '*.html' \| wc -l` | 0 | 97 次 |
| 独立 `Qwen` 原始命中计数 | `rg -o --pcre2 'Qwen(?!Paw)' public/_admin-console --glob '*.js' --glob '*.html' \| wc -l` | 0 | 14 次 |

原始 bundle 的品牌命中分类：

- 69 次 `QwenPaw` 位于固定上游的多语言资源源字符串。全局
  `digitalmateBrand` i18n 后处理器在渲染前替换为 `DigitalMate`。
- 21 次 `window.QwenPaw` 是上游插件 Host ABI，必须为插件兼容保留。
- 5 次是浏览器开发者控制台诊断标签：`QwenPaw audit` 2 次、
  `QwenPaw registry` 1 次、`[QwenPaw]` 2 次。
- 1 次是上游 GitHub 来源 URL，1 次是运行时品牌替换器自身的匹配表达式。
- 14 次 `Qwen` 均来自 7 个 `Qwen/Qwen3-0.6B-GGUF` 模型仓库示例 ID；
  每个 ID 含 2 次 `Qwen`，属于模型专名而非 Console 产品品牌。

现有 Playwright 路由循环会在页面身份与规范 URL 断言后，检查 `body` 可见文本不含
`QwenPaw`。25 个非 Chat 内置路由在 Desktop Chrome、iPad Mini、Mobile Chrome
下共执行 75 次页面级品牌断言，且包含在上述可重复运行的 90 项 E2E 中。该断言只禁止
Console 产品品牌 `QwenPaw`，不禁止模型专名中的独立 `Qwen`。
构建产物中的必要兼容标识已列入
`vendor/qwenpaw-console/UPSTREAM.md`，不作为用户可见品牌使用。

`git ls-files public/_admin-console | wc -l` 返回 0，
`git status --ignored --short public/_admin-console` 将目录标记为 `!!`；构建产物未进入
Git。总验证开始前工作树干净，构建与 E2E 没有产生待提交文件。

## 导航与交互基线

- `tests/e2e/admin-console.routes.ts` 固定 26 个上游内置路由，并为 25 个非 Chat 页面逐项声明期望 URL、稳定路由 ID 与页面文本。
- 除 `/chat` 外的 25 个 Console 路由均在 Desktop Chrome、iPad Mini、Mobile Chrome 下完成鉴权后的深层刷新，共 75 个路由用例；每项同时断言精确 URL、`data-console-route`、非空页面、稳定文本和无可见 `QwenPaw`，不再以 Console 外壳出现作为成功。
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

## M0–M1 总验证结论与回滚边界

| 总验证项 | 新鲜结果 |
|---|---|
| 固定 Console 上游 | commit、864 项哈希与目录摘要一致 |
| Console 测试与构建 | 1165/1165 通过；独立生产构建退出码 0 |
| 根工程 | TypeScript 退出码 0；828/828 测试通过；生产构建退出码 0 |
| 三视口预览 | 90/90 通过；26 个内置路由、Chat 跳转、主题、截图和旧后台边界均受保护 |
| 许可与品牌 | Apache License 2.0 与来源元数据齐全；25 个非 Chat 路由 × 3 个视口自动断言无可见 `QwenPaw` |
| 构建产物 | `public/_admin-console` 被 Git 忽略，0 个文件受跟踪 |

本里程碑没有切换正式 `/admin`，旧后台仍由现有 Next 页面提供。当前新增运行入口仅为
`/admin-preview`；若需回滚，可删除该预览路由和忽略的静态产物，现有 `/admin` 与数据库
均不受影响。M2 兼容 API 与真实数据映射仍未实现，本次验收没有把局部 E2E auth mock
扩展为产品 API，也没有解冻 P2 功能。
