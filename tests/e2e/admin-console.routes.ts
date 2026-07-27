export const QWENPAW_CONSOLE_ROUTE_BASELINES = [
  {
    route: "/coding",
    expectedPath: "/coding",
    routeId: "core.coding",
    marker: "编程模式暂未开放",
  },
  {
    route: "/channels",
    expectedPath: "/channels",
    routeId: "core.channels",
    marker: "频道",
  },
  {
    route: "/sessions",
    expectedPath: "/sessions",
    routeId: "core.sessions",
    marker: "会话",
  },
  {
    route: "/inbox",
    expectedPath: "/inbox",
    routeId: "core.inbox",
    marker: "收件箱",
  },
  {
    route: "/cron-jobs",
    expectedPath: "/cron-jobs",
    routeId: "core.cron-jobs",
    marker: "定时任务",
  },
  {
    route: "/heartbeat",
    expectedPath: "/heartbeat",
    routeId: "core.heartbeat",
    marker: "心跳",
  },
  {
    route: "/skills",
    expectedPath: "/skills",
    routeId: "core.skills",
    marker: "技能",
  },
  {
    route: "/skill-pool",
    expectedPath: "/skill-pool",
    routeId: "core.skill-pool",
    marker: "技能池",
  },
  {
    route: "/tools",
    expectedPath: "/tools",
    routeId: "core.tools",
    marker: "内置工具",
  },
  {
    route: "/mcp",
    expectedPath: "/mcp",
    routeId: "core.mcp",
    marker: "MCP 客户端",
  },
  {
    route: "/acp",
    expectedPath: "/acp",
    routeId: "core.acp",
    marker: "ACP",
  },
  {
    route: "/ACP",
    expectedPath: "/acp",
    routeId: "core.acp",
    marker: "ACP",
  },
  {
    route: "/workspace",
    expectedPath: "/workspace",
    routeId: "core.workspace",
    marker: "文件",
  },
  {
    route: "/agents",
    expectedPath: "/agents",
    routeId: "core.agents",
    marker: "智能体",
  },
  {
    route: "/models",
    expectedPath: "/models",
    routeId: "core.models",
    marker: "模型提供商",
    caseInsensitivePath: "/MODELS",
  },
  {
    route: "/environments",
    expectedPath: "/environments",
    routeId: "core.environments",
    marker: "渠道运行节点",
  },
  {
    route: "/agent-config",
    expectedPath: "/agent-config",
    routeId: "core.agent-config",
    marker: "重 试",
  },
  {
    route: "/security",
    expectedPath: "/security",
    routeId: "core.security",
    marker: "重 试",
  },
  {
    route: "/token-usage",
    expectedPath: "/token-usage",
    routeId: "core.token-usage",
    marker: "Token 消耗",
  },
  {
    route: "/agent-stats",
    expectedPath: "/agent-stats",
    routeId: "core.agent-stats",
    marker: "智能体统计",
  },
  {
    route: "/voice-transcription",
    expectedPath: "/voice-transcription",
    routeId: "core.voice-transcription",
    marker: "语音转写",
  },
  {
    route: "/debug",
    expectedPath: "/debug",
    routeId: "core.debug",
    marker: "调试",
  },
  {
    route: "/backups",
    expectedPath: "/backups",
    routeId: "core.backups",
    marker: "备份",
  },
  {
    route: "/plugin-manager",
    expectedPath: "/plugin-manager",
    routeId: "core.plugin-manager",
    marker: "插件管理",
  },
  {
    route: "/",
    expectedPath: "/inbox",
    routeId: "core.inbox",
    marker: "收件箱",
  },
] as const;

export const QWENPAW_BUILTIN_ROUTES = [
  "/chat",
  ...QWENPAW_CONSOLE_ROUTE_BASELINES.map(({ route }) => route),
] as const;

export const DIGITALMATE_PAGE_ROUTE_BASELINES = [
  {
    route: "/interjections",
    expectedPath: "/interjections",
    routeId: "digitalmate.interjections",
    marker: "群聊插话",
  },
  {
    route: "/goals",
    expectedPath: "/goals",
    routeId: "digitalmate.goals",
    marker: "目标管理",
  },
  {
    route: "/memory",
    expectedPath: "/memory",
    routeId: "digitalmate.memory",
    marker: "记忆",
  },
  {
    route: "/reflections",
    expectedPath: "/reflections",
    routeId: "digitalmate.reflections",
    marker: "反思",
  },
] as const;

export const DIGITALMATE_ADMIN_ROUTE_BASELINES = [
  ...QWENPAW_CONSOLE_ROUTE_BASELINES,
  ...DIGITALMATE_PAGE_ROUTE_BASELINES,
] as const;

export const DIGITALMATE_ADMIN_ROUTES = [
  ...QWENPAW_BUILTIN_ROUTES,
  ...DIGITALMATE_PAGE_ROUTE_BASELINES.map(({ route }) => route),
] as const;
