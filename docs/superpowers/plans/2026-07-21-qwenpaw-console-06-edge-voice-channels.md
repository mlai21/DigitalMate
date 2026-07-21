# 边缘节点与四个特殊渠道实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M4-C：实现 OneBot v11、iMessage、Voice/Twilio、SIP，并提供受限的 macOS/媒体运行节点和公网 WebSocket gateway。

**架构：** OneBot 与 Twilio 经 agent-service 内的独立 HTTP/WebSocket gateway 接入；iMessage 与 SIP 在无 Agent 权限的 runner 上运行，经出站 mTLS WebSocket 与中心交换规范化事件和 Delivery。语音只在 Twilio或 SIP runner 完成 STT/TTS，中心 Agent 只接收转写文本，音频不成为聊天附件。

**技术栈：** Node.js HTTP/TLS/WebSocket、Twilio ConversationRelay、macOS Messages SQLite + `imsg`、SIP/RTP UDP、LiveKit、DashScope STT/TTS、Vitest、Docker Compose、Caddy。

---

## 文件结构

**创建：**

- `src/agent-service/channel-gateway.ts`：公网 HTTP/WSS gateway 生命周期。
- `src/server/channels/gateway/router.ts`：Twilio/OneBot 路径、大小、鉴权和连接绑定。
- `src/server/channels/gateway/node-server.ts`：9443 mTLS 节点 WebSocket server。
- `src/server/channels/gateway/tls.ts`：证书、CA、指纹和吊销验证。
- `src/server/channels/adapters/onebot/{config,normalize,protocol,transport,index}.ts`
- `src/server/channels/adapters/voice/{config,signature,twiml,relay,transport,index}.ts`
- `runners/channel-node/package.json`、`package-lock.json`、`tsconfig.json`：独立 runner 依赖树。
- `runners/channel-node/src/{index,client,protocol,config,health}.ts`
- `runners/channel-node/src/imessage/{config,database,normalize,transport}.ts`
- `runners/channel-node/src/sip/{config,backend,registrar,rtp,session,stt,tts,livekit,transport}.ts`
- `runners/channel-node/scripts/install-launchd.mjs`：macOS launchd 安装描述生成器，不直接改系统。
- `tests/unit/channels/adapters/{onebot,voice}.test.ts`
- `tests/unit/channels/gateway/{router,node-server,tls}.test.ts`
- `tests/unit/channel-node/{client,imessage,sip}.test.ts`
- `tests/fixtures/channels/{onebot,voice,imessage,sip}/*`
- `docs/channels/{onebot,imessage,voice,sip,channel-node}.md`
- `docs/verification/channels-edge-m4c.md`

**修改：**

- `package.json`、`package-lock.json`：固定 Twilio/LiveKit 依赖并加入 runner build/test。
- `src/server/channels/runtime/registry.ts`：注册 OneBot/Voice 中心 Adapter和 iMessage/SIP node proxy Adapter。
- `src/server/channels/manifests/catalog.ts`：校准四个渠道字段与 prerequisite。
- `src/agent-service/index.ts`：与 worker 一起启动/停止 gateway。
- `Caddyfile`：只把 `/channel-gateway/*` 路由到 agent:3101，其他请求仍到 web。
- `docker-compose.yml`：agent expose 3101，并显式发布 mTLS 9443；SIP 媒体不在中心容器开放。
- `Dockerfile`：runner 镜像保留 agent gateway 依赖；LiveKit native 依赖只进入 channel-node 构建产物。
- `src/server/config/env.ts`、`.env.example`：gateway、mTLS 和 public base URL 配置。
- `src/server/admin/compat/handlers/channels.ts`：节点注册/证书/绑定、Twilio webhook 配置和 blocked 状态。
- `patches/qwenpaw-console/0004-api-compat.patch`：节点、语音和特殊前置条件状态。

### 任务 1：建立公网 gateway 与 mTLS 节点入口

**文件：**
- 创建：`src/agent-service/channel-gateway.ts`
- 创建：`src/server/channels/gateway/router.ts`
- 创建：`src/server/channels/gateway/node-server.ts`
- 创建：`src/server/channels/gateway/tls.ts`
- 创建：`tests/unit/channels/gateway/router.test.ts`
- 创建：`tests/unit/channels/gateway/node-server.test.ts`
- 创建：`tests/unit/channels/gateway/tls.test.ts`
- 修改：`src/agent-service/index.ts`
- 修改：`src/server/config/env.ts`
- 修改：`.env.example`
- 修改：`docker-compose.yml`
- 修改：`Caddyfile`

