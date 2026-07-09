最近 Agent Loop 被频繁提起。
我的第一反应是先把它放回工程现场里看。
Loop 并不神秘。传统开发里一直有各种 loop：消息消费循环、任务调度循环、CI Pipeline、状态机、重试队列、前端交互流、异步 Job Runner。区别在于，以前循环里跑的是确定性代码；现在循环里多了一个会规划、会调用工具、也会犯错的 Agent。问题也就跟着变了。以前我们主要关心任务能不能成功执行。现在还要关心：Agent 每一轮依据什么状态做判断，哪些动作会真的写入外部系统，失败以后是重试、降级，还是交给人。跑完以后，还得有人能复盘它到底做了什么。Loop Engineering 要处理的，是怎样把 Agent 的多轮执行写成一个可维护、可观察、可回放的工程闭环。沿着这条线看，第一版 Loop 怎么落地会更清楚。太长不看版• Loop 更接近任务运行时，不只是一条更长的 prompt。• 一个可用 Loop 至少要拆出状态、动作、验证、提交和日志。• 传统开发里的状态机、任务队列、CI Pipeline、前端状态流，都能帮我们把 Loop 讲清楚。• 第一版更适合从 CI 失败分流这类小闭环开始：读多、改少、证据明确。先把 Loop 从 prompt 里拿出来很多人第一次做 Agent Loop，会把它写成这样：请你完成这个任务。
如果失败，请分析原因并继续修复。

