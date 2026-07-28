# QwenPaw 渠道对齐账本

基线固定为 QwenPaw `v2.0.0.post3`，commit
`fef7e64d984f4332d0b84a343cd209bd3ea5d316`。本账本覆盖 M4-A
七个标准渠道、M4-B 的 MQTT、Matrix、企业微信、小艺、腾讯元宝和微信
iLink，以及 M4-C 的 OneBot v11、iMessage、Voice/Twilio 和 SIP。它不是
实际平台可用性声明；标准渠道外部联调见
[`channels-standard-m4a.md`](./channels-standard-m4a.md)，协议渠道验收见
[`channels-protocol-m4b.md`](./channels-protocol-m4b.md)，特殊渠道验收见
[`channels-edge-m4c.md`](./channels-edge-m4c.md)。

`source_sha256` 的计算方式是：先由 M1 校验整个只读快照和
`SHA256SUMS`，再取该渠道目录下全部文件的已验证清单行，按 POSIX
路径排序、保留 `SHA256SUMS` 行格式后计算 SHA-256。配置字段由固定
`config.py` 中 `BaseChannelConfig` 与渠道子类合并得到；第二份固定配置
路由文件也纳入证据边界。`digitalmate.evidence_sha256` 对账本列出的本地
Adapter 或 runner、测试和渠道文档逐文件计算 SHA-256，再对排序后的清单
计算集合摘要，防止路径仍在但实现或测试内容被清空、替换。
`config_decisions.default` 适用于全部上游字段，`exceptions` 只记录有意
收紧或兼容处理的字段。

M4-B 与 M4-C 中由中心保存密钥的渠道还固定记录
`digitalmate.secret_fields`；审计测试会把该集合与运行时 manifest 及
Console 返回的 `password` 字段做精确比较，防止凭据字段退化为普通配置。
SIP 凭据只允许写入受限媒体节点，不属于中心密钥集合。JSON 中的 `status`
只表示代码自动化状态，本阶段必须是 `automated_verified`；真实平台状态由
单独 smoke 矩阵维护，无外部证据不能写成 `smoke_verified`。

| 渠道 | 上游源集合 SHA-256 | 上游 unit / contract | DigitalMate 状态 | 外部状态 |
| --- | --- | --- | --- | --- |
| Telegram | `a4732b7603ccae46e4b9cf4b05a0e0e10d0c9d2db1fe50ebe792d5e4e2acb71d` | 均存在 | `automated_verified` | `pending_external` |
| Discord | `7fd099084d023b232a2d50a074f6aa1223e19cceeab1d3445ba2fe91adf0dedd` | 均存在 | `automated_verified` | `pending_external` |
| Slack | `f9a5a552ec588799063819250913d352df540fa538f22585c8de8dd115f33b99` | 均存在 | `automated_verified` | `pending_external` |
| Mattermost | `181d5df3475613a7a3a8e110d21cd918f193ab69691b2f31fd3016ccdff3e71a` | 均存在 | `automated_verified` | `pending_external` |
| 飞书 | `69b55337a8c68afd3ab78a7e5e6bfc2486186e428fe752c281e71cf58f64903c` | 均存在 | `automated_verified` | `pending_external` |
| 钉钉 | `a93810f3aff11f33925ca5a8e571de2ee4413f08ae5ba96146d60a4e03e214c2` | 均存在 | `automated_verified` | `pending_external` |
| QQ | `b929dcf86392cdd15bb8401ce5bd772bbd4585ca2c57702b75c628b55afae7ce` | 均存在 | `automated_verified` | `pending_external` |
| MQTT | `8503779c9b9bb3b90c3f2b49549b370775a4bba72975efc00bfff60d75b73465` | 均存在 | `automated_verified` | `pending_external` |
| Matrix | `356cde1e51630c43c197c2c26356ebfbbcda30ea7e96b9b310dff8022f82b9e5` | 均存在 | `automated_verified` | `pending_external` |
| 企业微信 | `a34fcd818a6c9f1c607837ad4fa85f6a8f10372864341fdfb720a6e76aa2f14c` | unit 存在；contract 缺失 | `automated_verified` | `pending_external` |
| 小艺 | `056120d5f5cabd7af04032e620ed559e1ac52574c027b924e5792146ae74c2d7` | unit 存在；contract 缺失 | `automated_verified` | `pending_external` |
| 腾讯元宝 | `3f258fc31991f91ba71f60a5d4a6fec8a801468f9d25c4a92735a7928cd50537` | unit 存在；contract 缺失 | `automated_verified` | `pending_external` |
| 微信 iLink | `1b3a247a53540b0d3da1e39f89ab7ee29c62ab865a77c1d552a3b8a75e7bf26d` | unit 存在；contract 缺失 | `automated_verified` | `pending_external` |
| OneBot v11 | `1b7712c4526a662061a03e034edd54570202631bc78ec797f9a9d3b7bffe03b8` | unit 存在；contract 缺失 | `automated_verified` | `pending_external` |
| iMessage | `6ee63192f22f69ba164e27361b6d9b8f2d494c3791e0b2d877ed83d150462fb5` | 均存在 | `automated_verified` | `pending_external` |
| Voice / Twilio | `7ae18ed389a648ebcfb1e858c9a89b4241838df0474496fc4f89a21592267ab6` | 均存在 | `automated_verified` | `pending_external` |
| SIP | `12b2b81a99beb266f6cb0a0f7bf1f616c3e876cecf15fc7450b6243b0eb600a3` | unit、contract 均缺失 | `automated_verified` | `pending_external` |

