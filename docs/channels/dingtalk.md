# 钉钉渠道

## 配置

在钉钉开发者后台创建企业内部应用，启用机器人能力，把消息接收模式设为 Stream，并在管理后台填写：

- `client_id`：应用 Client ID（AppKey）。
- `client_secret`：应用 Client Secret。
- `message_type`：普通回复使用 `markdown` 或 AI `card`。
- `cron_message_type`：主动任务使用 `markdown` 或 AI `card`。
- `card_template_id`、`card_template_key`：AI Card 模板 ID 与承载正文的字段名；Card 模式必填。
- `robot_code`：主动消息、附件下载与 AI Card 投放使用的机器人 Code。
- `card_auto_layout`：向卡片模板传入自动布局配置。
- `at_sender_on_reply`：群聊回复时 @ 原发送者。
- `streaming_enabled`：仅在普通回复选择 Card 时可启用，后续分段更新同一卡片实例。
- `endpoint`：可选 OpenAPI 根地址，默认 `https://api.dingtalk.com`。

应用需要机器人收发消息、获取消息文件和互动卡片相关权限。服务器出口 IP 必须加入钉钉应用白名单，否则后台会显示“出口 IP 未授权”的权限降级状态。

## Stream 与 ACK 边界

DigitalMate 使用固定的 `dingtalk-stream-sdk-nodejs@2.0.4` 接入 Stream。该版本默认会打印完整配置和原始回调，因此接入层替换了 SDK 的端点获取、WebSocket 日志和下行分发实现，同时保留其订阅、系统帧和 ACK 协议能力；Client Secret、连接 ticket、原始消息与 sessionWebhook 不会进入日志。

收到 `/v1.0/im/bot/messages/get` 后，处理顺序固定为：

1. 解析平台 `msgId`，以 `message:{msgId}` 写入统一事件账本。
2. 账本持久化成功后返回 Stream `SUCCESS` ACK。
3. 保存加密 reply handle；如有附件，保存加密下载 locator 并私有化文件。
4. 附件全部绑定后事件才可执行；Agent 结果由独立 Delivery 账本发送。

持久化前失败会返回 `LATER` 让平台重投；持久化后即使发送断线，也只恢复同一个 Delivery，不会重新执行 Agent。

## 会话、回复与主动消息

- `conversationType=1` 作为私聊，`conversationType=2` 作为群聊。
- `isInAtList` 或 `atUsers` 用于判断群聊 @；最终是否响应仍由统一渠道访问策略决定。
- 被动回复优先使用回调携带的 `sessionWebhook`。它只存于加密 reply handle，并使用平台过期时间；过期后不再调用。
- sessionWebhook 被平台明确拒绝时改走 OpenAPI；网络中断或平台超时等结果不确定的失败只重试原 Delivery，不立即切换通道，避免同一回复被发送两次。
- 无可用 sessionWebhook 或主动任务时，使用 `robot_code` 调用 OpenAPI：群聊走 `groupMessages/send`，私聊走 `oToMessages/batchSend`。
- Markdown 会保留段落与列表；超过平台安全长度时降级为纯文本。
- 群聊开启 `at_sender_on_reply` 后，同时写入 `atUserIds` 和可见的 @ 文本。

旧 `/api/webhooks/dingtalk` 地址只保留鉴权兼容，不再消费业务消息，避免与 Stream 重复入站。

## AI Card

Card 模式先创建卡片实例，再按会话投放：

- 群聊投放到 `dtv1.card//IM_GROUP.{conversationId}`。
- 私聊投放到 `dtv1.card//IM_ROBOT.{senderStaffId}`。
- 每次流式更新使用新的 `guid`，正文写入 `card_template_key`，最后一次设置 `isFinalize=true`。
- `cardInstanceId` 随 Delivery 的平台结果持久化，因此进程重启或下一分段使用新发送实例时，仍会更新原卡片。
- 单段回复也会立即完成卡片，避免卡片永久停留在输入状态。

## 附件与安全

图片和文件回调只把 `downloadCode` 与 `robotCode` 写入加密 locator。系统先调用 `/v1.0/robot/messageFiles/download` 换取一次性下载地址，再从受限的钉钉/阿里 CDN 域名下载到 DigitalMate 私有存储。全部附件绑定完成前事件不可执行。

带附件的消息固定关闭联网、Skill 和其他工具。附件正文、历史附件或平台下载地址都不能授予联网权限。

## Smoke 清单

1. 启动 Stream，确认收到 `REGISTERED` 后后台显示健康。
2. 分别发送私聊、未 @ 群消息和 @Bot 群消息，确认 ACK 后只执行一次。
3. 开启 @ 发送者，确认群回复包含通知与可见 @ 文本。
4. 上传 TXT、PDF 或白名单图片，确认私有化完成后才运行 Agent。
5. 分别测试 Markdown 与 Card；Card 流式回复应始终更新同一实例并最终完成。
6. 创建主动提醒，确认群聊与私聊分别走正确 OpenAPI。
7. 临时移除出口 IP 白名单，确认后台显示可操作的权限错误且不泄露凭证。