直到任务完成为止。这个写法能跑 demo。但一进真实项目，很快会遇到几个问题：• 模型说“完成了”，但外部系统没有证据；• 中间失败过几次，后来没人说得清；• Agent 读了旧上下文，继续做了一个过期判断；• 工具调用有副作用，回滚困难；• 任务跑长以后，成本、权限和责任边界都变模糊。问题往往不在模型聪不聪明。更常见的情况是：我们把一个工程系统，塞进了一段自然语言指令里。传统开发不会这样写长期任务。写一个异步任务，我们会考虑 job id、状态、重试、幂等、日志、错误码、监控、死信队列。写一个 CI Pipeline，我们会考虑 checkout、install、test、build、artifact、report，每一步都有输入输出。写一个前端复杂交互，我们会考虑状态在哪里、异步请求在哪里、提交动作在哪里、失败反馈在哪里。写 React 也是这样：状态变化和副作用如果散在各处，页面一复杂就很难查。Agent Loop 也一样。它更像一个带模型能力的任务运行时，和“更长的对话”不是一回事。从这里开始，设计方式会变得很不一样。这条线也接得上我们前几天聊过的几个问题。《CLAUDE.md 拆解》讲的是 Agent 进仓库前先看到什么，减少启动时的错误假设；《Harness 工程还没唱罢，Environment 工程已然登场》讲的是 Agent 跑在什么工作现场里，反馈是否可信。到了 Loop 这一层，问题就变成：这些上下文、工具和反馈，能不能被组织成一套持续推进的任务运行时。一个 Loop 至少有六个部件我通常会把最小 Loop 拆成六个部件。
部件作用常见错误State保存当前任务事实只靠聊天上下文记忆Intent决定下一步要做什么让模型直接边想边改Action访问外部系统工具权限过大、缺少白名单Verify检查结果是否可信执行者自己给自己盖章Commit把结果写入真实系统候选结果和正式结果混在一起Trace记录每轮发生了什么只留下最后一句总结图 1：Loop 的六个部件Loop 的六个部件这六个部件，很多团队其实都熟。只是以前它们散在不同系统里。在任务队列里叫 status、worker、retry、dead letter。在工作流引擎里叫 node、edge、condition、transition。在 CI 里叫 step、job、artifact、report。在前端里叫 state、event、side effect、submit。Agent Loop 只是把这些老问题重新组合了一遍。模型负责的是其中一部分：理解上下文、提出计划、生成候选动作、解释失败原因。但状态推进、工具边界、结果提交、日志复盘，不适合全交给模型自由发挥。传统开发的经验，能直接拿来用几个老经验可以直接搬过来。1. Job Runner：每个任务都要有状态一个异步任务通常不会只有 running 和 done。它至少会有：pending -> running -> retrying -> succeeded
running -> failed -> retrying
running -> blocked -> needs_human
retrying -> failed_permanentlyAgent Loop 也需要类似状态。如果没有状态，系统只知道“Agent 还在跑”。至于它为什么跑、跑到哪一步、还能不能继续跑，都要靠读聊天记录猜。这很难维护。2. CI Pipeline：每一步都要有产物CI 好用，不只是因为它能自动跑。更重要的是每一步会留下产物：• 哪个 commit 触发；• 哪个 job 失败；• 哪段日志报错；• 哪个 artifact 生成；• 哪个报告可以下载。Agent Loop 也要这样。每一轮不能只留下“我分析了一下”。它要留下证据：读了哪些文件、跑了哪些命令、拿到了什么错误、为什么判断下一步该这么做。3. 前端状态流：先推导，再提交前端复杂交互里，一个常见经验是：先根据状态推导界面和候选动作，再把提交动作集中处理。这个经验对 Agent 很有帮助。模型可以先生成计划、diff、comment 草稿、修复建议。这些都还是候选结果。写入 GitHub、创建 PR、改数据库、发消息、触发部署，要走受控的提交点。候选和提交分开，系统才有机会验证、审计和回滚。如果类比到 React，render 阶段只是根据状态算出界面，不适合顺手改外部系统。useEffect、React Query、SWR 这类工具解决的，很多时候就是把请求、缓存、重试和错误处理放到更明确的位置。Agent Loop 也可以借这个直觉：先让模型产出候选动作，再由受控的执行层去做副作用。图 2：传统开发经验怎样迁移到 Agent Loop
传统开发经验怎样迁移到 Agent Loop
最小 demo：CI 失败分流 Loop看一个小 demo 会更清楚。假设团队每天都有一些 CI 失败。人肉分流很烦，但直接让 Agent 自动修所有问题又太急。第一版可以只做 CI 失败分流：读取失败 job、日志片段、相关 PR 和最近 commit，判断失败类型，再生成一条带证据的分流建议。如果证据不够，就停下来。遇到权限、部署、账单、生产配置这类问题，直接交给人。这个 Loop 的价值很朴素：先把低价值的搜集和归类工作做掉，把证据摆到人面前。图 3：CI 失败分流 LoopCI 失败分流 Loop先定义状态。{
  "runId": "ci-triage-20260626-001",
  "goal": "triage failing CI jobs",
  "phase": "collecting",
  "attempt": 0,
  "maxAttempts": 2,
  "evidence": [],
  "classification": null,
  "proposal": null,
  "handoffReason": null
}这段状态很普通。但它解决了一个关键问题：系统不再只问“Agent 说了什么”，而是开始问“任务现在处于什么状态”。再定义状态类型。type Phase =
  | "collecting"
  | "classifying"
  | "drafting"
  | "verifying"
  | "ready_to_commit"
  | "done"
  | "needs_human";

type Evidence = {
  source: "ci_log" | "pull_request" | "commit" | "issue";
  url: string;
  summary: string;
};

type Classification =
  | "test_failure"
  | "dependency_failure"
  | "permission_failure"
  | "infra_failure"
  | "unknown";