以下 JSON 是审计脚本读取的规范证据；不得手工删减为空或用“同上”替代。

<!-- qwenpaw-channel-parity-ledger:start -->
```json
[
  {
    "channel": "telegram",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/telegram/__init__.py",
        "reference/src/qwenpaw/app/channels/telegram/cards/__init__.py",
        "reference/src/qwenpaw/app/channels/telegram/cards/context.py",
        "reference/src/qwenpaw/app/channels/telegram/cards/dispatcher.py",
        "reference/src/qwenpaw/app/channels/telegram/cards/tool_guard.py",
        "reference/src/qwenpaw/app/channels/telegram/channel.py",
        "reference/src/qwenpaw/app/channels/telegram/format_html.py"
      ],
      "source_sha256": "a4732b7603ccae46e4b9cf4b05a0e0e10d0c9d2db1fe50ebe792d5e4e2acb71d",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "bot_token",
        "base_url",
        "http_proxy",
        "http_proxy_auth",
        "show_typing",
        "streaming_enabled"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_telegram.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_telegram_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "3d489a96130d1376c20840cfc48d0cfc4ea1bfc2cb569e3269f36794124da986",
      "adapter_files": [
        "src/server/channels/adapters/telegram/config.ts",
        "src/server/channels/adapters/telegram/index.ts",
        "src/server/channels/adapters/telegram/normalize.ts",
        "src/server/channels/adapters/telegram/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/telegram.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/telegram.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary"
        }
      }
    },
    "intentional_differences": [
      "保留 DigitalMate 旧 webhook_secret 配置用于迁移兼容，同一 token 只能启用长轮询或 webhook 之一。",
      "工具、思考和搜索原始结果始终由统一运行时过滤，Adapter 不直接调用 Agent。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "discord",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/discord_/__init__.py",
        "reference/src/qwenpaw/app/channels/discord_/channel.py"
      ],
      "source_sha256": "7fd099084d023b232a2d50a074f6aa1223e19cceeab1d3445ba2fe91adf0dedd",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "bot_token",
        "http_proxy",
        "http_proxy_auth",
        "accept_bot_messages",
        "streaming_enabled",
        "media_dir"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_discord.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_discord_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "9d5dd464d82064ef60b77e5b944384f4df8e6485fcfe17009c65bd5024fc276f",
      "adapter_files": [
        "src/server/channels/adapters/discord/config.ts",
        "src/server/channels/adapters/discord/index.ts",
        "src/server/channels/adapters/discord/normalize.ts",
        "src/server/channels/adapters/discord/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/discord.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/discord.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "附件只进入 DigitalMate 私有存储和加密 locator，不把本地媒体路径返回给公开接口。",
      "平台事件和分段发送使用持久化事务账本，重连不会重新执行 Agent。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "slack",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/slack/__init__.py",
        "reference/src/qwenpaw/app/channels/slack/channel.py",
        "reference/src/qwenpaw/app/channels/slack/constants.py",
        "reference/src/qwenpaw/app/channels/slack/format.py",
        "reference/src/qwenpaw/app/channels/slack/handler.py",
        "reference/src/qwenpaw/app/channels/slack/sender.py",
        "reference/src/qwenpaw/app/channels/slack/utils.py"
      ],
      "source_sha256": "f9a5a552ec588799063819250913d352df540fa538f22585c8de8dd115f33b99",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "bot_token",
        "app_token",
        "proxy",
        "streaming_enabled",
        "media_dir"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_slack.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_slack_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "8cd642302cb6906387bd9a292924d478765cd2845f8051ebf85200e119e0716d",
      "adapter_files": [
        "src/server/channels/adapters/slack/config.ts",
        "src/server/channels/adapters/slack/index.ts",
        "src/server/channels/adapters/slack/normalize.ts",
        "src/server/channels/adapters/slack/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/slack.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/slack.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "额外保留 signing_secret 供旧 HTTP 回调迁移，M4-A 主连接使用 Socket Mode。",
      "Socket envelope 只在事件持久化后 ACK，平台重投由稳定 event ID 去重。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "mattermost",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/mattermost/__init__.py",
        "reference/src/qwenpaw/app/channels/mattermost/channel.py"
      ],
      "source_sha256": "181d5df3475613a7a3a8e110d21cd918f193ab69691b2f31fd3016ccdff3e71a",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "url",
        "bot_token",
        "media_dir",
        "show_typing",
        "thread_follow_without_mention"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_mattermost.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_mattermost_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "a5d5380a2c0989d5c490c7b26bfe509f7be7b7f4f9c80c7d84dcfd23700a679c",
      "adapter_files": [
        "src/server/channels/adapters/mattermost/config.ts",
        "src/server/channels/adapters/mattermost/index.ts",
        "src/server/channels/adapters/mattermost/normalize.ts",
        "src/server/channels/adapters/mattermost/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/mattermost.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/mattermost.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "WebSocket 收取和 REST 发送共用一条连接健康状态，限流只重试持久化 Delivery。",
      "附件先私有化再进入 Agent，原始下载 URL 不进入公开事件摘要。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "feishu",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/feishu/__init__.py",
        "reference/src/qwenpaw/app/channels/feishu/card_handler.py",
        "reference/src/qwenpaw/app/channels/feishu/card_templates.py",
        "reference/src/qwenpaw/app/channels/feishu/cards/__init__.py",
        "reference/src/qwenpaw/app/channels/feishu/cards/context.py",
        "reference/src/qwenpaw/app/channels/feishu/cards/dispatcher.py",
        "reference/src/qwenpaw/app/channels/feishu/cards/tool_guard.py",
        "reference/src/qwenpaw/app/channels/feishu/channel.py",
        "reference/src/qwenpaw/app/channels/feishu/constants.py",
        "reference/src/qwenpaw/app/channels/feishu/utils.py"
      ],
      "source_sha256": "69b55337a8c68afd3ab78a7e5e6bfc2486186e428fe752c281e71cf58f64903c",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "app_id",
        "app_secret",
        "encrypt_key",
        "verification_token",
        "media_dir",
        "domain",
        "streaming_enabled",
        "share_session_in_group"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_feishu.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_feishu_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "035335843a1d13ad748d955975bf127637624b20533d1af277ce8fcc23e60a4e",
      "adapter_files": [
        "src/server/channels/adapters/feishu/config.ts",
        "src/server/channels/adapters/feishu/index.ts",
        "src/server/channels/adapters/feishu/normalize.ts",
        "src/server/channels/adapters/feishu/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/feishu.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/feishu.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "encrypt_key": "retained_for_legacy_webhook_compatibility",
          "verification_token": "retained_for_legacy_webhook_compatibility",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "M4-A 主连接使用飞书长连接；encrypt_key 与 verification_token 仅为旧 webhook 迁移保留。",
      "卡片分段属于同一持久化回复事务，不额外写入可见消息。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "dingtalk",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/dingtalk/__init__.py",
        "reference/src/qwenpaw/app/channels/dingtalk/ai_card.py",
        "reference/src/qwenpaw/app/channels/dingtalk/channel.py",
        "reference/src/qwenpaw/app/channels/dingtalk/constants.py",
        "reference/src/qwenpaw/app/channels/dingtalk/content_utils.py",
        "reference/src/qwenpaw/app/channels/dingtalk/handler.py",
        "reference/src/qwenpaw/app/channels/dingtalk/markdown.py",
        "reference/src/qwenpaw/app/channels/dingtalk/utils.py"
      ],
      "source_sha256": "a93810f3aff11f33925ca5a8e571de2ee4413f08ae5ba96146d60a4e03e214c2",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "client_id",
        "client_secret",
        "message_type",
        "cron_message_type",
        "card_template_id",
        "card_template_key",
        "robot_code",
        "media_dir",
        "card_auto_layout",
        "at_sender_on_reply",
        "streaming_enabled",
        "endpoint"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_dingtalk.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_dingtalk_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "a83d12258845c6a37ed966e75fbd779a278e420ce14551e41693243e82673543",
      "adapter_files": [
        "src/server/channels/adapters/dingtalk/config.ts",
        "src/server/channels/adapters/dingtalk/index.ts",
        "src/server/channels/adapters/dingtalk/normalize.ts",
        "src/server/channels/adapters/dingtalk/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/dingtalk.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/dingtalk.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "DigitalMate 增加 admin_from 配置，仅用于识别可在私聊中批准 Alvin 全局资产的管理员。",
      "钉钉 SDK 只用于协议能力，DigitalMate 的安全封装禁止其打印 secret 或原始 frame。",
      "Markdown、卡片和定时卡片都消费既有 Delivery，不在 Adapter 内创建第二条 assistant 消息。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "qq",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/qq/__init__.py",
        "reference/src/qwenpaw/app/channels/qq/cards/__init__.py",
        "reference/src/qwenpaw/app/channels/qq/cards/context.py",
        "reference/src/qwenpaw/app/channels/qq/cards/dispatcher.py",
        "reference/src/qwenpaw/app/channels/qq/cards/tool_guard.py",
        "reference/src/qwenpaw/app/channels/qq/channel.py"
      ],
      "source_sha256": "b929dcf86392cdd15bb8401ce5bd772bbd4585ca2c57702b75c628b55afae7ce",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "app_id",
        "client_secret",
        "markdown_enabled",
        "max_reconnect_attempts",
        "ack_message"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_qq.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_qq_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "789d7dd9170ab8c2ba56d757b74dd02f9cc59d6499ae38c0453b95cc4690c75d",
      "adapter_files": [
        "src/server/channels/adapters/qq/config.ts",
        "src/server/channels/adapters/qq/index.ts",
        "src/server/channels/adapters/qq/normalize.ts",
        "src/server/channels/adapters/qq/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapter-boundary.test.ts",
        "tests/unit/channels/adapters/qq.test.ts",
        "tests/integration/channels/end-to-end.test.ts"
      ],
      "document": "docs/channels/qq.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "ack_message": "retained_but_visible_ack_suppressed"
        }
      }
    },
    "intentional_differences": [
      "保留 ack_message 字段和配置迁移能力，但不发送额外可见确认消息，以满足单来源只产生一份完整回复的红线。",
      "msg_seq 来自持久化 Delivery 分段序号，重连、重试和进程重启均复用同一序号。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "mqtt",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/mqtt/__init__.py",
        "reference/src/qwenpaw/app/channels/mqtt/channel.py"
      ],
      "source_sha256": "8503779c9b9bb3b90c3f2b49549b370775a4bba72975efc00bfff60d75b73465",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "host",
        "port",
        "transport",
        "clean_session",
        "qos",
        "username",
        "password",
        "subscribe_topic",
        "publish_topic",
        "tls_enabled",
        "tls_ca_certs",
        "tls_certfile",
        "tls_keyfile"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_mqtt.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_mqtt_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "3b24ddaa80c8b5a4ccf0fb25e3da51def56f72ae61befa58eb568793d3dcc2ee",
      "secret_fields": [
        "password",
        "tls_keyfile"
      ],
      "adapter_files": [
        "src/server/channels/adapters/mqtt/config.ts",
        "src/server/channels/adapters/mqtt/index.ts",
        "src/server/channels/adapters/mqtt/normalize.ts",
        "src/server/channels/adapters/mqtt/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/mqtt.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/mqtt.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "tls_ca_certs": "inline_pem_in_encrypted_config_not_filesystem_path",
          "tls_certfile": "inline_pem_in_encrypted_config_not_filesystem_path",
          "tls_keyfile": "inline_pem_secret_not_filesystem_path"
        }
      }
    },
    "intentional_differences": [
      "TLS CA、客户端证书和私钥沿用上游字段名，但值改为加密配置中的 PEM 内容，运行时不读取任意宿主文件。",
      "QoS 1/2 只有在统一事件账本完成持久化后才允许协议 ACK；QoS 0 明确要求业务 event_id 才能获得跨时间窗幂等。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "matrix",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/matrix/__init__.py",
        "reference/src/qwenpaw/app/channels/matrix/channel.py"
      ],
      "source_sha256": "356cde1e51630c43c197c2c26356ebfbbcda30ea7e96b9b310dff8022f82b9e5",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "homeserver",
        "user_id",
        "access_token",
        "group_allow_from",
        "groups",
        "encryption",
        "vision_enabled",
        "history_limit",
        "password",
        "device_name",
        "sync_timeout_ms",
        "mention_pill_in_body",
        "outbound_structured_mentions",
        "streaming_enabled"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_matrix.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_matrix_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "55a0376f74ebc85641fce769fce60a2e00bb801a30b3fb1e1e950ece31fb74ee",
      "secret_fields": [
        "access_token",
        "password"
      ],
      "adapter_files": [
        "src/server/channels/adapters/matrix/config.ts",
        "src/server/channels/adapters/matrix/crypto-store.ts",
        "src/server/channels/adapters/matrix/index.ts",
        "src/server/channels/adapters/matrix/normalize.ts",
        "src/server/channels/adapters/matrix/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/matrix.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/matrix.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary"
        }
      }
    },
    "intentional_differences": [
      "修正固定上游 Console 依赖不存在 auth_method 字段的问题，Access Token 与密码配置始终可见并按确定优先级解析。",
      "端到端加密设备库使用按用户、分身和连接派生的密钥落入私有文件，普通数据导出不包含同步令牌或 Olm/Megolm 状态。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "wecom",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/wecom/__init__.py",
        "reference/src/qwenpaw/app/channels/wecom/cards/__init__.py",
        "reference/src/qwenpaw/app/channels/wecom/cards/context.py",
        "reference/src/qwenpaw/app/channels/wecom/cards/dispatcher.py",
        "reference/src/qwenpaw/app/channels/wecom/cards/tool_guard.py",
        "reference/src/qwenpaw/app/channels/wecom/channel.py",
        "reference/src/qwenpaw/app/channels/wecom/utils.py"
      ],
      "source_sha256": "a34fcd818a6c9f1c607837ad4fa85f6a8f10372864341fdfb720a6e76aa2f14c",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "bot_id",
        "secret",
        "media_dir",
        "welcome_text",
        "share_session_in_group",
        "max_reconnect_attempts",
        "streaming_enabled"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_wecom.py"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "39a69a691fefc5c435ea98116a76f7e3dbb744cbad126caea4eb59be500cb62c",
      "secret_fields": [
        "secret"
      ],
      "adapter_files": [
        "src/server/channels/adapters/wecom/config.ts",
        "src/server/channels/adapters/wecom/index.ts",
        "src/server/channels/adapters/wecom/media.ts",
        "src/server/channels/adapters/wecom/normalize.ts",
        "src/server/channels/adapters/wecom/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/wecom.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/wecom.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "固定上游缺少企业微信 contract 测试，DigitalMate 由 wecom Adapter 合同覆盖认证、欢迎语、流式、附件和停止语义。",
      "回调 req_id、媒体 URL 和 AES key 分别进入加密 reply handle 与短期 locator，不写入公开事件或日志。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "xiaoyi",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/xiaoyi/__init__.py",
        "reference/src/qwenpaw/app/channels/xiaoyi/auth.py",
        "reference/src/qwenpaw/app/channels/xiaoyi/channel.py",
        "reference/src/qwenpaw/app/channels/xiaoyi/constants.py",
        "reference/src/qwenpaw/app/channels/xiaoyi/utils.py"
      ],
      "source_sha256": "056120d5f5cabd7af04032e620ed559e1ac52574c027b924e5792146ae74c2d7",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "ak",
        "sk",
        "agent_id",
        "task_timeout_ms"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_xiaoyi.py"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "09040b3216cf133e6f42fd478ad9b0b0196b736a6eaef2623d2dd2f0614edc80",
      "secret_fields": [
        "sk"
      ],
      "adapter_files": [
        "src/server/channels/adapters/xiaoyi/auth.ts",
        "src/server/channels/adapters/xiaoyi/config.ts",
        "src/server/channels/adapters/xiaoyi/index.ts",
        "src/server/channels/adapters/xiaoyi/protocol.ts",
        "src/server/channels/adapters/xiaoyi/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/xiaoyi.test.ts",
        "tests/integration/channels/event-claim.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/xiaoyi.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary"
        }
      }
    },
    "intentional_differences": [
      "固定上游缺少小艺 contract 测试，DigitalMate 合同补齐双链路去重、签名、任务帧、取消、附件和回复状态机。",
      "备用 IP 端点仍执行 TLS 证书校验并固定 SNI，不沿用参考实现关闭校验的做法。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "yuanbao",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/yuanbao/__init__.py",
        "reference/src/qwenpaw/app/channels/yuanbao/auth.py",
        "reference/src/qwenpaw/app/channels/yuanbao/channel.py",
        "reference/src/qwenpaw/app/channels/yuanbao/codec.py",
        "reference/src/qwenpaw/app/channels/yuanbao/constants.py",
        "reference/src/qwenpaw/app/channels/yuanbao/media.py",
        "reference/src/qwenpaw/app/channels/yuanbao/proto/biz.json",
        "reference/src/qwenpaw/app/channels/yuanbao/proto/conn.json",
        "reference/src/qwenpaw/app/channels/yuanbao/utils.py"
      ],
      "source_sha256": "3f258fc31991f91ba71f60a5d4a6fec8a801468f9d25c4a92735a7928cd50537",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "app_id",
        "app_secret",
        "api_domain",
        "media_dir",
        "accept_bot_messages"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_yuanbao.py"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "154d95c9f89e95814b896450a58b77247bb52fa33d57c60dc7c407573f2bc375",
      "secret_fields": [
        "app_secret"
      ],
      "adapter_files": [
        "src/server/channels/adapters/yuanbao/UPSTREAM.md",
        "src/server/channels/adapters/yuanbao/auth.ts",
        "src/server/channels/adapters/yuanbao/codec.ts",
        "src/server/channels/adapters/yuanbao/config.ts",
        "src/server/channels/adapters/yuanbao/index.ts",
        "src/server/channels/adapters/yuanbao/media.ts",
        "src/server/channels/adapters/yuanbao/normalize.ts",
        "src/server/channels/adapters/yuanbao/proto/biz.json",
        "src/server/channels/adapters/yuanbao/proto/conn.json",
        "src/server/channels/adapters/yuanbao/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/yuanbao.test.ts",
        "tests/integration/channels/event-claim.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/yuanbao.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "固定上游缺少腾讯元宝 contract 测试，DigitalMate 使用原始描述符哈希、binary golden 和 TypeScript 协议合同防止 wire format 漂移。",
      "临时 COS 凭据只存在于单次上传内存，资源 locator 加密保存并在私有附件绑定后清除。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "wechat",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/wechat/__init__.py",
        "reference/src/qwenpaw/app/channels/wechat/channel.py",
        "reference/src/qwenpaw/app/channels/wechat/client.py",
        "reference/src/qwenpaw/app/channels/wechat/utils.py"
      ],
      "source_sha256": "1b3a247a53540b0d3da1e39f89ab7ee29c62ab865a77c1d552a3b8a75e7bf26d",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "bot_token",
        "bot_token_file",
        "base_url",
        "media_dir",
        "message_merge_enabled",
        "message_merge_delay_ms"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_wechat.py"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "0e0db1a34fac4187ca9350fe3f70ae66b16e9a7a8129f560ec0dc15dc05569df",
      "secret_fields": [
        "bot_token",
        "bot_token_file"
      ],
      "adapter_files": [
        "src/server/channels/adapters/wechat/UPSTREAM.md",
        "src/server/channels/adapters/wechat/auth.ts",
        "src/server/channels/adapters/wechat/client.ts",
        "src/server/channels/adapters/wechat/config.ts",
        "src/server/channels/adapters/wechat/crypto.ts",
        "src/server/channels/adapters/wechat/index.ts",
        "src/server/channels/adapters/wechat/media.ts",
        "src/server/channels/adapters/wechat/normalize.ts",
        "src/server/channels/adapters/wechat/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/wechat.test.ts",
        "tests/unit/admin-compat-channels.test.ts",
        "tests/integration/channels/event-claim.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/wechat.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "bot_token_file": "plaintext_token_file_rejected_use_encrypted_qr_secret",
          "media_dir": "compatibility_field_private_storage_is_authoritative",
          "message_merge_enabled": "retained_single_delivery_message_is_authoritative",
          "message_merge_delay_ms": "retained_single_delivery_message_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "固定上游缺少微信 contract 测试，DigitalMate 合同补齐二维码全状态、游标、上下文令牌、AES 媒体、typing 和启停竞态。",
      "Bot Token 与 context token 只进入加密配置或 reply handle；ret=-2 持久失效句柄，主动任务和重启恢复都不会再次选择。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "onebot",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/onebot/__init__.py",
        "reference/src/qwenpaw/app/channels/onebot/channel.py"
      ],
      "source_sha256": "1b7712c4526a662061a03e034edd54570202631bc78ec797f9a9d3b7bffe03b8",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "ws_host",
        "ws_port",
        "access_token",
        "share_session_in_group"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_onebot_channel.py"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "a2aeee6f8c0cece5e2c8bd5f417a988d6e5568535b2687cd58e358d58e7660fb",
      "secret_fields": [
        "access_token"
      ],
      "adapter_files": [
        "src/server/channels/adapters/onebot/config.ts",
        "src/server/channels/adapters/onebot/index.ts",
        "src/server/channels/adapters/onebot/normalize.ts",
        "src/server/channels/adapters/onebot/protocol.ts",
        "src/server/channels/adapters/onebot/transport.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/onebot.test.ts",
        "tests/unit/channels/gateway/router.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/onebot.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "ws_host": "compatibility_field_gateway_listener_is_authoritative",
          "ws_port": "compatibility_field_gateway_listener_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "固定上游缺少 OneBot contract 测试，DigitalMate 合同补齐 NapCat、go-cqhttp、Lagrange fixture、Bearer 鉴权、echo、事件上限与 watchdog。",
      "TypeScript Adapter 只处理协议边界，反向 WebSocket 由受限公网 gateway 托管；平台风控状态不会伪装为 connected。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "imessage",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/imessage/__init__.py",
        "reference/src/qwenpaw/app/channels/imessage/channel.py"
      ],
      "source_sha256": "6ee63192f22f69ba164e27361b6d9b8f2d494c3791e0b2d877ed83d150462fb5",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "db_path",
        "poll_sec",
        "media_dir",
        "max_decoded_size"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_imessage.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_imessage_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "946de8cb97dbcd15b876e304048c695c8bcff2b39778e89336af3803005e989d",
      "adapter_files": [
        "runners/channel-node/src/imessage/config.ts",
        "runners/channel-node/src/imessage/database.ts",
        "runners/channel-node/src/imessage/normalize.ts",
        "runners/channel-node/src/imessage/rejections.ts",
        "runners/channel-node/src/imessage/transport.ts"
      ],
      "tests": [
        "tests/unit/channel-node/imessage.test.ts",
        "tests/unit/channel-node/client.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/imessage.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "media_dir": "compatibility_field_private_node_storage_is_authoritative"
        }
      }
    },
    "intentional_differences": [
      "Python 本机实现迁为无 Agent 权限的 TypeScript macOS runner，只读查询 chat.db，并通过 mTLS 节点协议交换规范化文本与附件 locator。",
      "完全磁盘访问、imsg、启动游标和 10 MiB 解码边界由本地 health 与合同校验；群聊能力明确保持 blocked。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "voice",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/voice/__init__.py",
        "reference/src/qwenpaw/app/channels/voice/channel.py",
        "reference/src/qwenpaw/app/channels/voice/conversation_relay.py",
        "reference/src/qwenpaw/app/channels/voice/session.py",
        "reference/src/qwenpaw/app/channels/voice/twilio_manager.py",
        "reference/src/qwenpaw/app/channels/voice/twiml.py"
      ],
      "source_sha256": "7ae18ed389a648ebcfb1e858c9a89b4241838df0474496fc4f89a21592267ab6",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "twilio_account_sid",
        "twilio_auth_token",
        "phone_number",
        "phone_number_sid",
        "tts_provider",
        "tts_voice",
        "stt_provider",
        "language",
        "welcome_greeting"
      ],
      "unit_tests": [
        "reference/tests/unit/channels/test_voice.py"
      ],
      "contract_tests": [
        "reference/tests/contract/channels/test_voice_contract.py"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "47658deb08092115f61dc03131f85b22d262e057cb800e3996e421c0ff042a29",
      "secret_fields": [
        "twilio_auth_token"
      ],
      "adapter_files": [
        "src/server/channels/adapters/voice/config.ts",
        "src/server/channels/adapters/voice/index.ts",
        "src/server/channels/adapters/voice/relay.ts",
        "src/server/channels/adapters/voice/signature.ts",
        "src/server/channels/adapters/voice/transport.ts",
        "src/server/channels/adapters/voice/twiml.ts"
      ],
      "tests": [
        "tests/unit/channels/adapters/voice.test.ts",
        "tests/unit/channels/gateway/router.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/voice.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "welcome_greeting": "digitalmate_brand_default"
        }
      }
    },
    "intentional_differences": [
      "ConversationRelay、TwiML 与签名校验迁为 TypeScript gateway；电话音频只在 Twilio 侧完成 STT/TTS，中心 Agent 仅接收转写文本。",
      "新增最大并发通话配置与持久化 callSid 幂等边界；这不改变固定上游字段的 Console 兼容语义。"
    ],
    "status": "automated_verified"
  },
  {
    "channel": "sip",
    "upstream": {
      "source_files": [
        "reference/src/qwenpaw/app/channels/sip/__init__.py",
        "reference/src/qwenpaw/app/channels/sip/_audioop_compat.py",
        "reference/src/qwenpaw/app/channels/sip/backend.py",
        "reference/src/qwenpaw/app/channels/sip/livekit_backend.py",
        "reference/src/qwenpaw/app/channels/sip/mini_registrar.py",
        "reference/src/qwenpaw/app/channels/sip/pyvoip_backend.py",
        "reference/src/qwenpaw/app/channels/sip/session.py",
        "reference/src/qwenpaw/app/channels/sip/sip_client.py",
        "reference/src/qwenpaw/app/channels/sip/stt_engine.py",
        "reference/src/qwenpaw/app/channels/sip/stt_tts.py"
      ],
      "source_sha256": "12b2b81a99beb266f6cb0a0f7bf1f616c3e876cecf15fc7450b6243b0eb600a3",
      "config_files": [
        "reference/src/qwenpaw/config/config.py",
        "reference/src/qwenpaw/app/routers/config.py"
      ],
      "config_fields": [
        "enabled",
        "bot_prefix",
        "filter_tool_messages",
        "filter_thinking",
        "dm_policy",
        "group_policy",
        "allow_from",
        "deny_message",
        "require_mention",
        "no_text_debounce",
        "access_control_dm",
        "access_control_group",
        "dm_disabled",
        "group_disabled",
        "sip_mode",
        "sip_host",
        "sip_port",
        "sip_username",
        "sip_password",
        "sip_server",
        "sip_transport",
        "rtp_port_low",
        "rtp_port_high",
        "dashscope_api_key",
        "tts_provider",
        "tts_voice",
        "stt_provider",
        "language",
        "welcome_greeting",
        "call_timeout",
        "livekit_url",
        "livekit_api_key",
        "livekit_api_secret",
        "livekit_sip_trunk_id",
        "livekit_room_name",
        "livekit_output_sample_rate",
        "max_concurrent_calls"
      ],
      "unit_tests": [
        "missing_upstream"
      ],
      "contract_tests": [
        "missing_upstream"
      ]
    },
    "digitalmate": {
      "manifest": "src/server/channels/manifests/catalog.ts",
      "evidence_sha256": "6741fc3cc2713fe64ef3b4cbb9379c9d185043656b9dc990a0d19ab052fa7370",
      "adapter_files": [
        "runners/channel-node/src/sip/backend.ts",
        "runners/channel-node/src/sip/config.ts",
        "runners/channel-node/src/sip/livekit.ts",
        "runners/channel-node/src/sip/registrar.ts",
        "runners/channel-node/src/sip/rtp.ts",
        "runners/channel-node/src/sip/session.ts",
        "runners/channel-node/src/sip/stt.ts",
        "runners/channel-node/src/sip/transport.ts",
        "runners/channel-node/src/sip/tts.ts"
      ],
      "tests": [
        "tests/unit/channel-node/sip.test.ts",
        "tests/unit/channel-node/client.test.ts",
        "tests/unit/channels/runtime-start.test.ts"
      ],
      "document": "docs/channels/sip.md",
      "config_decisions": {
        "default": "supported",
        "exceptions": {
          "filter_tool_messages": "forced_true_safety_boundary",
          "filter_thinking": "forced_true_safety_boundary",
          "sip_password": "node_only_credential",
          "dashscope_api_key": "node_only_credential",
          "livekit_api_key": "node_only_credential",
          "livekit_api_secret": "node_only_credential",
          "welcome_greeting": "digitalmate_brand_default"
        }
      }
    },
    "intentional_differences": [
      "固定上游同时缺少 SIP unit 与 contract 测试，DigitalMate 合同补齐 registrar、RTP、STT/TTS、超时、并发、pyVoIP 与 LiveKit 双后端。",
      "SIP、RTP、DashScope 与 LiveKit 凭据只存在于无 Agent 权限的 TypeScript 媒体节点；中心只接收转写文本并通过 mTLS 发送回复文本。"
    ],
    "status": "automated_verified"
  }
]
```
<!-- qwenpaw-channel-parity-ledger:end -->

## 审计规则

运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require-all
```

脚本先执行 M1 快照校验，再验证固定身份、十七个渠道集合、固定上游目录、
manifest 与运行时注册快照、逐文件哈希、继承后的配置字段、上游
unit/contract 证据、本地 Adapter 或受限 runner、测试与文档的内容摘要、
生产 Adapter switch、密钥字段和差异说明。未知渠道、重复渠道、空证据、
错误哈希、漏字段、无证据 smoke 或缺文件都会退出 1。若固定上游确实没有
某类测试，该数组必须明确写 `missing_upstream`，并继续保留 DigitalMate
的本地补齐测试。