- [ ] **步骤 1：编写失败的路由与证书测试**

```ts
it("未绑定或已吊销的节点证书不能升级 WebSocket", async () => {
  await expect(authorizeNodeCertificate(revokedCertificate, repository)).rejects.toThrow("node_certificate_revoked");
  await expect(authorizeNodeCertificate(unboundCertificate, repository)).rejects.toThrow("node_certificate_unknown");
});

it("公网 gateway 只接受已注册路由", async () => {
  expect((await gateway.request("/channel-gateway/unknown")).status).toBe(404);
  expect((await gateway.request("/api/admin/compat/root")).status).toBe(404);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/gateway`

预期：FAIL，gateway 尚不存在。

- [ ] **步骤 3：实现 3101 公网反向代理目标**

Gateway 只注册 `/channel-gateway/onebot/:connectionId`、`/channel-gateway/voice/:connectionId/incoming`、`/status`、`/relay`；HTTP body 1 MiB、WS frame 1 MiB、idle 60 秒。Caddy matcher：

```caddyfile
@channelGateway path /channel-gateway/*
reverse_proxy @channelGateway agent:3101
reverse_proxy web:3000
```

- [ ] **步骤 4：实现 9443 mTLS server**

Node TLS server 设置 `requestCert:true`、`rejectUnauthorized:true`、只信任 `CHANNEL_NODE_CA_PATH`，升级后用证书 SHA-256 指纹查 `channel_runtime_nodes`。frame 交 M3 `node-protocol`；sequence 单调且 node 只能访问绑定 connection。证书吊销即时关闭现有 socket。

- [ ] **步骤 5：接入 Agent service 生命周期**

先启动数据库/worker，再启动 3101/9443；shutdown 先停止 upgrade/新连接，再 drain node ACK，最后停止 worker。环境变量固定为 `CHANNEL_GATEWAY_PORT=3101`、`CHANNEL_NODE_PORT=9443`、`CHANNEL_NODE_TLS_CERT_PATH`、`CHANNEL_NODE_TLS_KEY_PATH`、`CHANNEL_NODE_CA_PATH`、`PUBLIC_BASE_URL`。

- [ ] **步骤 6：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/gateway tests/unit/agent-service-shutdown.test.ts`

预期：PASS；错 CA、过期、吊销、未知、越权 connection、重放 sequence 和超大 frame 全拒绝。

```bash
git add src/agent-service/channel-gateway.ts src/agent-service/index.ts src/server/channels/gateway/router.ts src/server/channels/gateway/node-server.ts src/server/channels/gateway/tls.ts src/server/config/env.ts .env.example docker-compose.yml Caddyfile tests/unit/channels/gateway/router.test.ts tests/unit/channels/gateway/node-server.test.ts tests/unit/channels/gateway/tls.test.ts tests/unit/agent-service-shutdown.test.ts
git commit -m "feat(P1-13): 建立渠道公网与 mTLS 节点入口"
```

**回滚：** 从 Caddy 删除专用 matcher、关闭 3101/9443；Web 仍由 web service 提供，节点 Delivery 保留 waiting_node。

**完成证据：** route allowlist、TLS 信任、吊销、绑定、限制和 shutdown 测试。

### 任务 2：实现受限 channel-node 客户端

**文件：**
- 创建：`runners/channel-node/package.json`
- 创建：`runners/channel-node/package-lock.json`
- 创建：`runners/channel-node/tsconfig.json`
- 创建：`runners/channel-node/src/{index,client,protocol,config,health}.ts`
- 创建：`runners/channel-node/scripts/install-launchd.mjs`
- 创建：`tests/unit/channel-node/client.test.ts`
- 创建：`docs/channels/channel-node.md`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的最小权限测试**

```ts
it("runner 配置中没有数据库、LLM、搜索、Skill 或工具凭据", () => {
  expect(Object.keys(channelNodeConfigSchema.shape).sort()).toEqual([
    "caPath", "certificatePath", "connectionIds", "keyPath", "nodeId", "serverUrl",
  ]);
});

