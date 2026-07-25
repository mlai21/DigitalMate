# M4 渠道 SDK 依赖审计

审计日期：2026-07-26

## 固定版本与许可证

| 依赖 | 固定版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `ws` | `8.21.1` | MIT | Mattermost、QQ 等 WebSocket 协议 |
| `discord.js` | `14.27.0` | Apache-2.0 | Discord Gateway 与 REST |
| `@slack/bolt` | `5.0.0` | MIT | Slack Socket Mode |
| `@larksuiteoapi/node-sdk` | `1.71.1` | MIT | 飞书/Lark WebSocket 与 OpenAPI |
| `dingtalk-stream-sdk-nodejs` | `2.0.4` | MIT | 钉钉 Stream |
| `mqtt` | `5.15.2` | MIT | MQTT Broker 连接、订阅与发布 |
| `matrix-js-sdk` | `41.9.0` | Apache-2.0 | Matrix Sync、房间消息与端到端加密 |
| `fake-indexeddb` | `6.2.5` | Apache-2.0 | 为 Node 版 Matrix Rust Crypto 提供可加密落盘的 IndexedDB 兼容层 |
| `@wecom/aibot-node-sdk` | `1.0.7` | MIT | 企业微信智能机器人长连接 |
| `protobufjs` | `8.7.1` | BSD-3-Clause | 腾讯元宝固定描述符编解码 |
| `undici` | `7.28.0` | MIT | 渠道 HTTP 连接与受控代理 |
| `@types/ws` | `8.18.1` | MIT | WebSocket TypeScript 类型 |

版本和许可证均由 npm registry 逐项核对。`fake-indexeddb` 是 Matrix Node 持久化加密设备状态所需的实现补充；其余依赖与 M4 规格一致。运行时依赖全部使用精确版本，避免平台协议实现被间接升级改变。

## 生产依赖安全结果

执行 `npm audit --omit=dev` 后：

- high：0
- critical：0
- moderate：2
- low：0

安装渠道 SDK 时发现的既有 Next.js、PostCSS、Sharp 高危项已通过补丁升级处置：

- Next.js：`16.2.10` → `16.2.11`
- PostCSS override：`8.5.16` → `8.5.23`
- Sharp override：`0.34.5` → `0.35.3`
- `eslint-config-next` 同步到 `16.2.11`

剩余 2 个中危项来自 `@modelcontextprotocol/sdk@1.29.0` 间接依赖的 `@hono/node-server@1.19.15`，不在渠道 SDK 依赖树中。npm 当前建议的自动修复会强制把 MCP SDK 降到 `1.24.3`，属于破坏性反向降级，因此未执行；待 MCP SDK 上游兼容 Hono 2 后单独升级。

## 兼容性验证

- Matrix 渠道合同自测：15 项通过。
- DigitalMate 全量测试：137 个测试文件、1757 项测试通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：QwenPaw Console 与 Next.js 生产构建通过；Next.js 34 个页面完成生成或编译。

生产构建已实际加载 Next.js `16.2.11` 与 Sharp `0.35.3`，未发现编译或页面生成不兼容。
