# 腾讯元宝协议描述符来源

- 上游仓库：https://github.com/agentscope-ai/QwenPaw.git
- 固定版本：`v2.0.0.post3`
- 固定提交：`fef7e64d984f4332d0b84a343cd209bd3ea5d316`
- 上游路径：`src/qwenpaw/app/channels/yuanbao/proto/`
- 许可证：Apache-2.0，完整文本见 `vendor/qwenpaw-console/LICENSE`

本目录中的 `proto/conn.json` 与 `proto/biz.json` 从固定上游逐字节复制，没有改写字段、枚举或包名：

| 文件 | SHA-256 |
| --- | --- |
| `conn.json` | `978b1110f19990c84125fd2f15d329287c13f2bf779d09ebe2b37086be7b7dd9` |
| `biz.json` | `0a17426c06bc20bcb50b9db78a9e503c3a7ef4c30325452a4ebe6289267c3ddd` |

DigitalMate 只替换运行时实现：上游用 Python `google.protobuf` 动态构造消息，本项目用 TypeScript `protobufjs` 加载同一描述符。`tests/fixtures/channels/yuanbao/*.bin` 固定连接层 binary golden，测试同时验证描述符哈希和编码结果，防止 wire format 静默漂移。
