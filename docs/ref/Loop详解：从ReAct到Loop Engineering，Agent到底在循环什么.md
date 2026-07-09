过去1-2个星期，Loop Engineering 的讨论明显升温。

看起来是一个新词在扩散，实际指向的是同一个老问题：Agent 做完一步之后，系统到底怎样决定下一步。

有人从 coding agent 的日常使用讲，有人从 Harness 和 worktree 讲，也有人从执行图、自我改进和长期记忆讲。入口不一样，问题是一致的：

反馈能不能稳定地进入下一轮动作。

如果只看标题，Loop 很容易被理解成又一个新词：Prompt Engineering 之后是 Context Engineering，再之后是 Harness Engineering，现在轮到 Loop Engineering。

但放到我们今年一直梳理的 Agent 工程链路里，它并不突兀。

我们之前从 Prompt 写到 Context，从 Context 写到 Harness，又从 Harness 写到 Goal、Self-Harness、Environment。Loop 正好卡在中间：

Prompt 决定任务怎么开始
Context 决定 Agent 看见什么
Harness 决定 Agent 怎么运行
Environment 决定 Agent 面对什么反馈
Loop 决定这些反馈怎样进入下一步
沿着这条工程链路看，AI 工作台先把计划、上下文、验证放到固定位置；Harness 再把工具、权限、状态、测试组成可检查的工作现场；Self-Harness 继续要求失败轨迹、回归测试和 Harness 版本；Environment 则往外追问一步：反馈来自哪个世界，可信不可信。

Loop 接在这些中间。

图片
图 1：Loop 在 Agent 工程链路中的位置
这条线看下来，我对 Loop 的理解会更保守一点：

Loop 更像一个可接手的小系统：把 目标、动作、反馈、验证、状态和 停止条件 组织在一起。

这里先不把它当新闻看。

我更关心它进入工程现场之后，哪些东西需要从“上下文里的隐含判断”，变成系统可以检查、可以接手的对象。

也就是一个基本问题：

Agent 到底在循环什么？

先说结论
• 最小的 Agent Loop，可以理解成：思考、行动、观察、验证、再决定下一步。
• ReAct 是最常见的基础循环，但 2026 年讨论的 Loop Engineering，已经不只是 ReAct。
• Loop 从小到大，可以分成五类：ReAct 循环、计划执行循环、反思验证循环、长任务目标循环、Harness 进化循环。
• 一个 Loop 能不能进生产，不看它能跑多久，而看它有没有 验证、停止、状态、恢复、隔离、观测 六个硬边界。
• 很多 Loop 失败，问题常常不在模型强弱，而在依赖关系、执行历史、恢复策略和成本边界都藏在上下文里，系统无法检查。
• 对架构师来说，Loop Engineering 的价值不在“让 Agent 一直干活”，而在把反馈变成可记录、可复盘、可接手的系统对象。
• 如果任务没有明确反馈面，先别急着做 Loop。能不能自动验证，往往比能不能自动执行更重要。
• 看开源项目时，功能清单只是入口，更关键的是它们怎样处理工具、权限、沙箱、状态、追踪、子 Agent 和编排边界。
一句话：

Loop 不是让 Agent 原地转圈，而是让 Agent 在反馈里前进，并且知道什么时候该停。

最小 Loop：Think、Act、Observe
先别急着上新词。

最小的 Agent Loop，其实很朴素：

Think：根据目标和上下文判断下一步
Act：调用工具或执行动作
Observe：读取动作返回的结果
Verify：判断结果是否接近目标
Repeat：继续、停止或升级给人
图片
图 2：一轮 Agent Loop 的运行流程
早期大家熟悉的 ReAct，就是这个思路。

Reasoning + Acting。

模型不是一次性给答案，而是一边推理，一边行动。行动之后拿到新观察，再继续推理。

比如让 Agent 修一个测试失败：

1. 它先读失败日志；
2. 推测可能原因；
3. 打开相关文件；
4. 修改代码；
5. 运行测试；
6. 根据测试结果决定继续还是停止。
这已经是 Loop。

所以严格说，Agent 从来不缺循环。

今天大家重新讨论 Loop Engineering，是因为任务变长了。

过去，一轮对话就能解决的问题，模型强一点、prompt 好一点就够了。

