# iMessage 渠道运行节点

iMessage 只能运行在已登录 Messages 的 macOS 节点上。DigitalMate 的中心服务不会读取 Mac 的 Messages 数据库；受限 `channel-node` 只读查询本机 `chat.db`，把规范化后的事件通过 mTLS WebSocket 发给中心。节点没有数据库、模型、搜索、记忆、Skill 或工具权限。

## 前置条件

1. 安装 `imsg`：

   ```bash
   brew install steipete/tap/imsg
   which imsg
   ```

2. 给实际运行 `channel-node` 的终端或 Node 可执行文件授予 macOS“完全磁盘访问权限”。节点启动时会检查：

   - 系统是 macOS；
   - `/usr/bin/sqlite3` 可执行；
   - `chat.db` 可读；
   - `imsg` 可执行。

3. 在 `node.json` 同级目录创建连接配置：

   ```text
   channels/imessage/<connection_id>.json
   ```

   文件必须是普通文件、权限 `0600`。示例：

   ```json
   {
     "connection_id": "20000000-0000-4000-8000-000000000001",
     "db_path": "~/Library/Messages/chat.db",
     "poll_sec": 1,
     "media_dir": null,
     "max_decoded_size": 10485760,
     "bot_prefix": "[Mate] "
   }
   ```

   `media_dir` 为空时，节点使用 `node.json` 同级的 `media/imessage/<connection_id>` 私有目录。配置文件中的连接必须同时出现在 `node.json` 的 `connectionIds` 中。

## 收发边界

- 启动时先记录 `message.MAX(ROWID)`，只读取之后的新行，不回放历史消息。
- 每次通过 `/usr/bin/sqlite3 -readonly -json` 查询；游标是校验后的整数参数，不经过 shell。
- 默认每 1 秒轮询。`is_from_me=1`、缺少发送者、带机器人前缀的回声和群聊都会被忽略。
- 当前只支持一对一会话。群聊不会进入 Agent；中心会按持久化的 `chatType` 拒绝群聊投递，即使收件人字段中恰好带有某个群成员 ID，也不会降级成对该成员的私聊。
- 发送固定使用参数数组 `imsg send --to <handle> --text <text>`；不会把号码、正文或 `imsg` stderr 写入结果和日志。`imsg` 返回无法判断副作用是否发生的异常时按“结果未知”终止，不自动重试，以避免已经发出后再次发送。
- 入站附件只允许 JPEG、PNG、WebP、PDF、TXT、MD、JSON 和 CSV，固定为单文件最多 10 MiB、一条消息最多 4 个且合计最多 20 MiB；`max_decoded_size` 只能进一步收紧，不能放宽产品上限。文件必须来自 Messages 附件目录，先复制到权限 `0700` 的节点私有目录，文件权限为 `0600`，再通过现有 mTLS 连接以不超过 512 KiB 的分块传给中心。中心校验真实文件签名或文本内容并保存到私有存储后才确认入站事件；收到该确认后节点删除临时副本，原 Messages 文件永不修改。若节点在入站确认前重启，会先按持久队列和私有待确认清单重新上传附件，再重放原入站事件。
- 单行附件损坏或类型越界时，该行会写入私有 `rejected.jsonl`（只含 rowid、错误码和时间），清理本轮临时副本并推进游标，避免同一坏消息永久阻塞后续消息。连接中断、中心传输失败或本地持久队列失败不会推进游标，恢复后会重试。已入队附件另有私有待确认清单，节点重启也会保留到入站 ACK；启动时只清理未被清单引用的随机临时副本。

## 已知限制与回滚

- Apple 没有为 Messages 提供公开的机器人服务端接口；数据库结构和 `imsg` 行为可能随 macOS 版本变化。升级 macOS 后应重新运行合同测试和真实私聊冒烟。
- `bot_prefix` 同时用于发出回复和过滤回声。不要配置为普通用户经常使用的开头。
- 停用时先在 Console 解绑或吊销节点证书，再停止 `channel-node`。轮询停止后不会修改或删除 Messages 数据库；中心已经持久化的文字对话仍保留。
