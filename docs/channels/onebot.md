# OneBot v11 渠道

DigitalMate 通过独立公网 Channel Gateway 接收 OneBot v11 反向
WebSocket。当前兼容性基线覆盖 NapCat、go-cqhttp 与 Lagrange 的消息格式。

## 配置

1. 在管理后台创建 OneBot 渠道并生成强随机 `access_token`。
2. 将 OneBot 客户端的反向 WebSocket 地址设为：
   `wss://<你的域名>/channel-gateway/onebot/{connection_id}`。
3. 启用 OneBot 的 Universal 反向 WebSocket 客户端（API 与 Event 共用
   同一条连接），并将请求头 `Authorization` 设为
   `Bearer <access_token>`。
4. 启用渠道后重连 OneBot 客户端。独立 `API` / `Event` 双连接模式会被
   拒绝，避免两条连接互相替换。

Console 中的 `ws_host=0.0.0.0` 和 `ws_port=6199` 仅用于保持
QwenPaw 配置兼容，字段只读。实际服务不监听这个端口，固定由 Channel
Gateway 和上面的连接路径托管，因此不会与其他渠道争用端口。

## 行为边界

- 支持私聊、群聊、群聊 `@`、文本、图片与文件 segment。
- `record/audio/video` 不会进入主模型；第一期不支持语音和视频理解。
- `share_session_in_group=false` 时，同一群内不同成员使用隔离会话；开启后
  整个群共享会话。
- 出站只允许 `send_private_msg`、`send_group_msg`、`get_image` 和
  `get_file` 四种 action。请求用 UUID `echo` 关联，30 秒无响应进入
  Delivery 重试，不会重新执行 Agent。
- 公网 WebSocket 帧保持 1 MiB 上限。较大的图片/文件只从消息中经过校验的
  QQ 官方 HTTPS CDN 地址下载，拒绝跳转、私网地址和任意第三方主机；小附件
  才允许通过 action response 的内联 base64 兼容传输。
- 单连接最多同时处理 500 个事件；事件处理超过 10 秒会关闭异常连接，
  等待客户端重新连接。

## 安全与平台风险

Access Token 只保存在加密配置中，并在 WebSocket 升级前校验。公网入口不
提供任意路径、任意端口或无鉴权的兼容模式。

OneBot 客户端通常依赖非官方 QQ 自动化方案，可能触发平台风控、限制登录或
账号封禁。建议使用独立测试账号、限制发送频率，并遵守 QQ 平台规则；启用
该渠道不代表 DigitalMate 或 OneBot 实现方能够消除这些风险。
