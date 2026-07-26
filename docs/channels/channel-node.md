# 渠道运行节点

channel-node 是 iMessage 与 SIP 的受限运行端。它只负责本地协议收发，通过出站 mTLS WebSocket 连接 DigitalMate；不会获得数据库、模型、搜索、Skill、工具或调度权限。

## 准备

中心端先创建节点、绑定渠道连接，并签发由专用 enrollment CA 签名的客户端证书。enrollment CA 与网关服务端信任根必须是不同公钥、互不成链的独立自签根；Web 只读取网关信任根的公开证书，不能获得网关私钥。节点主机需要保存四个文件：

- `node.json`：节点 ID、中心地址、证书路径和允许的连接 ID。
- `node.pem`：客户端证书。
- `node.key`：客户端私钥。
- `ca.pem`：网关服务端公开 CA/信任链，不是客户端证书签发 CA。

`node.json`、`node.pem` 和 `node.key` 必须是普通文件且权限为 `0600`；CA 可为 `0644`，但不能允许组或其他用户写入。中心地址必须使用精确的 `wss://<域名>/channel-node`，不能携带用户名、密码、查询参数或片段；mTLS 是唯一的节点认证方式。

Console 创建或轮换节点时会下载 `.dmnode` 加密包，并单独显示一次 10 分钟有效的解密令牌。不要把令牌直接放进命令行历史；先写入权限 `0600` 的临时文件，再安装到一个尚不存在的新目录：

```bash
npm run channel-node:build
chmod 600 /absolute/private/enrollment-token
npm --prefix runners/channel-node run install-bundle -- \
  --bundle /absolute/path/digitalmate-channel-node.dmnode \
  --token-file /absolute/private/enrollment-token \
  --target /absolute/private/channel-node
```

安装器校验加密包、路径与令牌文件权限，生成 `node.json`、`node.pem`、`node.key` 和 `ca.pem`；失败时清理本次新建的目标目录。加密包只包含网关公开信任根，不包含 enrollment CA。中心配置加载会先校验 enrollment 私钥确实属于 enrollment 根证书，再拒绝下级 CA、交叉签名根及复用公钥的不同证书，避免误挂私钥或 Web 的客户端签发权限能够伪造网关身份。安装成功并完成首次 mTLS 后，中心会消费该一次性 enrollment。随后删除令牌文件，并按 iMessage 或 SIP 文档补充节点本地渠道配置。中心响应、数据库和日志都不会出现已签发私钥明文。

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

每个本地渠道使用独立的 `0600` 配置文件，不把本机路径加入最小节点身份配置。例如 iMessage 使用：

```text
channels/imessage/<connection_id>.json
```

完整字段、完全磁盘访问和 `imsg` 准备方式见 [iMessage 渠道运行节点](imessage.md)。

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

附件不会把 Mac 本地路径交给中心。runner 先在本机私有目录生成临时副本，再通过同一条 mTLS WebSocket 发送 512 KiB 分块；每帧仍受 1 MiB 上限约束。中心按节点、连接、事件和附件 ID 校验传输范围，核对长度与 SHA-256，并执行统一附件白名单和内容签名校验。只有中心完成私有存储和消息绑定后，入站 ACK 才会触发本机临时副本删除；节点重连会先按持久入站队列重新传输仍待确认的附件，再重放原事件。

平台发送副作用按中心 `deliveryId + requestSequence` 写入同目录的私有 `.deliveries` receipt 文件，并至少保留 7 天，覆盖中心允许的节点离线窗口。发送成功但结果回传前断线时，同一请求只重放已保存的结果；只有中心在收到 `retryable` 后签发新的请求序号才允许再次执行。已经成功或终止失败的交付即使收到新序号也只重放原结果，不会再次调用 iMessage/SIP 发送；如果进程在副作用结果落盘前崩溃，状态会明确标记为结果未知并拒绝盲目重发，以避免重复消息或重复语音。

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
- 每次重新注册都会按中心返回的最新绑定集合做增删同步：新绑定启动本地 transport，已解绑 transport 立即停止，不再继续读取本地数据库或复制附件。
- 不要手工编辑 outbox 或 sequence 状态文件；校验和或权限异常时 runner 会失败关闭，避免重复或篡改消息进入中心。