现在任务变成几十分钟、几个小时，甚至跨天运行。Agent 要读仓库、跑命令、开 PR、看 CI、处理 review、记录状态、下一轮接着做。

这个时候，Loop 就不再是一个简单的“模型调用模式”。

它变成了系统设计问题。

为什么现在突然热
这轮热度不是凭空来的。

coding agent 用得越久，越容易遇到一个小尴尬：人每天做的，不只是给模型写下一条 prompt，而是在不断判断下一步该怎么走。

Steipete 那句传播很广：与其一轮轮提示 coding agent，不如设计能够提示 agent 的 loop。

Boris Cherny 的说法也很直接：他不再主要 prompt Claude，而是写 loop，让 loop 去提示 Claude 并决定下一步。

Addy Osmani 则把这件事拆到更工程化的部件里：automation、worktree、skills、plugins/connectors、sub-agents，再加上 memory/state。

这些说法合在一起，背后是一个变化：

人不再每一步都亲自敲下一条 prompt，而是把“下一步怎么产生”写进系统。

过去是：

人 -> prompt -> Agent -> 输出 -> 人再 prompt
现在更像：

触发器 -> Goal -> Agent -> 工具 -> 反馈 -> 验证器 -> 状态 -> 下一轮
Prompt 没有消失。

它只是从聊天框里的一句话，变成了运行协议的一部分。

这和前面聊 /goal、plan.md、Dynamic Workflows 时是同一个方向：复杂任务不能只靠聊天上下文记住目标。目标、步骤、验收和停止条件，需要有一个比当前对话更稳的落点。

这里有一个边界需要先说清楚。

Loop 也不适合替换所有 workflow。

放到工程现场，可以先分三层：

图片
很多团队一开始会把 Loop 想得太大。

一个任务适不适合 Loop，不看它听起来多智能，而看它有没有这三个条件：

• 重复出现；
• 每轮结果可检查；
• 失败后能恢复或交还给人。
缺任何一个，先用更简单的办法。

单步可解决的事，用 prompt 就好。固定步骤可解决的事，用普通 workflow 更便宜。Loop 只在“下一步要根据上一轮反馈决定”时才有必要。

比如一个持续运行的 CI 修复 Loop，不能只写：

帮我修 CI。
更像要写成：

触发：main 分支 CI 失败超过 10 分钟
输入：失败 job、最近 commit、相关测试文件
范围：只允许改测试和对应模块
验证：目标测试通过，全量 lint 通过
停止：最多 3 轮，连续无进展停止
升级：涉及权限、数据迁移、测试绕过，交还给人
状态：每轮写入 issue 或状态文件
这才是 Loop Engineering 进入工程现场后的样子。

五类 Loop：从 ReAct 到 Self-Harness
Loop 的叫法很多。

DataScienceDojo 把 ReAct、Reflexion、Plan-and-Execute、Ralph Loop、/goal 等放进了一张演进图。LangChain 则从 Agent loop、Evaluation loop、Event-driven loop、Optimization loop 往外扩。

对工程落地来说，记住所有名字不如先看任务形态。更好用的切法，是按任务形态把它压成五类。

1. ReAct Loop：边做边看
这是基础款。

模型每一步都根据观察结果决定下一步。

优点是灵活，适合未知路径。

缺点也明显：上下文越来越长，步骤依赖不清楚，失败恢复容易变成原地重试。

很多 coding agent 的基础形态，仍然是 ReAct。

2. Plan-and-Execute Loop：先排路线，再分步执行
这类 Loop 会先生成计划，再按计划执行。

它比 ReAct 更可控，因为步骤被提前拆出来了。

但它也有代价：如果早期计划错了，后面会沿着错误路线继续走。

所以它适合相对明确的任务，不适合变化很大的探索任务。

3. Reflection / Evaluation Loop：做完以后有人挑毛病
这类 Loop 会在执行后加一层评估。

评估者可以是测试、规则、截图比对、类型检查，也可以是另一个 reviewer agent。

普通团队更适合先落地的，往往是这一类。

很多 Agent 输出真正麻烦的地方，不在生成，而在生成以后没人可靠地验。

如果写代码的 Agent 自己评自己，很容易偏乐观。

把执行者和评估者拆开，质量会稳很多。

