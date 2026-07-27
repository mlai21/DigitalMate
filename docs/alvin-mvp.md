# Alvin MVP 上线与验收手册

## 1. 首期范围

Alvin 是独立的 MaaS 售前解决方案架构师，不是 DigitalMate 的分身、模式或别名。

首期只交付：

- 幂等创建一个固定 Alvin，并保留 DigitalMate 为默认智能体。
- Alvin 独立人设、独立资源授权和六项首版售前 Skill。
- 一个固定绑定 Alvin 的钉钉机器人。
- 管理员私聊、受邀销售私聊，以及管理员与销售所在的一个群聊。
- 私聊参与者记忆隔离；群聊与所有私聊记忆隔离。

首期不交付任意智能体创建、克隆、导入、删除、启用停用、置顶、排序、多智能体协作、客户空间、自动报价、多智能体备份恢复和自动修改岗位章程。

## 2. 创建 Alvin

Alvin 实例由幂等运维脚本创建：在生产 web 容器内调用 `createAgentRepository().createAlvin(userId)`，重复执行只会得到同一个 `slug=alvin` 的智能体，且不会重复写入售前 Skill。后台不提供“新建智能体”入口（`POST /api/admin/compat/agents` 仍保留同样的幂等语义，供脚本或调试使用）。

创建时会同时写入：

- Alvin 独立人设。
- `inherits_user_resources=false`。
- 当前账号已配置模型路由的显式授权。
- 六项仅属于 Alvin 的已启用售前 Skill。

`GET /api/admin/compat/agents` 应同时返回默认 DigitalMate 和非默认 Alvin，并在顶层返回 `capabilities`。在后台侧栏切换到 Alvin 后，所有页面数据与写入都落在 Alvin 作用域，请求自动带上 `x-digitalmate-agent-id: <Alvin ID>`；路径中带 Agent ID 的接口必须与侧栏选中项一致。

## 3. 配置钉钉连接

在 Alvin 作用域下创建一个独立钉钉连接，不复用 DigitalMate 的连接。

建议首测配置：

- `enabled=true`
- `dm_policy=allowlist`
- `group_policy=allowlist`
- `allow_from` 只填写管理员 staff ID、销售 staff ID 和目标群标识。
- `admin_from` 只填写管理员 staff ID。
- `require_mention=true`

`admin_from` 不是普通白名单。它只在管理员私聊中授予“提交全局 Skill”的权限；管理员在群聊中也没有该权限。

## 4. 上下文与权限合同

| 场景 | 会话历史 | 长期记忆 | 可用全局资产 | 可修改全局资产 |
|---|---|---|---|---|
| 管理员私聊 | 仅管理员私聊 | 仅管理员私聊 | Alvin 已批准资产 | 可以，仍需对话确认 |
| 销售私聊 | 仅该销售私聊 | 仅该销售私聊 | Alvin 已批准资产 | 不可以 |
| 目标群聊 | 仅该群历史 | 不加载长期记忆 | Alvin 已批准资产 | 不可以 |

私聊分区键为“钉钉连接 + 发送者”，群聊分区键为“钉钉连接 + 群”。管理员私聊的原始内容不会因为管理员身份自动成为群聊知识；只有明确创建并批准的 Alvin Skill 才能进入公共能力层。

## 5. 两人验收脚本

按顺序执行：

1. 管理员私聊 Alvin：“我的内部暗号是 A-ONLY，不要对外说。”
2. 销售私聊询问管理员的内部暗号，Alvin 不得召回。
3. 群里询问管理员的内部暗号，Alvin 不得召回。
4. 销售私聊提供自己的偏好，再次私聊时应能命中；管理员私聊不得命中该偏好。
5. 群里先给出一个背景事实，后续在同一群追问时可以利用该群历史。
6. 销售尝试 `/create-skill`，必须被拒绝。
7. 管理员在私聊中创建并确认一个测试 Skill；销售私聊和群聊可使用，DigitalMate 不得加载。
8. 用完全相同的 Skill 名称、记忆关键词和消息文本分别测试 DigitalMate 与 Alvin，任一跨智能体召回都判定失败。

## 6. 发布门槛

MVP 上线只看四项硬指标：

- DigitalMate 与 Alvin 跨智能体召回为 0。
- 管理员、销售、群聊三类上下文串线为 0。
- 销售或群聊修改 Alvin 全局资产为 0。
- 虚构价格、SLA、资质、产品能力或路线图为 0。

其余蒸馏评分、知识版本管理、完整回滚和自动化盲测在 MVP 稳定运行后补齐。发生任一硬指标事故时，先禁用 Alvin 钉钉连接；DigitalMate 保持运行。
