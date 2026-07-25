# Mattermost 渠道

## 配置

在管理后台创建 Mattermost 连接并填写：

- `url`：Mattermost 服务器根地址，例如 `https://mattermost.example.com`。
- `bot_token`：Bot Personal Access Token。
- `show_typing`：是否发送 typing 状态；关闭时不调用 typing API。
- `thread_follow_without_mention`：Bot 已参与的 thread 中，后续回复可不再次 @；群聊访问策略仍然生效。

Bot 至少需要读取目标频道、创建帖子、读取文件和发送 typing 状态的权限。

## 连接与路由

启动时先调用 `GET /api/v4/users/me` 验证 Token 并读取 Bot user ID/username，然后连接 `/api/v4/websocket`，发送 bearer authentication challenge。`posted` 事件按 post ID 生成幂等键 `post:{post.id}`。

- DM 按 channel ID 路由。
- 团队频道按 channel ID 路由。
- thread 保留 `root_id`；回复通过 `POST /api/v4/posts` 的 `root_id` 回到原 thread。
- `@username` 会被识别并从交给 Agent 的正文中移除。
- 当前 Bot 自己的帖子始终忽略。

WebSocket sequence 只在事件成功交给统一 Ingress 后推进；同一 sequence 的重复事件在当前连接内跳过，跨重连仍由事件账本按 post ID 去重。

## 附件与安全

入站 `file_ids` 只作为加密 locator 保存。系统通过 `/api/v4/files/{id}/info` 验证元数据，再从 `/api/v4/files/{id}` 下载到 DigitalMate 私有存储；所有文件绑定完成前事件保持不可执行。

Token、文件下载响应和原始 WebSocket payload 不写入对话。带附件的消息固定关闭联网、Skill 与其他工具。

## 发送、限流与恢复

- 普通回复调用 `POST /api/v4/posts`。
- typing 调用 `POST /api/v4/users/{bot}/channels/{channel}/typing`。
- 401 不重试，403 标记权限降级，429 按 `Retry-After` 退避。
- 禁用、重配或关闭服务时关闭 WebSocket；连接管理器独立恢复该渠道，不影响其他 IM。

## Smoke 清单

1. 发送 DM，确认仅执行和回复一次。
2. 在团队频道测试未 @、@Bot 和 thread reply。
3. 让 Bot 回复某 thread，再发送不带 @ 的跟进，确认开关生效。
4. 上传 TXT 或图片，确认附件私有化完成后才运行 Agent。
5. 开启 typing，确认处理期间出现输入状态。
6. 撤销发帖权限，确认后台显示权限降级且不泄露 Token。
