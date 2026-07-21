# 六个协议与平台专有渠道实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M4-B：实现 MQTT、Matrix、企业微信、小艺、腾讯元宝和微信 iLink 六个渠道，补齐上游缺失的合同测试，并保持 secret、附件与单执行红线。

**架构：** MQTT/Matrix 使用成熟协议库；企业微信使用长连接 SDK；小艺、元宝、微信按 QwenPaw 固定版本的认证、心跳、消息和重连语义移植为 TypeScript。二维码、context token、临时媒体凭据和 Protobuf 认证数据均只进入短期加密存储。

**技术栈：** MQTT.js、matrix-js-sdk、WeCom AIBot SDK、WebSocket、protobufjs、Node crypto、HTTP long polling、Vitest。

---

## 文件结构

**创建：**

- `src/server/channels/adapters/mqtt/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/matrix/{config,normalize,transport,index}.ts`
- `src/server/channels/adapters/wecom/{config,normalize,transport,media,index}.ts`
- `src/server/channels/adapters/xiaoyi/{config,auth,protocol,transport,index}.ts`
- `src/server/channels/adapters/yuanbao/{config,auth,codec,media,transport,index}.ts`
- `src/server/channels/adapters/yuanbao/proto/{conn,biz}.json`
- `src/server/channels/adapters/yuanbao/UPSTREAM.md`
- `src/server/channels/adapters/wechat/{config,auth,crypto,client,normalize,transport,index}.ts`
- `tests/unit/channels/adapters/{mqtt,matrix,wecom,xiaoyi,yuanbao,wechat}.test.ts`
- `tests/fixtures/channels/{mqtt,matrix,wecom,xiaoyi,yuanbao,wechat}/*`：脱敏协议 frame、二进制帧、响应和错误样本。
- `docs/channels/{mqtt,matrix,wecom,xiaoyi,yuanbao,wechat}.md`
- `docs/verification/channels-protocol-m4b.md`

**修改：**

- `package.json`、`package-lock.json`：固定四个协议依赖。
- `src/server/channels/runtime/registry.ts`：注册六个 Adapter。
- `src/server/channels/manifests/catalog.ts`：校准六个 schema、secret 和 prerequisite。
- `src/server/admin/compat/handlers/channels.ts`：微信二维码 session、状态轮询和准确外部资格状态。
- `patches/qwenpaw-console/0004-api-compat.patch`：复用 QwenPaw QR block，显示 blocked/pending_external。

### 任务 1：固定协议依赖和二进制 fixture 工具

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`src/server/channels/testing/binary-fixtures.ts`
- 修改：`src/server/channels/testing/contract.ts`
- 修改：`tests/unit/channels/adapter-boundary.test.ts`

- [ ] **步骤 1：编写失败的二进制合同自测**

```ts
it("二进制 fixture 按哈希验证且不会输出 secret hex", async () => {
  const fixture = await readBinaryFixture("tests/fixtures/channels/yuanbao/auth-bind.bin");
  expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(redactBinaryDiagnostic(fixture.bytes, [Buffer.from("secret")])).not.toContain("736563726574");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts`

预期：FAIL，binary fixture helper 尚不存在。

- [ ] **步骤 3：固定依赖版本**

运行：

```bash
npm install --save-exact mqtt@5.15.2 matrix-js-sdk@41.9.0 @wecom/aibot-node-sdk@1.0.7 protobufjs@8.7.1
```

预期：lockfile 固定确切版本；许可证分别为 MIT、Apache-2.0、MIT、BSD-3-Clause；`npm audit --omit=dev` 没有 high/critical 未处置项。

- [ ] **步骤 4：实现 fixture 哈希与脱敏工具**