it("断线重连只重发未 ACK frame 且保留 sequence", async () => {
  await client.sendInbound(frame7);
  socket.close();
  await client.reconnect();
  expect(socket.sent).toEqual([frame7]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channel-node/client.test.ts`

预期：FAIL，runner 不存在。

- [ ] **步骤 3：创建独立 runner 依赖与配置**

runner package 只依赖 `ws@8.21.1`、`zod@4.4.3`；dev 依赖 TypeScript/tsx/Types。证书和 key 只从 chmod 600 文件读取；配置拒绝环境中的 DATABASE_URL、KIE_AI_API_KEY、SEARCH_PROVIDER、GITHUB_TOKEN。

- [ ] **步骤 4：实现 mTLS client 与本地有界 outbox**

outbox 是权限 600 的 append-only JSONL，最多 1000 frame/50 MiB；每条有 sequence 和 sha256，中心 ACK 后原子压缩。重连使用 1/2/5/10/30/60 秒 jitter；register 成功后才启动本地 channel。中心 send frame 必须匹配 config connectionIds。

- [ ] **步骤 5：实现 launchd 描述生成器**

脚本只输出 plist 到指定当前目录，不执行 `launchctl`；ProgramArguments 使用编译后的绝对 runner 路径，KeepAlive true，日志指向用户指定私有目录，EnvironmentVariables 只含 node config path。

- [ ] **步骤 6：接入根脚本、运行测试并提交**

根 `package.json` 增加：

```json
{
  "channel-node:build": "npm --prefix runners/channel-node ci && npm --prefix runners/channel-node run build",
  "channel-node:test": "npm --prefix runners/channel-node test"
}
```

运行：`npm test -- --run tests/unit/channel-node/client.test.ts && npm run channel-node:build`

预期：PASS；构建产物不包含服务器 env 名称。

```bash
git add runners/channel-node tests/unit/channel-node/client.test.ts docs/channels/channel-node.md package.json package-lock.json
git commit -m "feat(P1-13): 提供最小权限渠道运行节点"
```

**回滚：** 吊销节点证书并停止 launchd；中心 waiting_node 保留。

**完成证据：** 最小配置、mTLS、outbox、ACK、重连、绑定和 plist 测试。

### 任务 3：实现 OneBot v11 反向 WebSocket

**文件：**
- 创建：`src/server/channels/adapters/onebot/{config,normalize,protocol,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/onebot.test.ts`
- 创建：`tests/fixtures/channels/onebot/*.json`
- 创建：`docs/channels/onebot.md`
- 修改：`src/server/channels/gateway/router.ts`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 OneBot 合同**

```ts
defineChannelContract(onebotContract({
  expectedEventId: "onebot:message:9000001",
  wsPath: "/channel-gateway/onebot/00000000-0000-4000-8000-000000000001",
  actions: ["send_private_msg", "send_group_msg", "get_image", "get_file"],
  eventTaskCap: 500,
}));
```

覆盖 Authorization bearer、lifecycle self_id、private/group/@、CQ segment 数组、share_session_in_group、echo correlation、API timeout、500 handler cap、10 秒 watchdog、port/path conflict、NapCat/go-cqhttp/Lagrange兼容 fixture 和平台风控警告。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/onebot.test.ts`

预期：FAIL，OneBot Adapter 未实现。

- [ ] **步骤 3：实现配置、鉴权和协议**

```ts
export const onebotConfigSchema = baseChannelConfigSchema.extend({
  ws_host: z.string().default("0.0.0.0"), ws_port: z.number().int().default(6199),
  access_token: z.string(), share_session_in_group: z.boolean(),
});
```

实际部署忽略用户可写 host/port，统一走 Caddy path；保留字段用于 Console parity并显示“由 gateway 托管”。token 使用 timing-safe 比较。message_id 是 external ID；group session按 share flag选择 group 或 group:user。

- [ ] **步骤 4：实现 segment 与 echo 发送**

text/image/file segment 解析为文字/允许附件 locator；audio/video 拒绝进入主模型。Delivery action 由 chat type选择 send_private_msg/send_group_msg，每请求 crypto UUID echo，30 秒 timeout。连接断开只使发送 retry，不重跑 Agent。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/onebot.test.ts tests/unit/channels/gateway/router.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/onebot src/server/channels/gateway/router.ts src/server/channels/runtime/registry.ts tests/unit/channels/adapters/onebot.test.ts tests/fixtures/channels/onebot docs/channels/onebot.md
git commit -m "feat(P1-13): 接入 OneBot v11 反向 WebSocket"
```

**回滚：** 关闭 connection 或撤销 token；NapCat 断开，Delivery 进入 retry/dead letter。

**完成证据：** 三实现 fixture、鉴权、DM/group/@、segment、echo、cap/watchdog 和风险状态测试。

### 任务 4：实现 macOS iMessage runner

**文件：**
- 创建：`runners/channel-node/src/imessage/{config,database,normalize,transport}.ts`
- 创建：`tests/unit/channel-node/imessage.test.ts`
- 创建：`tests/fixtures/channels/imessage/*.json`
- 创建：`docs/channels/imessage.md`
- 修改：`runners/channel-node/src/index.ts`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 iMessage 合同**

```ts
it("只读取启动游标之后且非本人发送的 Messages 行", async () => {
  const events = await pollMessages({ lastRowId: 40, rows: fixtureRows });
  expect(events.map((event) => event.externalEventId)).toEqual(["imessage:rowid:42"]);
  expect(events[0]).toMatchObject({ chatType: "direct", externalSenderId: "+8613800000000" });
});
```

覆盖 macOS 检测、chat.db 可读、完全磁盘访问、`imsg` 可执行、rowid cursor、is_from_me、bot_prefix、sender、1 秒 poll、10 MiB decoded 上限、send command 参数、group 明确 blocked。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channel-node/imessage.test.ts`

预期：FAIL，iMessage runner 未实现。

- [ ] **步骤 3：实现前置条件与只读查询**

配置包含 db_path、poll_sec、media_dir、max_decoded_size；启动要求 `process.platform === "darwin"`、`/usr/bin/sqlite3` 和 `imsg` 可用。每次使用 `sqlite3 -readonly -json` 查询 `message/chat_message_join/chat/handle`，参数 last rowid 用 argv，不拼 shell；启动先记录 MAX(ROWID)，不重放历史。

- [ ] **步骤 4：实现 node frame 与发送**

external ID `imessage:rowid:${rowid}`，conversation `chat:${chat_rowid}`，只支持 direct；附件先复制到 runner 私有临时目录并经中心白名单。发送使用 argv `["send","--to",handle,"--text",text]`，媒体只允许中心已批准私有文件，stderr 脱敏。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channel-node/imessage.test.ts tests/unit/channel-node/client.test.ts`

预期：PASS。

```bash
git add runners/channel-node/src/imessage runners/channel-node/src/index.ts src/server/channels/runtime/registry.ts tests/unit/channel-node/imessage.test.ts tests/fixtures/channels/imessage docs/channels/imessage.md
git commit -m "feat(P1-13): 接入 macOS iMessage 运行节点"
```

**回滚：** 吊销节点/解绑 connection；停止轮询，不修改 Messages 数据库。

**完成证据：** OS/FDA/imsg 前置、游标、忽略本人、direct、发送 argv、附件上限和 group blocked 测试。

### 任务 5：实现 Voice/Twilio ConversationRelay

**文件：**
- 创建：`src/server/channels/adapters/voice/{config,signature,twiml,relay,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/voice.test.ts`
- 创建：`tests/fixtures/channels/voice/*.json`
- 创建：`docs/channels/voice.md`
- 修改：`src/server/channels/gateway/router.ts`
- 修改：`src/server/channels/runtime/registry.ts`
- 修改：`src/server/admin/compat/handlers/channels.ts`
- 修改：`package.json`
- 修改：`package-lock.json`

- [ ] **步骤 1：编写失败的 Twilio 签名与 TwiML 测试**

```ts
it("只接受 Twilio 签名并生成 ConversationRelay TwiML", async () => {
  expect(verifyTwilioSignature(validRequest, authToken)).toBe(true);
  expect(verifyTwilioSignature(tamperedRequest, authToken)).toBe(false);
  expect(buildConversationRelayTwiml(config, "wss://mate.example/channel-gateway/voice/id/relay?token=once"))
    .toContain("<ConversationRelay");
});
```

覆盖 account/number 配置、single-use WS token、welcome greeting、TTS/STT provider/voice/language、prompt/interrupt/call end、最大并发、status callback、webhook 自动配置、音频不进入附件。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/voice.test.ts`

预期：FAIL，Voice Adapter 未实现。

- [ ] **步骤 3：固定 Twilio 依赖和配置**

运行：`npm install --save-exact twilio@6.0.2`

配置包含 `twilio_account_sid`、`twilio_auth_token`、`phone_number`、`phone_number_sid`、`tts_provider`、`tts_voice`、`stt_provider`、`language`、`welcome_greeting`。PUBLIC_BASE_URL 必须 HTTPS，否则 blocked。

- [ ] **步骤 4：实现签名、TwiML 与一次性 relay token**

incoming/status 验证 Twilio HMAC 签名；incoming 创建 32-byte token，只存 SHA-256，2 分钟过期且连接即消费。TwiML XML 属性来自已验证枚举并 XML escape；并发达到配置上限返回 busy TwiML。

- [ ] **步骤 5：实现 relay 到事件/Delivery**

每个 final prompt 生成 external ID `${callSid}:prompt:${sequence}` 和 direct conversation `${callSid}`；interrupt 只停止当前 TTS Delivery，不取消/重跑已持久 Agent。Delivery 通过 relay text frame发送完整答案的确定性 chunks，最后 `{type:"text",token:"",last:true}`。Twilio 原始音频不保存、不进入附件。

- [ ] **步骤 6：实现号码 webhook 配置**

启用时用 Twilio SDK 更新 phone_number_sid 的 voice_url/status_callback；超时 30 秒；失败 health degraded但不删除凭据。审计只记录号码尾四位和 configured 状态。

- [ ] **步骤 7：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/voice.test.ts tests/unit/channels/gateway/router.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/voice src/server/channels/gateway/router.ts src/server/channels/runtime/registry.ts src/server/admin/compat/handlers/channels.ts tests/unit/channels/adapters/voice.test.ts tests/fixtures/channels/voice docs/channels/voice.md package.json package-lock.json
git commit -m "feat(P1-13): 接入 Twilio 语音渠道"
```

**回滚：** disable connection、撤销号码 webhook 或改回用户记录的旧 URL；结束 relay session，保留文字事件/回复。

**完成证据：** 签名、一次 token、TwiML、prompt/interrupt、并发、webhook 配置和零音频附件测试。

### 任务 6：实现 SIP Dev 与 LiveKit runner

**文件：**
- 创建：`runners/channel-node/src/sip/{config,backend,registrar,rtp,session,stt,tts,livekit,transport}.ts`
- 创建：`tests/unit/channel-node/sip.test.ts`
- 创建：`tests/fixtures/channels/sip/*`
- 创建：`docs/channels/sip.md`
- 修改：`runners/channel-node/package.json`
- 修改：`runners/channel-node/package-lock.json`
- 修改：`runners/channel-node/src/index.ts`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 SIP backend 合同**

```ts
export function defineSipBackendContract(createBackend: () => SipBackend) {
  it("emits one final transcript event and plays PCM response", async () => {
    const backend = createBackend();
    const call = await backend.injectIncomingCall(callFixture);
    await call.injectPcm(pcmFixture);
    expect(inboundFrames).toContainEqual(expect.objectContaining({ payload: { text: "你好" } }));
    await call.deliverText("你好，我在。", deliveryId);
    expect(call.playedPcmBytes).toBeGreaterThan(0);
  });
}
```

Dev/LiveKit 都运行同一合同；覆盖 SIP INVITE/ACK/BYE、RTP sequence/timestamp、8k µ-law、24k PCM、STT final、TTS stream、barge-in、120 秒 timeout、5 并发、UDP 范围、凭据和 stop。SIP 是上游单测/合同双缺口，全部由本任务新增。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channel-node/sip.test.ts`

预期：FAIL，SIP runner 不存在。

- [ ] **步骤 3：固定 LiveKit 依赖与配置**

运行：

```bash
npm --prefix runners/channel-node install --save-exact livekit-server-sdk@2.17.0 @livekit/rtc-node@0.13.31
```

配置完整对应 `sip_mode`、host/port、username/password/server/transport、rtp low/high、dashscope key、tts/stt provider/voice/language/greeting、call timeout、LiveKit URL/key/secret/trunk/room/sample rate、max calls。

- [ ] **步骤 4：实现 Dev registrar、SIP 与 RTP**

Dev mode 无 sip_server 时只绑定 runner 本机 `127.0.0.1:5060` registrar；解析/生成 SIP 使用 CRLF、Call-ID/CSeq/Via/Contact；RTP 端口只从配置范围原子租用；µ-law/PCM 转换用有 golden fixture 的纯函数。外部部署必须显式配置防火墙，Console blocked 状态列出 UDP 端口。

- [ ] **步骤 5：实现 LiveKit backend**

使用 server SDK 发现/创建指定 room 和 SIP participant，rtc-node 接入 audio track；每 call 独立 session，room/call ID 映射 reply handle。LiveKit secret 只在 runner memory，中心仅持加密配置/节点绑定。

- [ ] **步骤 6：实现 STT/TTS 与中心事件**

DashScope STT 只发送 PCM并只接收 final transcript；external ID `${callId}:utterance:${sequence}`。中心返回文字 Delivery，runner TTS 成 20ms frame：Dev 160-byte 8k µ-law，LiveKit 960-byte 24k PCM16；barge-in 终止当前 TTS，不删除中心消息。原音频、partial transcript 和供应商 frame 不持久化。

- [ ] **步骤 7：运行两个 backend 合同、故障与隐私测试**

运行：`npm test -- --run tests/unit/channel-node/sip.test.ts tests/unit/channel-node/client.test.ts`

预期：PASS；Dev/LiveKit 同合同；端口耗尽 blocked；第 6 并发 busy；断点后同 utterance 不重复 Agent；数据扫描无 PCM/base64。

- [ ] **步骤 8：提交 SIP**

```bash
git add runners/channel-node/src/sip runners/channel-node/src/index.ts runners/channel-node/package.json runners/channel-node/package-lock.json src/server/channels/runtime/registry.ts tests/unit/channel-node/sip.test.ts tests/fixtures/channels/sip docs/channels/sip.md
git commit -m "feat(P1-13): 接入 SIP 与 LiveKit 媒体节点"
```

**回滚：** 解绑/吊销 SIP node；停止 registrar/room/track并释放 UDP；中心文字账本保留。

**完成证据：** 两 backend 合同、SIP/RTP golden、STT/TTS、barge-in、timeout/concurrency、端口和零音频持久化测试。

### 任务 7：特殊渠道 Console 与节点管理合同

**文件：**
- 修改：`src/server/admin/compat/handlers/channels.ts`
- 修改：`src/server/admin/compat/register-core.ts`
- 修改：`patches/qwenpaw-console/0004-api-compat.patch`
- 修改：`tests/unit/admin-compat-channels.test.ts`
- 创建：`tests/unit/admin-compat-nodes.test.ts`

- [ ] **步骤 1：编写失败的节点管理和 blocked 状态测试**

```ts
it.each([
  ["imessage", "macos_node_required"],
  ["sip", "media_node_required"],
  ["voice", "public_https_required"],
  ["onebot", "companion_service_required"],
])("%s 缺前置条件时显示 blocked", async (type, reason) => {
  const health = await compatJson("GET", `/config/channels/${type}/health`);
  expect(health).toMatchObject({ status: "blocked", reason });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/admin-compat-channels.test.ts tests/unit/admin-compat-nodes.test.ts`

预期：FAIL，节点端点与 blocked reason 未实现。

- [ ] **步骤 3：实现节点注册与证书生命周期**

注册请求创建一次 enrollment token（只存 hash，10 分钟），管理员下载包含 CA/短期 client cert/key 的加密 bundle；首次 mTLS 成功后 token 失效。Console 可以绑定/解绑 connection、rotate/revoke cert、查看最后心跳/版本/支持渠道/outbox；任何响应不回传已签发私钥。

- [ ] **步骤 4：实现特殊前置条件判定**

iMessage 要求 online macOS node + imsg/FDA health；SIP 要求 media node + 对应 backend health；Voice 要求 HTTPS public base URL + Twilio configured；OneBot 要求至少一个 companion socket。缺失时 enable 保存可以成功但状态 blocked，不伪装 connected。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/admin-compat-channels.test.ts tests/unit/admin-compat-nodes.test.ts tests/unit/channels/gateway`

预期：PASS。

```bash
git add src/server/admin/compat/handlers/channels.ts src/server/admin/compat/register-core.ts patches/qwenpaw-console/0004-api-compat.patch tests/unit/admin-compat-channels.test.ts tests/unit/admin-compat-nodes.test.ts
git commit -m "feat(P1-13): 增加渠道节点与特殊前置条件管理"
```

**回滚：** 禁用 enrollment；已签发证书逐个 revoke；特殊渠道保持 blocked。

**完成证据：** enrollment、一次 token、rotate/revoke、binding、heartbeat 和四类 blocked 测试。

### 任务 8：M4-C 与 17 渠道完整性验收

**文件：**
- 创建：`docs/verification/channels-edge-m4c.md`
- 修改：`docs/verification/qwenpaw-channel-parity.md`
- 修改：`src/server/channels/runtime/registry.ts`
- 修改：`tests/unit/admin-compat-channels.test.ts`

- [ ] **步骤 1：断言 17 个 manifest 和 Adapter 无缺口**

```ts
expect(registry.registeredTypes().sort()).toEqual([
  "dingtalk", "discord", "feishu", "imessage", "mattermost", "matrix", "mqtt",
  "onebot", "qq", "sip", "slack", "telegram", "voice", "wechat", "wecom",
  "xiaoyi", "yuanbao",
]);
expect(manifestCatalog.keys().sort()).toEqual(registry.registeredTypes().sort());
```

- [ ] **步骤 2：运行四特殊渠道、节点与全渠道合同**

```bash
npm test -- --run tests/unit/channels/adapters/onebot.test.ts tests/unit/channels/adapters/voice.test.ts tests/unit/channel-node/imessage.test.ts tests/unit/channel-node/sip.test.ts tests/unit/channels/gateway tests/unit/channel-node/client.test.ts
npm test -- --run tests/unit/channels tests/integration/channels
npm run channel-node:build
```

预期：全部 PASS。

- [ ] **步骤 3：完成 17 渠道上游对照账本**

在 `docs/verification/qwenpaw-channel-parity.md` 增加 OneBot v11、iMessage、Voice/Twilio、SIP 四行。OneBot/SIP 上游合同缺失分别标记 `missing_upstream` 并指向 DigitalMate 合同；每行记录 source hash、配置字段、unit/contract 测试、Adapter/runner、操作文档和因 TypeScript/受限节点产生的刻意差异。

运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require-all
```

预期：PASS；账本、固定上游渠道目录、manifest 和 registry 的渠道集合完全等于全局 17 类型，任何多项、缺项、hash 漂移或空证据退出 1。

- [ ] **步骤 4：记录外部条件与上游缺口**

`docs/verification/channels-edge-m4c.md` 记录 OneBot 和 SIP 的 DigitalMate 新合同覆盖、iMessage macOS/FDA、OneBot 风控、Twilio 公网/号码、SIP UDP/PBX/LiveKit。无对应条件时标 `pending_external`，不能是 `smoke_verified`。

- [ ] **步骤 5：运行隐私、依赖与全仓验证**

```bash
npm run typecheck
npm test
npm run build
node scripts/qwenpaw-console/audit-channel-parity.mjs --require-all
rg -n "DATABASE_URL|KIE_AI_API_KEY|SEARCH_PROVIDER|GITHUB_TOKEN" runners/channel-node
rg -n "runAgent|web-search|repositories\.memories|repositories\.messages" src/server/channels/adapters runners/channel-node
git diff --check
```

预期：前三项 PASS；runner 只在拒绝配置的测试中出现禁用 env 名称；Adapter/runner 无大脑依赖。

- [ ] **步骤 6：里程碑提交**

```bash
git add docs/verification/channels-edge-m4c.md docs/verification/qwenpaw-channel-parity.md src/server/channels/runtime/registry.ts tests/unit/admin-compat-channels.test.ts
git commit -m "chore(P1-13): 完成特殊渠道与十七渠道 M4 验收"
```

**回滚：** 四个 connection/node 可独立下线；中心 Web 与其他 13 渠道不受影响。

**完成证据：** 17 项 registry equality、四份特殊文档、节点/语音合同和状态准确的 smoke 矩阵。