这也接上验证类 Skills 那条线里的判断：很多流程里最该沉淀的不是“怎么生成”，而是“怎么验、谁来验、验不过怎么停”。

4. Goal / Long-running Loop：目标持续存在
Codex 的 Goal 文档里有一个关键点：Goal 有完成条件、验证方式和约束，不是无边界后台自治。

这类 Loop 的重点不在某一步，而在“目标不要丢”。

长任务最怕两件事：

• 做着做着忘了最初目标；
• 遇到阻塞就把计划当结果交回来。
Goal 类 Loop 要解决的，就是让 Agent 能跨多轮、多次上下文压缩、多次工具调用，仍然围绕同一个完成条件推进。

5. Optimization / Self-Harness Loop：从失败里改系统
这是最外层，也最容易被讲玄的一层。

LangChain 讲轨迹分析和 Engine。Agentic Harness Engineering 和 Self-Harness 这类研究，则进一步把失败轨迹、Harness 组件、候选修改和回归验证连起来。

这里很容易被讲成“Agent 终于会自我进化”。

更稳妥的说法是：

系统开始允许 Agent 根据失败证据提出 Harness 修改，但修改能不能晋升，要靠独立评估和回归测试。

这一步很关键。

因为有复利的，是让同类任务以后少犯同一个错。

这也是 Self-Harness 那条线更值得细看的地方：失败轨迹不能只变成一段总结，它要有机会变成下一版 Harness 的候选修改；而候选修改能不能留下来，要看回归测试。

生产级 Loop 的六个硬点
一个 Loop 能 demo，不代表能进生产。

可以先看六个硬点。

为了方便阅读，先把关键词摆在前面：

验证 决定能不能证明完成，停止 决定会不会失控，状态 决定下一轮能不能接上，恢复、隔离、观测决定它能不能进团队流程。


图片
图 3：生产级 Loop 的六个硬边界
验证
Loop 不能只靠模型说“我完成了”。

它要有外部证据：

• 测试通过；
• lint 通过；
• 类型检查通过；
• 截图符合预期；
• 链接检查通过；
• 评审意见被处理；
• 产物写到约定目录。
验证越清楚，Loop 越容易停止。

验证越模糊，Loop 越容易变成“看起来很努力”。

Martin Fowler 在 Harness 文章里有个很好的说法：要同时设计 feedforward 和 feedback。前者是在 Agent 行动前给规则，后者是在 Agent 行动后给传感器。

放到 Loop 里，就是不要只写“按规范修复”，还要让 lint、结构测试、reviewer agent、截图比对、运行日志这些传感器真的参与下一轮。

这和 Harness 里的 Guides / Sensors 很像：规则只负责行动前的约束，传感器才负责把行动后的事实带回来。

停止
Loop 最危险的地方，往往是停不下来。

停止条件至少要有三类：

• 目标达成；
• 预算耗尽；
• 连续无进展。
Firecrawl 提到 hard iteration cap、diff/no-progress check、spend cap，思路很朴素，但很必要。

没有停止条件的 Loop，更像一张开放账单。

这里的预算不只是钱。

它至少包括：

• token 预算；
• 时间预算；
• 工具调用预算；
• 可接受 diff 大小；
• 人工 review 预算。
一个 Loop 如果只能用“继续尝试”来描述下一步，通常就已经该停了。

状态
状态不能只活在上下文里。

上下文会被截断，会被摘要，会被压缩，也会被模型误读。

一个能长期运行的 Loop，要把状态写到系统里：

• 当前目标；
• 已尝试路径；
• 已失败方案；
• 关键证据；
• 当前阻塞；
• 下一步计划；
• 人工决策。
这可以是 Markdown、issue、数据库、看板、trace 系统，不一定复杂。

关键是下一轮能读，人也能接手。

Mem0 从 memory-first 角度讲得更细：token-rich loop 会把大量历史都塞进上下文，容易贵、慢、溢出；token-poor loop 成本低，但需要更好的记忆和摘要层。

这对工程实践的提醒是：状态外置不是为了显得架构高级。它解决的是每轮只带必要信息，避免把历史原封不动塞回 prompt。

恢复
From Agent Loops to Structured Graphs 指出的一个问题很重要：普通 Agent Loop 的恢复经常是无边界的。

失败了就再试。

再失败就换个说法再试。

