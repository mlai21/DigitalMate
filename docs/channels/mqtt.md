# MQTT 渠道

MQTT 渠道通过一个长期 Broker 连接订阅设备消息，并把 DigitalMate 的完整回复发布到对应设备主题。它不支持附件，也不会因为消息内容自行获得联网、工具或后台任务权限。

## 配置

| 字段 | 说明 |
| --- | --- |
| `host` / `port` | Broker 主机与端口；端口默认 `1883` |
| `transport` | `tcp`、`tls`、`ws` 或 `wss` |
| `clean_session` | MQTT clean session |
| `qos` | 订阅和发布使用的 QoS：`0`、`1` 或 `2` |
| `username` / `password` | 可选 Broker 凭据 |
| `subscribe_topic` | 入站订阅主题，允许合法的 `+`、`#` 通配符 |
| `publish_topic` | 出站主题，不允许 MQTT 通配符，可包含 `{client_id}` |
| `tls_enabled` | 对 `tcp`/`ws` 强制升级为 `mqtts`/`wss` |
| `tls_ca_certs` | 可选 CA 证书 PEM 内容 |
| `tls_certfile` / `tls_keyfile` | 可选客户端证书与私钥 PEM 内容，必须成对配置 |

证书和私钥由加密渠道配置解密后直接转换成内存 `Buffer`；实现不会创建临时证书文件，也不会把凭据、原始载荷或 Broker 错误文本写入健康状态。

## 入站格式

入站消息支持两种形式：

```json
{
  "text": "设备温度 23°C",
  "redirect_client_id": "device-7",
  "event_id": "event-9001"
}
```

也可直接发送 UTF-8 纯文本。`redirect_client_id` 缺省时，客户端 ID 取 topic 的第二段，例如 `devices/device-7/in` 对应 `device-7`。

事件 ID 的优先级是：

1. JSON `event_id`；
2. Broker packet `messageId`；
3. 仅对 QoS 0，使用 `topic + payload + 30 秒接收时间窗` 的 SHA-256。

QoS 0 的哈希只能抑制同一时间窗内的重复投递。跨时间窗、进程时钟变化或 Broker 重发时，没有平台级 exactly-once 保证。Broker packet ID 也会在后续会话中复用，因此需要长期、严格幂等的设备必须在载荷中提供业务级稳定 `event_id`。

无效 UTF-8、空文本、危险客户端 ID 和超过 1 MiB 的载荷会被忽略。MQTT 消息没有附件入口。对 QoS 1/2，运行时只有在统一 Ingress 已完成持久化或确认重复后才允许 MQTT.js 回 ACK；持久化失败会让连接失败并等待 Broker 重投。

## 出站格式

`publish_topic` 中所有 `{client_id}` 会替换为已校验的客户端 ID。发布载荷固定为：

```json
{
  "id": "delivery-id",
  "reply_to": "mqtt:devices/device-7/in:event-9001",
  "text": "完整回复",
  "created_at": "2026-07-26T00:00:00.000Z"
}
```

发布固定使用 `retain=false`。只有 MQTT.js 的 publish callback 成功返回后，Delivery attempt 才会完成；认证、权限和限流错误使用稳定错误码，网络错误允许按渠道 Delivery 策略重试。

## 停止与回滚

禁用、改配或关闭服务时，运行时会中止 listener 并关闭 MQTT 连接。已经持久化的待发送 Delivery 不会被删除，重新启用连接后仍可继续处理。

## 人工冒烟

1. 启动测试 Broker，分别验证 `tcp`、`tls`、`ws`、`wss`。
2. 使用正确凭据连接，确认成功订阅 `subscribe_topic`。
3. 发送 JSON 消息，确认客户端 ID 和 `event_id` 路由正确。
4. 发送纯文本，确认从 topic 第二段得到客户端 ID。
5. 使用 QoS 1/2 且不传 `event_id`，确认使用 packet message ID。
6. 连续发送相同 QoS 0 消息，确认同一 30 秒窗内只接受一次。
7. 检查出站 topic 替换、固定 JSON 和 `retain=false`。
8. 分别制造错误凭据、无发布权限、断网和服务停止，确认健康状态不含凭据且连接被关闭。
