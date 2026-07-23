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
| Console 脚本与补丁回归 | `npm test -- --run tests/unit/qwenpaw-console-scripts.test.ts` | 153/153 通过，耗时 27.43 秒 |
| 三视口截图生成 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --update-snapshots` | 87/87 通过，耗时约 1.2 分钟 |
| 三视口普通复验 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts` | 87/87 通过，耗时约 1.2 分钟 |
| Chat 深层刷新与桌面入口加固 | `npm run test:e2e:app -- tests/e2e/admin-console-preview.spec.ts --grep 'Chat 入口'` | 3/3 通过，耗时 38.9 秒 |
| TypeScript | `npm run typecheck` | 退出码 0 |
| 改动文件 lint | `npm run lint -- playwright.config.ts tests/e2e/admin-console-preview.spec.ts tests/e2e/admin-console.routes.ts tests/unit/qwenpaw-console-scripts.test.ts` | 退出码 0 |

Playwright 的 `webServer` 在每轮 E2E 启动前执行 `npm run console:build`；上述两轮 87 项验证均成功完成 Console 构建后才启动应用。构建存在上游既有 peer dependency、循环 chunk 和大 chunk 警告，没有构建失败。

## 导航与交互基线

- `tests/e2e/admin-console.routes.ts` 固定 26 个上游内置路由。
- 除 `/chat` 外的 25 个 Console 路由均在 Desktop Chrome、iPad Mini、Mobile Chrome 下完成鉴权后的深层刷新，共 75 个路由用例。
- `/chat` 不创建第二套后台聊天：三个视口直接刷新 `/admin-preview/chat` 均跳转 `/`；桌面另行点击 Console 的 Chat 按钮验证同一行为。
- `/admin-preview` 使用真实 `/api/login` 生成的 `dm_session`。尚属 M2 的 `/api/admin/compat/auth/status` 只在该 E2E 内做局部浏览器 mock，没有新增兼容 API。
- 旧 `/admin` 在三个项目中均断言 `.admin-shell` 和“管理后台”标题，仍由现有 Next 页面提供，没有发生正式切换。
- 主题断言同时检查 `--dm-color-primary: #E8684A` 与实际 Console layout 背景 `rgb(250, 247, 242)`。

## 三视口截图

| 项目 | 视口 | 快照 |
|---|---:|---|
| Desktop Chrome | 1280 × 720 | `admin-console-inbox-Desktop-Chrome-darwin.png` |
| iPad Mini | 768 × 1024 | `admin-console-inbox-iPad-Mini-darwin.png` |
| Mobile Chrome | 393 × 873 | `admin-console-inbox-Mobile-Chrome-darwin.png` |

截图固定为收件箱布局，禁用动画、过渡和光标；时间、随机标识、连接状态及 M2 API 尚未接入时产生的瞬时消息只在截图层隐藏。测试仍会等待真实 Console shell 与收件箱内容，不以空 `#root` 作为通过条件。

## M0–M1 总验证边界

本文件在任务 6 只记录导航、视觉和相关静态检查，不把任务 7 的总验证提前标记为完成。

| 总验证项 | 当前状态 |
|---|---|
| 固定 Console 上游测试数量 | 既有 Foundation 基线为 1165 项；任务 7 将重新执行并写入新鲜结果 |
| 根 `npm test` | 待任务 7 新鲜执行 |
| 根 `npm run build` | 待任务 7 新鲜执行；本任务只确认 E2E 前置的 Console build |
| `npm run console:verify-upstream` | 待任务 7 新鲜执行 |
| 许可与构建产物品牌扫描 | 待任务 7 新鲜执行 |