但系统不知道哪些路径已经失败，也不知道什么时候该升级。

生产级 Loop 要有恢复协议：

同一错误最多重试几次
同一命令是否允许原参数重跑
工具失败后是否进入替代路径
产物丢失后如何恢复
超过阈值时交还给谁
没有恢复协议，Loop 越长，调试越难。

Self-Harness 那条线里也有类似问题：有些 Agent 会反复用同一参数重试失败命令，或者工具失败后把必需产物弄丢。恢复协议就是把这类“原地转圈”提前挡住。

隔离
只要 Loop 会写文件、跑命令、改配置，隔离就不是可选项。

OpenAI 的 Harness 文章和 Addy 的 Loop 文章都反复提到 worktree。OpenHands 也把本地、Docker、VM、云端 agent backend 分开讲。原因很现实：多个 Agent 或多个循环同时跑时，最先失控的往往不是模型，而是工作区。

隔离至少回答四个问题：

• 它在哪个分支或 worktree 做事；
• 它能访问哪些目录和凭据；
• 它产生的副作用在哪里；
• 它失败后怎么清理。
没有隔离，Loop 越勤快，越容易把人类本来能看懂的变更现场搅乱。

观测
可观测性不是最后补一个日志。

生产级 Loop 要能回答：

• 本轮为什么启动；
• 调用了哪些工具；
• 工具参数是什么；
• 返回结果是什么；
• Agent 怎样解释这个结果；
• 哪个检查让它继续或停止；
• 当前使用的是哪一版规则、Skill、Harness。
PydanticAI 和 OpenAI Agents SDK 都把 tracing、sessions、guardrails、human-in-the-loop 放在核心能力里，不是偶然。

到了 Agentic Harness Engineering 这种更外层的循环，可观测性更直接变成 Harness 进化的前提：组件要可见，轨迹要能压缩成证据，修改要能和下一轮结果对上。

说得直一点，Loop 跑完以后，系统不能只留下一个“成功”或“失败”。

它要留下人能复盘的证据链。

Loop 和 Harness 的边界
这里需要把 Loop Engineering 和 Harness Engineering 的边界摆清楚。

我的理解是：

Harness 规定 Agent 怎么跑。
Loop 规定反馈怎么进入下一步。
Environment 规定反馈来自什么世界。
Harness 里有工具、权限、上下文、日志、状态、预算、测试、评审、沙箱。

Loop 则负责把这一轮结果带到下一轮：

• 继续做；
• 换路径；
• 触发评估；
• 写回状态；
• 开启子 Agent；
• 停止；
• 升级给人；
• 沉淀为 Harness 修改候选。
所以 Loop 不替代 Harness。

它更像 Harness 的运行节奏。

没有 Harness，Loop 只是模型在聊天框里反复自说自话。

没有 Loop，Harness 只是一次性工作台。

两者合在一起，Agent 才能进入真实工作现场。

再往外一层，Environment 还要回答反馈是否可信。测试本身不稳定、日志不完整、截图看起来通过但接口状态没变，这些都不是 Loop 自己能解决的。Loop 只能消费反馈；反馈质量，还是要靠环境给。

从 Loop 到 Graph
从 Structured Graph 的角度看，Loop 还有一个容易被忽略的问题。

From Agent Loops to Structured Graphs 没有继续鼓励大家多写 Loop，而是提醒：Agent Loop 本身有结构性限制。

它把普通 Agent Loop 看成一种“单 ready unit 调度器”：任意时刻只有一个可执行单元，下一步做什么，主要靠 LLM 在上下文里判断。

这带来几个问题：

• 依赖关系不可见；
• 恢复策略不可控；
• 历史不断变化，调试困难。
论文提出的 Structured Graph Harness，是把控制流从隐含上下文里拿出来，放到显式 DAG 里。

这不一定是所有团队明天就要采用的方案。

但它提醒我们一个方向：

复杂 Loop 到最后，可能不会继续长成更长的聊天记录，而会长成更明确的执行图、状态机和调度协议。

这条线对架构师并不陌生。

只要进入生产，系统最终都会要求可解释、可回放、可审计。

纯上下文驱动的 Loop 很灵活，但越往后越难管。

Graph、state machine、workflow、DAG 这些老东西，可能会重新回来。

