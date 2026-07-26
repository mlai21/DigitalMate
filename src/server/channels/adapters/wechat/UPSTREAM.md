# 微信 iLink 实现来源

- 上游仓库：https://github.com/agentscope-ai/QwenPaw.git
- 固定版本：`v2.0.0.post3`
- 固定提交：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`
- 上游路径：`src/qwenpaw/app/channels/wechat/`
- 许可证：Apache-2.0，完整文本见 `vendor/qwenpaw-console/LICENSE`

本目录依据以下固定上游文件迁移协议行为：

| 上游文件 | SHA-256 | 迁移内容 |
| --- | --- | --- |
| `client.py` | `99a5b8a71aeaeb58b7044c69c74044f0b9b7e0bc0620383ac4ac6d2103e51ce6` | iLink 端点、请求头、长轮询、发送、正在输入和媒体下载协议 |
| `channel.py` | `c17107a898c5bd24739af46838bb14a652cc8980d6f63972fe72df990fadbd8f` | 消息解析、上下文令牌、去重、状态机和消息合并语义 |
| `utils.py` | `1534fb3577a14bac4f9325b504d6d51d35550ff52aea055970ac3e92cf7defce` | 微信媒体 AES Key 兼容格式与解密规则 |

这些 Python 文件保留在 `vendor/qwenpaw-console/reference/` 作为只读审计基线；DigitalMate 没有直接运行或修改它们。当前目录使用 TypeScript 重写同一协议，并刻意替换了以下宿主能力：

- 使用统一 PostgreSQL 事件账本取代进程内消息去重；
- 使用加密渠道配置和加密 reply handle 取代明文 Token 文件与 `wechat_context_tokens.json`；
- 使用私有附件存储和短期加密 locator 取代 `media_dir`；
- 使用统一 Delivery 事务确保一份持久化回复只发送一次；
- 将请求发出后的网络中断视为发送结果不确定，不自动重发；
- 将平台拒绝的上下文令牌持久标记为失效，重启后也不会再次选择；
- 仅把经过真实实现和自动化验证的单聊能力标记为可用。

上游 Console 的页面、二维码交互和字段结构保持在固定版本基线上，DigitalMate 只通过兼容 API 接入现有运行时。
