# Matrix 渠道

Matrix 渠道通过长期 `/sync` 连接收发私聊与房间消息，支持端到端加密房间、回复关系、结构化提及、加密图片附件和编辑式流式回复。所有消息仍进入 DigitalMate 的统一渠道事务；消息正文或附件不会自行获得联网、工具、Skill 或后台任务权限。

## 配置

| 字段 | 说明 |
| --- | --- |
| `homeserver` | Matrix homeserver 的 HTTP(S) 地址 |
| `user_id` | DigitalMate 使用的完整 MXID，例如 `@digitalmate:example.org` |
| `access_token` | Access Token 登录凭据 |
| `password` | 密码登录凭据；与 Access Token 同时存在时优先使用密码 |
| `device_name` | Matrix 设备显示名，DigitalMate 默认值为 `digitalmate-worker` |
| `group_allow_from` | 允许接入的房间 ID 列表 |
| `groups` | 按房间 ID 或 `*` 设置 `autoReply`、`requireMention` |
| `encryption` | 启用 Rust Crypto 端到端加密 |
| `vision_enabled` | 允许图片进入现有视觉附件链路；关闭时图片只保留文字说明 |
| `history_limit` | 首次同步的房间历史上限，默认 `50` |
| `sync_timeout_ms` | `/sync` 长轮询超时，默认 `30000` |
| `mention_pill_in_body` | 出站正文增加 Matrix HTML mention pill |
| `outbound_structured_mentions` | 出站消息写入 `m.mentions` |
| `streaming_enabled` | 使用 `m.replace` 编辑同一条出站事件 |

Access Token 与密码字段同时显示，用户可直接选择任一种方式；这修正了固定上游表单引用不存在的 `auth_method` 字段、导致认证字段被错误隐藏的问题。群聊默认需要提及 DigitalMate，可由具体房间的 `groups` 设置覆盖。

## 登录、同步和幂等

- Access Token 登录会调用 `whoami`，令牌所有者必须与 `user_id` 一致。
- 密码登录使用稳定、连接级设备 ID，并设置设备显示名；服务重启不会无故创建新设备。
- 只有 SDK 完成 `PREPARED` 首次同步后，连接才标记为健康。
- Matrix 原生事件 ID（例如 `$event-123:example.org`）直接作为外部事件 ID，由统一 Ingress 和执行账本去重。
- 私聊优先依据 `m.direct`，并以房间已加入成员数不超过两人作为兼容判断；房间消息仍经过允许列表、逐房间设置和统一访问控制。
- `M_LIMIT_EXCEEDED` 保留 `retry_after_ms`，但 homeserver 返回的原始错误文字和凭据不会进入健康状态。

## 端到端加密设备库

`matrix-js-sdk@41.9.0` 的 Node 运行方式本身只提供内存型 IndexedDB。DigitalMate 使用 `fake-indexeddb@6.2.5` 提供兼容数据库，再把对应连接的数据库快照写入：

```text
data/matrix/connections/{connection_id}/crypto-store.bin
```

文件与目录权限分别为 `0600`、`0700`。快照整体使用 AES-256-GCM 加密，密钥由 `CHANNEL_SECRETS_KEY` 按 `user_id + agent_id + connection_id` 独立派生；SDK 内部记录还使用单独的 32 字节 storage key 加密。同步 token 与 Olm/Megolm 状态均不会写入渠道配置、管理 API、日志或普通个人数据导出。

禁用或改配连接时会停止 SDK 并保留设备库，以便重新启用后继续解密历史会话。一键清空个人数据时，运行时先停止渠道并断开用户连接，再物理删除该用户列出的 Matrix 设备库，最后删除数据库记录；物理删除失败时不会继续清数据库。M5 灾难恢复如需包含设备库，必须使用独立备份密钥，不复用普通个人数据导出。

## 入站消息与附件

只接收解密后的 `m.room.message`。机器人自己的事件、无法解密的事件和 `m.replace` 编辑事件不会触发新的 Agent 执行。回复事件保留：

```json
{
  "m.relates_to": {
    "m.in_reply_to": {
      "event_id": "$parent:example.org"
    }
  }
}
```

提及同时识别 `m.mentions.user_ids`、完整 MXID 和 `matrix.to` HTML pill。

第一期媒体只把 `m.image` 与 `m.file` 交给现有附件白名单。加密媒体先验证 Matrix `sha256`，再按 `A256CTR` 在内存解密；临时 media access token 和加密文件参数只进入一小时有效的加密 attachment locator，下载绑定私有附件后立即清除。音频、视频、Office、压缩包和其他非白名单格式不会借此扩大附件能力。

## 出站与流式回复

普通回复发送 `m.room.message`。需要回复时写入 `m.in_reply_to`；启用结构化提及时写入 `m.mentions`，可选 HTML pill 会进行 HTML 转义。

启用 `streaming_enabled` 后，首段创建一个事件，后续内容使用：

```json
{
  "m.relates_to": {
    "rel_type": "m.replace",
    "event_id": "$original:example.org"
  },
  "m.new_content": {
    "msgtype": "m.text",
    "body": "完整回复"
  }
}
```

编辑沿用原事件 ID 作为 Delivery 的外部消息 ID，不会重新运行 Agent。

## 人工冒烟

1. 分别用 Access Token 与密码连接测试 homeserver，确认首次同步后才显示健康。
2. 重启服务，确认设备 ID 不变，既有加密房间的新消息仍可解密。
3. 在私聊和群聊发送文字，验证 `m.direct`、房间允许列表、逐房间 `requireMention` 和 `autoReply`。
4. 发送回复、`m.mentions` 与 HTML pill，确认关系和提及均被识别。
5. 编辑已发送消息，确认不会触发第二次 Agent 执行。
6. 发送普通图片、加密图片和不允许的文件类型，确认只有白名单附件进入私有存储。
7. 启用流式回复，确认后续片段编辑同一 Matrix 事件。
8. 制造错误令牌、无权限、429 与断网，确认健康状态只有稳定错误码。
9. 执行一键清空，确认对应 `crypto-store.bin` 先于数据库记录删除。