原因很实际：它们能把依赖和恢复写清楚。

再往外看，Agentic Harness Engineering 给了另一条线。

它关心的是很多次运行之后，系统能不能从失败里修改 Harness。

Agentic Harness Engineering 把 Harness 自动演进拆成三个可观测性：

可观测性
工程含义
没有它会怎样
Component observability
每个可编辑 Harness 组件都有文件级表示，可以修改、回滚、对比
修改边界不清，最后只会不断加 prompt
Experience observability
原始轨迹被压成分层证据，能追到失败根因
日志太长，真正有用的信号被淹没
Decision observability
每次修改都带预测，下一轮用结果验证
改动看起来合理，但不知道是否真的有效
这组拆法对真实工程很有启发。

很多团队也想让系统“自我改进”，但一开始就跳到“让 Agent 改自己的 prompt”。这很危险，因为 prompt 是最容易改、也最容易越堆越厚的一层。

更稳的路线是先让 Loop 留下证据：

哪类任务反复失败
失败发生在哪一步
当时用了哪版规则和工具
Agent 做了什么判断
验证器为什么拒绝
候选修改针对哪个失败机制
修改后有没有回归
这些问题答得出来，Self-Harness 才像工程。

答不出来，它就只是“自动给自动化再加一层自动化”。

所以从 Loop 到 Graph，再到 Self-Harness，主线其实很一致：把隐含在上下文里的依赖、证据和决策，搬到系统能检查的位置。

开源项目该看什么
沿着验证、状态、隔离、观测这几个边界去看，几个开源项目尤其值得研究：Codex CLI、OpenHands、PydanticAI、OpenAI Agents SDK。

看这些项目时，功能数量反而不是最关键的入口。

更有价值的是看六个边界。

如果只按工程对象来分，可以先这样看：

项目
更值得看的点
对 Loop 的启发
Codex CLI / Codex Goals
本地 coding agent、Goal、线程内持久目标、证据检查
目标要变成可验证的完成合同，而不只是一句愿望
OpenHands / Agent Canvas
agent server、automation server、Docker/VM/云端 backend
Loop 进入团队后，需要控制台、后端和运行隔离
PydanticAI
类型安全、依赖注入、eval、OTel tracing、durable execution、human approval
Agent framework 不只是包模型，还是把工具、输出和状态变成可验证对象
OpenAI Agents SDK
agents、handoffs、guardrails、sessions、tracing、sandbox agents
多 Agent 工作流要先把交接、护栏、会话和沙箱边界写清楚
这些项目的共同趋势很明显：大家都在把 Agent 从聊天框里挪出来，放进一个能运行、能追踪、能暂停、能恢复的工作现场。

这也正是 AI 工作台那条线想表达的方向：工具不是越多越好，关键是计划、上下文、执行、验证和治理有没有各自的位置。

1. 工具边界
Agent 能调用什么工具？

工具 schema 怎么描述？

危险工具有没有确认、沙箱或权限控制？

2. 状态边界
任务状态在哪里？

是只存在上下文里，还是落到文件、数据库、trace 或任务对象？

3. 隔离边界
多个 Agent 同时跑时，怎么避免互相污染？

worktree、容器、虚拟机、远程 agent server，解决的都是这类问题。

4. 反馈边界
结果由谁判断？

是自评、测试、外部评估器，还是人工 review？

5. 编排边界
子 Agent 怎么启动？

输出怎么汇总？

冲突怎么处理？

主 Agent 有没有权力自动派生更多工作？

6. 追踪边界
每一步工具调用、模型输出、文件修改、验证结果，能不能回放？

出了问题，能不能定位是哪一轮、哪条规则、哪个工具导致的？

这些问题，比“支持多少模型”更接近 Loop Engineering 的核心。

模型会换。

Loop 的控制面如果设计得好，系统才有机会演进。

第一条 Loop 怎么落地
团队第一次试 Loop，入口最好小一点。

更稳的第一条 Loop，可以选这几类：

• 文档链接检查；
• CI 失败分流；
• flaky test 归类；
• 依赖升级预检查；
• issue 自动补充复现信息；
• PR review comment 小范围修复；
• 线上错误日报归类。
共同点是：反馈明确，风险可控，动作范围窄，容易停止。

可以先写一份很朴素的 Loop 合同。