type LoopState = {
  runId: string;
  goal: string;
  phase: Phase;
  attempt: number;
  maxAttempts: number;
  evidence: Evidence[];
  classification: Classification | null;
  proposal: string | null;
  handoffReason: string | null;
};然后定义事件。type Event =
  | { type: "EVIDENCE_COLLECTED"; evidence: Evidence[] }
  | { type: "CLASSIFIED"; classification: Classification }
  | { type: "PROPOSAL_DRAFTED"; proposal: string }
  | { type: "VERIFIED" }
  | { type: "VERIFICATION_FAILED"; reason: string }
  | { type: "COMMITTED" }
  | { type: "HANDOFF"; reason: string };有了状态和事件，才能写状态转移。function reduce(state: LoopState, event: Event): LoopState {
  switch (event.type) {
    case "EVIDENCE_COLLECTED":
      return {
        ...state,
        phase: "classifying",
        evidence: [...state.evidence, ...event.evidence],
      };

    case "CLASSIFIED":
      if (event.classification === "permission_failure") {
        return {
          ...state,
          phase: "needs_human",
          classification: event.classification,
          handoffReason: "Permission failure requires human review",
        };
      }

      return {
        ...state,
        phase: "drafting",
        classification: event.classification,
      };

    case "PROPOSAL_DRAFTED":
      return {
        ...state,
        phase: "verifying",
        proposal: event.proposal,
      };

    case "VERIFIED":
      return {
        ...state,
        phase: "ready_to_commit",
      };

    case "VERIFICATION_FAILED":
      if (state.attempt + 1 >= state.maxAttempts) {
        return {
          ...state,
          phase: "needs_human",
          handoffReason: event.reason,
        };
      }

      return {
        ...state,
        phase: "collecting",
        attempt: state.attempt + 1,
      };

    case "COMMITTED":
      return {
        ...state,
        phase: "done",
      };

    case "HANDOFF":
      return {
        ...state,
        phase: "needs_human",
        handoffReason: event.reason,
      };
  }
}这里最值得看的不是 TypeScript 写法。它把“能不能继续跑”从模型自由判断里拿出来，变成了工程规则。权限问题不继续修。验证失败超过次数不继续修。没有证据不进入提交。再补一层执行器。type Intent =
  | { type: "COLLECT_EVIDENCE" }
  | { type: "CLASSIFY" }
  | { type: "DRAFT_PROPOSAL" }
  | { type: "VERIFY" }
  | { type: "COMMIT" }
  | { type: "STOP" };

type Env = {
  store: {
    append(state: LoopState): Promise<void>;
  };
  effects: {
    perform(intent: Intent, state: LoopState): Promise<Event>;
  };
};

function selectIntent(state: LoopState): Intent {
  switch (state.phase) {
    case "collecting":
      return { type: "COLLECT_EVIDENCE" };
    case "classifying":
      return { type: "CLASSIFY" };
    case "drafting":
      return { type: "DRAFT_PROPOSAL" };
    case "verifying":
      return { type: "VERIFY" };
    case "ready_to_commit":
      return { type: "COMMIT" };
    case "done":
    case "needs_human":
      return { type: "STOP" };
  }
}