```ts
export async function readBinaryFixture(file: string) {
  const bytes = await readFile(file);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function redactBinaryDiagnostic(bytes: Buffer, secrets: readonly Buffer[]) {
  let hex = bytes.toString("hex");
  for (const secret of secrets) hex = hex.replaceAll(secret.toString("hex"), "[redacted]");
  return hex.slice(0, 512);
}
```

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- --run tests/unit/channels/adapter-boundary.test.ts && npm run typecheck`

预期：PASS。

```bash
git add package.json package-lock.json src/server/channels/testing/binary-fixtures.ts src/server/channels/testing/contract.ts tests/unit/channels/adapter-boundary.test.ts
git commit -m "test(P1-13): 增加协议渠道二进制合同工具"
```

**回滚：** 移除尚未使用的依赖与 helper。

**完成证据：** 依赖锁、许可证、audit 和二进制 secret 脱敏测试。

### 任务 2：实现 MQTT Broker 渠道

**文件：**
- 创建：`src/server/channels/adapters/mqtt/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/mqtt.test.ts`
- 创建：`tests/fixtures/channels/mqtt/*.json`
- 创建：`docs/channels/mqtt.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 MQTT 合同**

```ts
defineChannelContract(mqttContract({
  expectedEventId: "mqtt:devices/device-7/in:packet-41",
  inputForms: ["plain text", "json text"],
  qos: [0, 1, 2],
  tls: true,
}));
```

测试 JSON `{text,redirect_client_id,event_id}`、纯文本、从 topic 第二段推导 client ID、无 ID 使用 packet ID、subscribe/publish topic、clean session、QoS、TLS CA/client cert/key、retain=false、连接返回码与 stop。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/mqtt.test.ts`

预期：FAIL，MQTT Adapter 未实现。

- [ ] **步骤 3：实现配置和稳定事件 ID**

```ts
export const mqttConfigSchema = baseChannelConfigSchema.extend({
  host: z.string().min(1), port: z.number().int().min(1).max(65535).default(1883),
  transport: z.enum(["tcp", "tls", "ws", "wss"]), clean_session: z.boolean(),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  username: z.string().nullable(), password: z.string().nullable(),
  subscribe_topic: z.string().min(1), publish_topic: z.string().min(1),
  tls_enabled: z.boolean(), tls_ca_certs: z.string().nullable(),
  tls_certfile: z.string().nullable(), tls_keyfile: z.string().nullable(),
});
```

事件 ID 优先 payload `event_id`，否则 `${topic}:${packet.messageId}`；QoS 0 缺 broker message ID 时使用 `sha256(topic + payload + receivedAtBucket)` 并在文档说明 QoS 0 无平台级 exactly-once 保证。

- [ ] **步骤 4：实现 MQTT.js 生命周期和发送**

连接成功订阅；消息 listener 只调用 Ingress。输出 JSON 固定 `{id,reply_to,text,created_at}`，topic 支持 `{client_id}` 替换；publish callback 成功才完成 Delivery attempt。TLS 私钥从加密 secret 解密到内存 Buffer，不写临时文件或 health detail。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/mqtt.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/mqtt src/server/channels/runtime/registry.ts tests/unit/channels/adapters/mqtt.test.ts tests/fixtures/channels/mqtt docs/channels/mqtt.md
git commit -m "feat(P1-13): 接入 MQTT 渠道"
```

**回滚：** unsubscribe/end connection；queued Delivery 保留。

**完成证据：** JSON/plain、ID、QoS、TLS、topic routing、publish ACK 和 stop 测试。

### 任务 3：实现 Matrix Sync 与加密房间

**文件：**
- 创建：`src/server/channels/adapters/matrix/{config,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/matrix.test.ts`
- 创建：`tests/fixtures/channels/matrix/*.json`
- 创建：`docs/channels/matrix.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Matrix 合同**

```ts
defineChannelContract(matrixContract({
  expectedEventId: "$event-123:example.org",
  syncTimeoutMs: 30_000,
  encryptedRoom: true,
  structuredMentions: true,
}));
```

覆盖 access token/password login、sync token、DM/room、group allowlist、m.room.message、edit relation ignore、reply relation、m.mentions、HTML pill、E2EE device、history limit、vision flag、429 retry_after_ms。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/matrix.test.ts`

预期：FAIL，Matrix Adapter 未实现。

- [ ] **步骤 3：实现配置与 client 安全存储**

配置逐项包含 homeserver、user_id、access_token、password、device_name、group_allow_from、groups、encryption、vision_enabled、history_limit、sync_timeout_ms、mention_pill_in_body、outbound_structured_mentions、streaming_enabled。access token 是 secret；crypto store 放 `data/matrix/connections/{connection_id}` 私有目录并以 agent/connection 校验，不进入个人数据导出，只能进入 M5 使用独立备份密钥加密的完整灾难恢复包。

- [ ] **步骤 4：实现 sync、E2EE 与发送**

使用 `matrix-js-sdk@41.9.0`；`startClient({initialSyncLimit:history_limit})`，prepared 后 connected。event ID 直接用 Matrix event ID；DM 判定使用房间成员数和 direct mapping，group 仍经 access rules。发送 `m.room.message`，reply 保留 `m.relates_to.m.in_reply_to`，structured mention 使用 `m.mentions`；streaming 用 `m.replace` 编辑同一 event。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/matrix.test.ts`

预期：PASS；encrypted fixture 可解密后进入 Ingress，密钥数据库不出现在 API/export。

```bash
git add src/server/channels/adapters/matrix src/server/channels/runtime/registry.ts tests/unit/channels/adapters/matrix.test.ts tests/fixtures/channels/matrix docs/channels/matrix.md
git commit -m "feat(P1-13): 接入 Matrix 加密渠道"
```

**回滚：** stop client 并保留 crypto store 供重新启用；删除连接时按清空协议物理删除 store 后删 DB。

**完成证据：** login/sync、DM/room、reply/mention/edit、E2EE、429、crypto privacy 和 stop 测试。

### 任务 4：实现企业微信 AIBot 长连接

**文件：**
- 创建：`src/server/channels/adapters/wecom/{config,normalize,transport,media,index}.ts`
- 创建：`tests/unit/channels/adapters/wecom.test.ts`
- 创建：`tests/fixtures/channels/wecom/*.json`
- 创建：`docs/channels/wecom.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的企业微信合同**

```ts
defineChannelContract(wecomContract({
  expectedEventId: "wecom:message:msg-7001",
  requiredSecrets: ["secret"],
  streamingMode: "ws-stream",
  mediaMode: "chunked-ws",
}));
```

覆盖 bot_id/secret、welcome_text、DM/group、share_session_in_group、@、长连接 ACK、streaming、media chunk upload/download、max reconnect -1、缺资格/权限和 stop。该渠道是上游合同缺口，所有断言为 DigitalMate 新增。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/wecom.test.ts`

预期：FAIL，企业微信 Adapter 未实现。

- [ ] **步骤 3：实现配置与 SDK 包装边界**

```ts
export const wecomConfigSchema = baseChannelConfigSchema.extend({
  bot_id: z.string().min(1), secret: z.string().min(1), welcome_text: z.string(),
  share_session_in_group: z.boolean(), max_reconnect_attempts: z.number().int(),
  streaming_enabled: z.boolean(),
});
```

只在 transport.ts 导入 `@wecom/aibot-node-sdk`。SDK callback 解析 command/frame ID作为 external event ID，先 Ingress commit 再回 SDK ACK；SDK 不接 Agent callback。

- [ ] **步骤 4：实现发送、streaming 和媒体**

回复绑定 frame context；streaming 帧只更新同一 Delivery；媒体通过 SDK WebSocket 分块接口，下载先进入 M3 attachment locator。`filter_thinking` 和 `filter_tool_messages` 强制 true，卡片不出现推理/工具详情。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/wecom.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/wecom src/server/channels/runtime/registry.ts tests/unit/channels/adapters/wecom.test.ts tests/fixtures/channels/wecom docs/channels/wecom.md
git commit -m "feat(P1-13): 接入企业微信长连接渠道"
```

**回滚：** stop SDK client；未发送 Delivery 保留。

**完成证据：** 新增全合同、DM/group/session、ACK、stream/media、无限重连停止和资格错误测试。

### 任务 5：实现小艺 A2A 双 WebSocket

**文件：**
- 创建：`src/server/channels/adapters/xiaoyi/{config,auth,protocol,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/xiaoyi.test.ts`
- 创建：`tests/fixtures/channels/xiaoyi/*.json`
- 创建：`docs/channels/xiaoyi.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的小艺合同**

```ts
defineChannelContract(xiaoyiContract({
  expectedEventId: "xiaoyi:task:task-9901:message-1",
  sockets: [
    "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
    "wss://116.63.174.231/openclaw/v1/ws/link",
  ],
  textChunkLimit: 4000,
}));
```

覆盖 AK/SK/agent ID header、HMAC、毫秒 timestamp、主备双连接、task 生命周期、30 秒 heartbeat、1/2/5/10/30/60 秒退避、50 次重连、1 小时 task timeout、文本/媒体 frame 和资格 blocked。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/xiaoyi.test.ts`

预期：FAIL，小艺 Adapter 未实现。

- [ ] **步骤 3：实现可验证认证函数**

```ts
export function xiaoyiAuthHeaders(input: { ak: string; sk: string; agentId: string; timestampMs: number }) {
  const timestamp = String(input.timestampMs);
  const signature = createHmac("sha256", input.sk).update(timestamp).digest("base64");
  return { "x-access-key": input.ak, "x-sign": signature, "x-ts": timestamp, "x-agent-id": input.agentId };
}
```

- [ ] **步骤 4：实现双连接、task 和发送状态机**

两个 socket 独立重连但共享 task registry；同 task/message 来自双连接时靠 external event ID去重。接收 task frame 规范化为文字或允许媒体 descriptor；Delivery 按 4000 Unicode code points 分段并发送 task progress/final；thinking frame 永不发送。两个 socket 都断开才标 disconnected。

- [ ] **步骤 5：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/xiaoyi.test.ts`

预期：PASS。

```bash
git add src/server/channels/adapters/xiaoyi src/server/channels/runtime/registry.ts tests/unit/channels/adapters/xiaoyi.test.ts tests/fixtures/channels/xiaoyi docs/channels/xiaoyi.md
git commit -m "feat(P1-13): 接入小艺 A2A 渠道"
```

**回滚：** 同时 stop 两个 socket；task registry 结束并保留 Delivery 状态。

**完成证据：** HMAC fixture、双连接 dedup、heartbeat/退避、task timeout、分段和资格错误测试。

### 任务 6：实现腾讯元宝 Protobuf WebSocket

**文件：**
- 创建：`src/server/channels/adapters/yuanbao/{config,auth,codec,media,transport,index}.ts`
- 创建：`src/server/channels/adapters/yuanbao/proto/{conn,biz}.json`
- 创建：`src/server/channels/adapters/yuanbao/UPSTREAM.md`
- 创建：`tests/unit/channels/adapters/yuanbao.test.ts`
- 创建：`tests/fixtures/channels/yuanbao/*`
- 创建：`docs/channels/yuanbao.md`
- 修改：`src/server/channels/runtime/registry.ts`

- [ ] **步骤 1：编写失败的 Protobuf golden 测试**

```ts
it("与固定 QwenPaw 描述符编码的 AuthBind 帧一致", async () => {
  const encoded = codec.encodeAuthBind(authFixture);
  const golden = await readFile("tests/fixtures/channels/yuanbao/auth-bind.bin");
  expect(encoded).toEqual(golden);
  expect(codec.decodeAuthBindResponse(await readFile("tests/fixtures/channels/yuanbao/auth-bind-rsp.bin")))
    .toMatchObject({ code: 0 });
});
```

合同覆盖 C2C/group、sign-token、AuthBind、Ping/Pong、typing heartbeat、2800 分段、media temp credentials、no-reconnect close codes、auth refresh 和发送 correlation。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/yuanbao.test.ts`

预期：FAIL，codec 与描述符不存在。

- [ ] **步骤 3：固定描述符来源与哈希**

从 QwenPaw commit `fef7e64d984f4332d0b84a343cd209bd3ea5d316` 的 `src/qwenpaw/app/channels/yuanbao/proto/conn.json`、`biz.json` 原样复制；`UPSTREAM.md` 记录来源 URL、SHA-256、Apache-2.0 和“运行时为 TypeScript codec”的差异。测试验证两个文件哈希。

- [ ] **步骤 4：实现 sign-token**

nonce 为 16-byte hex；北京时区 timestamp 格式 `YYYY-MM-DDTHH:mm:ss+08:00`；signature 为 `HMAC-SHA256(appSecret, nonce+timestamp+appId+appSecret)` hex；POST `https://{api_domain}/api/v5/robotLogic/sign-token`。code 10099 最多重试 3 次；token 提前 300 秒 single-flight 刷新。

- [ ] **步骤 5：实现 codec、连接和媒体**

使用 protobufjs 加载两个 JSON descriptor；连接 `wss://bot-wss.yuanbao.tencent.com/wss/connection`，AuthBind 后按 server interval heartbeat；4012/4013/4014/4018/4019/4021 不重连；41103/41104/41108 刷 token。media 通过 `/api/resource/genUploadInfo` 和 `/api/resource/v1/download`，临时 COS 凭据只在内存/加密 locator，20 MiB 以上拒绝。

- [ ] **步骤 6：运行 golden、合同和 secret 扫描**

运行：`npm test -- --run tests/unit/channels/adapters/yuanbao.test.ts`

预期：PASS；binary golden 完全一致；日志/API/export 无 token、app_secret、COS key。

- [ ] **步骤 7：提交元宝**

```bash
git add src/server/channels/adapters/yuanbao src/server/channels/runtime/registry.ts tests/unit/channels/adapters/yuanbao.test.ts tests/fixtures/channels/yuanbao docs/channels/yuanbao.md
git commit -m "feat(P1-13): 接入腾讯元宝 Protobuf 渠道"
```

**回滚：** stop socket、取消 token refresh、清临时凭据；descriptor 保留许可记录。

**完成证据：** 描述符哈希、binary golden、auth/refresh、close code、typing、media 和 C2C/group 测试。

### 任务 7：实现微信 iLink、二维码和 context token

**文件：**
- 创建：`src/server/channels/adapters/wechat/{config,auth,crypto,client,normalize,transport,index}.ts`
- 创建：`tests/unit/channels/adapters/wechat.test.ts`
- 创建：`tests/fixtures/channels/wechat/*.json`
- 创建：`docs/channels/wechat.md`
- 修改：`src/server/admin/compat/handlers/channels.ts`
- 修改：`src/server/channels/runtime/registry.ts`
- 修改：`patches/qwenpaw-console/0004-api-compat.patch`

- [ ] **步骤 1：编写失败的微信合同与 QR 测试**

```ts
it("QR session 确认后只保存加密 bot token 并销毁 poll token", async () => {
  const qr = await compatJson("GET", "/config/channels/wechat/qrcode");
  await fakeIlink.confirm(qr.poll_token, { bot_token: "wx-secret", baseurl: "https://ilinkai.weixin.qq.com" });
  const status = await compatJson("GET", `/config/channels/wechat/qrcode/status?token=${qr.poll_token}`);
  expect(status).toMatchObject({ status: "confirmed", credentials: { bot_token: "configured" } });
  expect(JSON.stringify(status)).not.toContain("wx-secret");
  await expect(qrSessions.get(qr.poll_token)).resolves.toBeNull();
});
```

合同覆盖 getupdates cursor、context_token 去重/消费、ret -1 timeout、ret -2 token invalid、typing ticket、message merge、AES media、X-WECHAT-UIN、二维码 waiting/scanned/confirmed/expired 和内测资格 blocked。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --run tests/unit/channels/adapters/wechat.test.ts tests/unit/admin-compat-channels.test.ts`

预期：FAIL，微信 Adapter 与 QR session 不存在。

- [ ] **步骤 3：实现 client header 与二维码 session**

每请求生成随机 uint32 的十进制字符串再 base64，作为 `X-WECHAT-UIN`；header 固定 `AuthorizationType: ilink_bot_token`。GET `/ilink/bot/get_bot_qrcode?bot_type=3`，轮询 `/ilink/bot/get_qrcode_status`；session 5 分钟过期，poll token 只保存 HMAC hash；确认时事务写加密 bot token/base URL并销毁 session。

- [ ] **步骤 4：实现 long poll、context token 和消息合并**

POST `/ilink/bot/getupdates` 带 cursor 和 `channel_version:2.0.1`，45 秒 timeout；event ID 优先 context_token，fallback `from_user_id:msg_id`。reply handle 加密保存 context_token；sendmessage 使用一次 token，ret -2 标 handle invalid且不重新运行 Agent。merge delay 0 合并整条 Delivery 文本一次发送，大于 0 只合并窗口内相邻 segments。

- [ ] **步骤 5：实现 typing 与 AES 媒体**

getconfig 取得 typing_ticket，sendtyping status 1/2；媒体 AES key 支持 raw hex、base64 raw 16 bytes、base64 hex，使用 Node `aes-128-ecb` + PKCS7，解密后仍走 M3 whitelist/magic/size；voice/video 不作为主模型附件。

- [ ] **步骤 6：运行合同并提交**

运行：`npm test -- --run tests/unit/channels/adapters/wechat.test.ts tests/unit/admin-compat-channels.test.ts`

预期：PASS；所有 QR/token/context 临时数据在完成/过期后清理。

```bash
git add src/server/channels/adapters/wechat src/server/admin/compat/handlers/channels.ts src/server/channels/runtime/registry.ts tests/unit/channels/adapters/wechat.test.ts tests/fixtures/channels/wechat docs/channels/wechat.md patches/qwenpaw-console/0004-api-compat.patch
git commit -m "feat(P1-13): 接入微信 iLink 渠道"
```

**回滚：** stop long poll、撤销连接 secret、清 QR session；既有事件/Delivery 保留。

**完成证据：** QR 全状态、cursor、context token、ret 语义、typing、merge、AES 和资格 blocked 测试。

### 任务 8：M4-B 六渠道总验证

**文件：**
- 创建：`docs/verification/channels-protocol-m4b.md`
- 修改：`docs/verification/qwenpaw-channel-parity.md`
- 修改：`src/server/channels/runtime/registry.ts`
- 修改：`tests/unit/admin-compat-channels.test.ts`

- [ ] **步骤 1：断言六个 Adapter 全部注册**

```ts
expect(registry.registeredTypes()).toEqual(expect.arrayContaining([
  "mqtt", "matrix", "wecom", "xiaoyi", "yuanbao", "wechat",
]));
```

- [ ] **步骤 2：运行六渠道合同与运行时回归**

```bash
npm test -- --run tests/unit/channels/adapters/mqtt.test.ts tests/unit/channels/adapters/matrix.test.ts tests/unit/channels/adapters/wecom.test.ts tests/unit/channels/adapters/xiaoyi.test.ts tests/unit/channels/adapters/yuanbao.test.ts tests/unit/channels/adapters/wechat.test.ts
npm test -- --run tests/unit/channels tests/integration/channels
```

预期：全部 PASS。

- [ ] **步骤 3：补齐六个协议渠道的上游对照证据**

在 `docs/verification/qwenpaw-channel-parity.md` 增加 MQTT、Matrix、企业微信、小艺、元宝、微信 iLink 六行，逐项记录固定上游 source hash、配置字段、unit/contract 测试和本地对应物；企业微信、小艺、元宝、微信的上游合同缺口必须写 `missing_upstream` 并指向 DigitalMate 新增合同。

运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require telegram,discord,slack,mattermost,feishu,dingtalk,qq,mqtt,matrix,wecom,xiaoyi,yuanbao,wechat
```

预期：PASS；账本恰好覆盖已完成的 13 个渠道且所有引用文件存在，任何 hash 漂移或空缺口说明退出 1。

- [ ] **步骤 4：记录上游测试缺口的补齐证据**

`docs/verification/channels-protocol-m4b.md` 明确企业微信、小艺、元宝、微信四个上游合同缺口已由哪些 DigitalMate 测试覆盖；MQTT、Matrix 记录与上游合同的 golden/行为对应关系。每渠道标 `automated_verified`、`pending_external` 或 `smoke_verified`，不得把内测资格缺失显示为可用。

- [ ] **步骤 5：运行全仓、secret 和边界扫描**

```bash
npm run typecheck
npm test
npm run build
node scripts/qwenpaw-console/audit-channel-parity.mjs --require telegram,discord,slack,mattermost,feishu,dingtalk,qq,mqtt,matrix,wecom,xiaoyi,yuanbao,wechat
rg -n "runAgent|web-search|repositories\.memories|repositories\.messages" src/server/channels/adapters
rg -n "bot_token|context_token|app_secret|client_secret|x-sign" docs/verification --glob '*.md'
git diff --check
```

预期：前三项 PASS；Adapter 脑依赖无命中；验证文档只出现字段名，不出现值。

- [ ] **步骤 6：里程碑提交**

```bash
git add docs/verification/channels-protocol-m4b.md docs/verification/qwenpaw-channel-parity.md src/server/channels/runtime/registry.ts tests/unit/admin-compat-channels.test.ts
git commit -m "chore(P1-13): 完成六个协议渠道 M4-B 验收"
```

**回滚：** 六个 connection 可独立 disable；二维码和临时凭据按租约清除。

**完成证据：** 六份文档、六份合同、四个上游缺口补齐和真实平台状态矩阵。