这份合同的价值，不在多一个文档，而在让边界提前暴露出来：

名称：这条 Loop 负责什么
触发：谁叫醒它，多久一次，或由什么事件触发
目标：什么结果算完成
输入：它能读哪些事实源
范围：它能改哪些目录、文件、issue 或任务对象
工具：它能调用哪些命令、API、连接器
验证：哪些检查需要通过
停止：成功、预算耗尽、连续无进展、阻塞时分别怎么停
升级：哪些情况需要交给人
状态：每轮把目标、证据、动作、失败、下一步写回哪里
清理：失败后怎么撤回临时分支、worktree、文件和外部副作用
以文档链接检查为例，可以写成这样：

名称：docs-link-loop
触发：每天 9 点，或 docs 目录合并后触发
目标：修复明显失效链接，无法判断的链接进入人工队列
输入：docs 目录、链接检查报告、最近一次文档构建日志
范围：只允许改 docs 内部链接和引用说明，不改产品承诺、价格、法律文本
工具：链接检查器、文档构建命令、git diff、issue 创建工具
验证：链接检查通过，文档构建通过，diff 只包含允许范围
停止：最多 2 轮；连续无 diff 停止；同一链接失败两次停止
升级：外部站点改版、法律/价格/商业承诺、人类语义判断，交还给人
状态：写回 issue，包含已处理链接、失败原因、待人工确认项
清理：未通过验证的修改不提交，临时分支保留为草稿或删除
这条 Loop 不宏大，也不刺激。

但它具备生产级 Loop 的基本形状。

可触发、可验证、可停止、可接手、可清理。

这类小 Loop 跑稳以后，再考虑 CI 修复、PR 分流、外部信息监控、长任务 Goal。

顺序反过来，通常会很痛苦。

对研发团队来说，CI 分流也很适合做第二条。

可以先不让 Agent 直接修代码，只让它把失败分成几类：

分类
证据
后续动作
环境问题
runner 异常、依赖下载失败、网络超时
只开运维/平台 issue
flaky test
近几天同测例间歇失败
标记 flaky，附历史失败链接
最近提交引入
失败首次出现在某个 commit 后
开隔离 worktree 尝试复现
旧问题复现
历史 issue 或日志已有同类失败
关联旧 issue，不重复修
无法判断
证据不足或日志矛盾
交还给人
这类 Loop 的价值不在“自动修好所有 CI”。

它先把每天重复的第一轮排查做干净，让人把注意力留给真正需要判断的地方。

如果说前面的 Agentic Engineering 文章讲的是“给 Agent 搭一张工作台”，这里的 CI 分流 Loop 就是把那张工作台变成一个小循环：有输入，有证据，有状态，也有明确的停止点。

写在最后
Loop Engineering 并没有让提示词工程消失。

Prompt 还在，只是位置变了。

它从聊天框里的临时输入，变成了 Goal、Skill、Runbook、状态账本、验证器和停止条件的一部分。

Loop 也没有让人彻底退出。

换到工程分工里看，人从每一步敲 prompt，前移到设计目标、边界、反馈和接手协议。

这件事对架构师其实并不陌生。

我们过去设计系统，也会设计接口、状态、错误码、重试、超时、幂等、审计和回滚。

现在设计 Agent，只是把同样的工程纪律搬到智能体运行时里。

Loop 最后比的不是谁转得更久。

而是谁能在每一轮之后留下更可靠的证据、更清楚的状态、更诚实的停止条件。

Agent 从来不缺 Loop。缺的是 可验证、可接手、知道何时停止 的 Loop 工程学。

参考资料
• Addy Osmani, Loop Engineering
• Firecrawl, Loop Engineering: Should You Stop Prompting Agents and Start Designing Loops
• Oracle, What Is the AI Agent Loop?
• OpenAI, Harness engineering: leveraging Codex in an agent-first world
• Martin Fowler, Harness engineering for coding agent users
• DataScienceDojo, Agentic Loops: From ReAct to Loop Engineering
• Mem0, Loop Engineering for AI Agents: Memory-First Design
• Hu Wei, From Agent Loops to Structured Graphs
• Jiahang Lin et al., Agentic Harness Engineering
• Codex CLI, OpenHands, PydanticAI, OpenAI Agents SDK