async function runLoop(env: Env, initialState: LoopState): Promise<LoopState> {
  let state = initialState;

  for (let step = 0; step < 12; step += 1) {
    await env.store.append(state);

    const intent = selectIntent(state);
    if (intent.type === "STOP") {
      return state;
    }

    const event = await env.effects.perform(intent, state);
    state = reduce(state, event);
  }

  return reduce(state, {
    type: "HANDOFF",
    reason: "Loop exceeded step limit",
  });
}这里的 effects.perform 负责访问外部系统。它可以读 CI 日志，可以调用模型分类，可以生成建议，也可以写 comment。但它不能绕过状态机直接改最终结果。一个最小闭环就出来了：state -> intent -> effect -> event -> state如果要提交真实结果，再加一层：state -> intent -> effect -> verify -> commit落到工程里，这就是更实用的 Loop。Agent 仍然负责理解、生成和调用工具，但它运行在一个有状态、有边界、有证据的任务系统里。从前端角度看：副作用要收口前端开发里，最难维护的往往不是页面本身，很多麻烦来自散落在各处的副作用。一个点击事件里改状态、调接口、写缓存、跳路由、发埋点、弹 toast。短期看很方便，长期看每个 bug 都像连环案。Agent Loop 也有类似问题。如果模型在同一轮里既判断下一步、又调工具、又改文件、又宣布完成，系统就很难审。更稳的写法是把副作用收口：
动作类型建议边界读文件、读日志、读 issue默认允许，但要记录来源生成计划、生成 diff、生成 comment 草稿候选结果，不直接提交写文档、开候选 PR低风险写入，要求 diff 可审改权限、部署、删数据、对外承诺默认人工确认重试外部 API要有限流、退避和次数上限这听起来保守，但更容易变成团队流程，而不是停留在个人实验里。从架构角度看：控制面和执行面要分开从架构角度看，Agent Loop 至少可以拆成两层。这两层混在一起，后面会很难审。控制面要稳定、可预测、容易审计。执行面可以更灵活，可以根据不同任务接不同工具。很多平台系统也是这个思路：调度器不直接做业务，worker 不自己决定全局策略。Agent 适合放在执行面里发挥能力，也可以参与一部分判断。但全局停止条件、权限边界、提交策略，最好由更稳定的控制面兜住。图 4：控制面兜住边界，执行面释放能力控制面兜住边界，执行面释放能力第一版 Loop，选什么场景第一版先别选“自动优化整个系统”。范围太大，验证太难。我会更倾向于从这些流程开始：
场景为什么适合CI 失败分流输入明确，日志可引用，结果容易人工复核文档命令校验可读文件、可跑命令、失败证据清楚PR 风险预检diff 明确，能输出候选风险清单依赖升级影响面扫描可限制目录和包名，适合生成报告changelog 候选生成读多写少，结果可以人工编辑这些流程有一个共同点：读多，改少，证据清楚，失败可接手。第一版 Loop 能稳定跑这类任务，就已经很有价值。等状态、日志、验证和提交点都跑顺，再逐步开放更多动作。几个容易踩的坑1. 把聊天记录当状态库聊天记录可以帮助模型理解上下文，但不适合当唯一状态源。长任务会压缩上下文，会遗漏细节，也会把真实执行历史变成摘要。更稳的做法是把状态写到结构化记录里：Markdown、issue、数据库、事件日志都可以。关键是能回放、能对账。2. 让 Agent 自己决定所有权限模型可以建议下一步该做什么。但权限边界要写在系统里。比如哪些命令只读，哪些目录可写，哪些 API 只能查询，哪些动作需要人工确认。这类边界越早写清，后面越少靠经验救火。3. 没有独立验证代码任务有测试、lint、类型检查、构建。文档任务有链接检查、命令校验、事实来源。运营和业务任务至少要有来源引用、审批流、风险标签。如果没有外部验证，Loop 很容易把“说得像完成了”当成“真的完成了”。4. 只看结果，不看过程Loop 的价值不只在最后产出。过程里的 trace 很重要。它能告诉我们：模型在哪类任务上经常误判，哪个工具返回不稳定，哪条规则太宽，哪个验证器太松。这些记录会成为后续优化 Skills、Memory、工具和提示词的依据。和前几篇的关系我们前面聊过 Harness，也聊过 Environment。Harness 更像是把 Agent 装进一个能运行、能调用工具、能被约束的外壳。Environment 关心的是 Agent 跑在什么世界里：能看到什么，能改什么，失败成本由谁承担。这次再往实操层收一步。Loop 是这个环境里的任务运行时。它把目标拆成状态，把状态推进成动作，把动作交给工具，把工具结果带回验证，再决定是否提交或交还给人。这条链路清楚以后，Agent 更像团队系统的一部分，而不只是一个能力很强、边界却不够清楚的外部帮手。这也和《架构排熵》那篇文章互相补上了。那篇更关心 Loop 怎么持续发现和减少系统里的历史负担；今天则更关心第一版 Loop 怎么写成可维护的运行骨架。一个偏治理目标，一个偏运行结构，放在一起看会更完整。写在最后Loop Engineering 不必先被讲得很玄。从传统开发、前端和架构几个角度看，它都不是凭空冒出来的新东西。任务队列、状态机、CI Pipeline、状态流、副作用管理、控制面和执行面拆分，都能给我们提供很好的参照。变化在于：循环里多了一个 Agent。它能理解、规划、生成和调用工具，也会误判、遗漏、重复和自信过头。所以我的看法会更保守一点：先给这个循环一套工程骨架，把状态、动作、验证、提交和过程记录放到明面上，再逐步放开它能做的事。第一版做到这里，不算炫，但已经能解决不少真实问题。如喜欢本文，请点击右上角，把文章分享到朋友圈如有想了解学习的技术点，请留言给若飞安排分享因公众号更改推送规则，请点“在看”并加“星标”第一时间获取精彩技术分享·END·