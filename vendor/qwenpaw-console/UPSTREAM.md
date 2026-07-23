# QwenPaw Console 固定上游快照

- Repository: https://github.com/agentscope-ai/QwenPaw.git
- Tag: v2.0.0.post3
- Commit: fef7e64d984f4332d0b84a343cd209bd3ea5d316
- Retrieved: 2026-07-23
- Directory SHA-256: 04459760c48b596c2521dbfcd182660c5784adbecc654ed98d3eb4dc7e85a53a
- Local modifications: 仅路径筛选与 reference/ 映射；载荷内容未修改

目录哈希为按 POSIX 相对路径排序后的载荷 `SHA256SUMS` 内容的 SHA-256。
`UPSTREAM.md` 与 `SHA256SUMS` 属于元数据，不计入载荷哈希。

## 构建后保留的内部兼容标识

DigitalMate 在构建时通过 `patches/qwenpaw-console/` 应用品牌、主题、路由和 API
兼容补丁。为保持固定上游的插件与浏览器状态兼容，构建产物仍保留以下内部标识：

- `window.QwenPaw`：上游插件 Host ABI；现有插件仍通过该全局对象注册菜单、路由、Slot
  和工具渲染器。
- `qwenpaw-*` / `qwenpaw_*`：上游 CSS 命名空间、浏览器存储键和兼容 API
  字段，例如 `qwenpaw-theme`、`qwenpaw-agent-storage` 与
  `qwenpaw_compat_labels`。重命名会破坏样式、用户本地状态或插件市场协议。
- `[QwenPaw]`、`[QwenPaw audit]` 与 `[QwenPaw registry]`：仅用于浏览器开发者
  控制台的内部诊断标签。
- 上游仓库与文档 URL：用于许可证、来源和兼容性追踪，不作为 DigitalMate 产品入口。

上游多语言资源中的 `QwenPaw` 源字符串在 bundle 中保留，由全局 i18n
后处理器在渲染前统一替换为 `DigitalMate`。`Qwen/Qwen3-0.6B-GGUF`
等字符串是模型仓库示例 ID，不属于产品品牌。上述标识不得用于用户可见品牌文案。
