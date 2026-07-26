# 渠道运行节点

channel-node 是 iMessage 与 SIP 的受限运行端。它只负责本地协议收发，通过出站 mTLS WebSocket 连接 DigitalMate；不会获得数据库、模型、搜索、Skill、工具或调度权限。

## 准备

中心端先创建节点、绑定渠道连接，并签发由专用节点 CA 签名的客户端证书。节点主机需要保存四个私有文件：

- `node.json`：节点 ID、中心地址、证书路径和允许的连接 ID。
- `node.pem`：客户端证书。
- `node.key`：客户端私钥。
- `ca.pem`：中心节点 CA。

`node.json`、`node.pem` 和 `node.key` 必须是普通文件且权限为 `0600`；CA 可为 `0644`，但不能允许组或其他用户写入。中心地址必须使用精确的 `wss://<域名>/channel-node`，不能携带用户名、密码、查询参数或片段；mTLS 是唯一的节点认证方式。

示例配置：

```json
{
  "nodeId": "30000000-0000-4000-8000-000000000001",
  "serverUrl": "wss://mate.example.com/channel-node",
  "caPath": "/Users/me/.digitalmate/channel-node/ca.pem",
  "certificatePath": "/Users/me/.digitalmate/channel-node/node.pem",
  "keyPath": "/Users/me/.digitalmate/channel-node/node.key",
  "connectionIds": [
    "20000000-0000-4000-8000-000000000001"
  ]
}
```

## 构建与运行

在仓库根目录执行：

```bash
npm run channel-node:build
CHANNEL_NODE_CONFIG_PATH=/absolute/path/node.json \
  node runners/channel-node/dist/index.js
```

runner 的业务环境变量只能提供 `CHANNEL_NODE_CONFIG_PATH`。如果环境中存在数据库地址、应用或渠道解密密钥、模型/搜索 API Key、平台 Token/Secret、密码、私钥以及 Node 动态注入配置，runner 会拒绝启动；这也覆盖 `DATABASE_URL`、`CHANNEL_SECRETS_KEY`、`APP_SECRET`、`KIE_AI_API_KEY`、`EMBEDDING_API_KEY`、`SEARCH_PROVIDER` 和各渠道凭据。建议使用专门的低权限系统用户运行，不要继承 Web/Agent 服务环境。

## 断线与队列

本地入站事件先写入权限 `0600` 的 `outbox.jsonl`，再发送给中心。队列最多 1000 条或 50 MiB；中心确认后原子压缩。连接断开时按 1、2、5、10、30、60 秒退避并加入抖动，重新注册后只补发未确认事件，sequence 保持不变。中心下发的发送指令只接受配置并由中心确认绑定的连接 ID。

平台发送副作用按中心 `deliveryId` 写入同目录的私有 `.deliveries` receipt 文件。发送成功但结果回传前断线时，重连只重放已保存的结果，不会再次调用 iMessage/SIP 发送；如果进程在副作用结果落盘前崩溃，状态会明确标记为结果未知并拒绝盲目重发，以避免重复消息或重复语音。

## macOS launchd

安装脚本只在当前目录生成 plist，不执行 `launchctl`，也不会修改系统目录。先创建权限不高于 `0700` 的日志目录，再运行：

```bash
node runners/channel-node/scripts/install-launchd.mjs \
  --runner /absolute/path/runners/channel-node/dist/index.js \
  --config /absolute/path/node.json \
  --logs /absolute/private/log/directory \
  --output com.digitalmate.channel-node.plist
```

检查生成内容后，由操作者自行决定是否复制和加载。plist 的环境变量只有 `CHANNEL_NODE_CONFIG_PATH`。

## 撤销与排障

- 需要立即下线时，在 Console 撤销节点证书；中心会断开现有会话，后续握手也会失败。
- `outbox.jsonl` 达到上限时节点停止接收新的本地入站事件，保留已有数据等待中心恢复。
- 节点离线不会再次运行 Agent。中心 Delivery 保持等待或按既定重试策略处理。
- 不要手工编辑 outbox 或 sequence 状态文件；校验和或权限异常时 runner 会失败关闭，避免重复或篡改消息进入中心。
