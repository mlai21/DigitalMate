# QwenPaw 标准渠道对齐账本

基线固定为 QwenPaw `v2.0.0.post3`，commit
`fef7e64d984f4332d0b84a343cd209bd3ea5d316`。本账本只描述 M4-A
的 Telegram、Discord、Slack、Mattermost、飞书、钉钉和 QQ；它不是
真实平台可用性声明，外部联调状态见
[`channels-standard-m4a.md`](./channels-standard-m4a.md)。

`source_sha256` 的计算方式是：先由 M1 校验整个只读快照和
`SHA256SUMS`，再取该渠道目录下全部文件的已验证清单行，按 POSIX
路径排序、保留 `SHA256SUMS` 行格式后计算 SHA-256。配置字段由固定
`config.py` 中 `BaseChannelConfig` 与渠道子类合并得到；第二份固定配置
路由文件也纳入证据边界。`config_decisions.default` 适用于全部上游字段，
`exceptions` 只记录有意收紧或兼容处理的字段。

| 渠道 | 上游源集合 SHA-256 | 上游 unit / contract | DigitalMate 状态 | 外部状态 |
| --- | --- | --- | --- | --- |
| Telegram | `a4732b7603ccae46e4b9cf4b05a0e0e10d0c9d2db1fe50ebe792d5e4e2acb71d` | 均存在 | `automated_verified` | `pending_external` |
| Discord | `7fd099084d023b232a2d50a074f6aa1223e19cceeab1d3445ba2fe91adf0dedd` | 均存在 | `automated_verified` | `pending_external` |
| Slack | `f9a5a552ec588799063819250913d352df540fa538f22585c8de8dd115f33b99` | 均存在 | `automated_verified` | `pending_external` |
| Mattermost | `181d5df3475613a7a3a8e110d21cd918f193ab69691b2f31fd3016ccdff3e71a` | 均存在 | `automated_verified` | `pending_external` |
| 飞书 | `69b55337a8c68afd3ab78a7e5e6bfc2486186e428fe752c281e71cf58f64903c` | 均存在 | `automated_verified` | `pending_external` |
| 钉钉 | `a93810f3aff11f33925ca5a8e571de2ee4413f08ae5ba96146d60a4e03e214c2` | 均存在 | `automated_verified` | `pending_external` |
| QQ | `b929dcf86392cdd15bb8401ce5bd772bbd4585ca2c57702b75c628b55afae7ce` | 均存在 | `automated_verified` | `pending_external` |

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
  }
]
```
<!-- qwenpaw-channel-parity-ledger:end -->

## 审计规则

运行：

```bash
node scripts/qwenpaw-console/audit-channel-parity.mjs --require telegram,discord,slack,mattermost,feishu,dingtalk,qq
```

脚本先执行 M1 快照校验，再验证固定身份、七个渠道集合、逐文件哈希、
继承后的配置字段、上游 unit/contract 证据、本地 manifest/Adapter/测试/
文档和差异说明。未知渠道、重复渠道、空证据、错误哈希、漏字段或缺文件
都会退出 1。若未来固定上游确实没有某类测试，该数组必须明确写
`missing_upstream`，并继续保留 DigitalMate 的本地补齐测试。
