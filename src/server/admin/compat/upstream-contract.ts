import {
  STABLE_CAPABILITY_CODES,
  type StableCapabilityCode,
} from "@/server/capabilities";

export const EXPECTED_UPSTREAM_API_MODULES = [
  "accessControl",
  "acp",
  "agent",
  "agentStats",
  "agents",
  "auth",
  "backup",
  "channel",
  "chat",
  "codingMode",
  "codingProject",
  "commands",
  "console",
  "cronjob",
  "debug",
  "env",
  "git",
  "heartbeat",
  "language",
  "localModel",
  "market",
  "mcp",
  "plugin",
  "pluginMarket",
  "provider",
  "root",
  "security",
  "skill",
  "tokenUsage",
  "tools",
  "userTimezone",
  "workspace",
] as const;

export type UpstreamApiModuleName =
  (typeof EXPECTED_UPSTREAM_API_MODULES)[number];
export type UpstreamEndpointMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";
export type UpstreamEndpointStatus =
  | "mapped"
  | "redirected"
  | "disabled";

export type UpstreamEndpointContract = Readonly<{
  method: UpstreamEndpointMethod;
  path: string;
  status: UpstreamEndpointStatus;
  domain: string;
  disabledCode?: StableCapabilityCode;
  redirectTo?: string;
}>;

export type FlattenedUpstreamEndpointContract =
  UpstreamEndpointContract &
    Readonly<{
      module: UpstreamApiModuleName;
    }>;

export type UpstreamApiModuleContract = Readonly<{
  status: UpstreamEndpointStatus;
  domain: string;
  endpoints: readonly UpstreamEndpointContract[];
}>;

const PENDING =
  STABLE_CAPABILITY_CODES.adminConsoleMappingPending;

export const UPSTREAM_API_CONTRACT = Object.freeze({
  accessControl: moduleContract(
    "mapped",
    "inbox",
    mapped(
      "GET /access-control",
      "GET /access-control/:channel",
      "POST /access-control/whitelist/add",
      "POST /access-control/whitelist/remove",
      "POST /access-control/blacklist/add",
      "POST /access-control/blacklist/remove",
      "POST /access-control/remark",
      "GET /access-control/pending/all",
      "POST /access-control/pending/approve",
      "POST /access-control/pending/deny",
      "POST /access-control/pending/dismiss",
      "POST /access-control/pending/remark",
      "POST /access-control/username",
    ),
  ),
  acp: moduleContract(
    "disabled",
    "agent-resources",
    disabled(
      STABLE_CAPABILITY_CODES.acp,
      "GET /config/acp",
      "PUT /config/acp",
      "GET /config/acp/node-runtime",
      "PUT /config/acp/node-runtime",
      "GET /config/acp/:agentName",
      "PUT /config/acp/:agentName",
    ),
  ),
  agent: moduleContract(
    "mapped",
    "agent-runtime",
    disabled(
      PENDING,
      "GET /agent",
      "GET /agent/health",
      "POST /console/chat",
      "GET /agent/admin/status",
      "POST /agent/shutdown",
      "POST /agent/admin/shutdown",
      "GET /workspace/running-config",
      "PUT /workspace/running-config",
      "GET /workspace/language",
      "PUT /workspace/language",
      "GET /workspace/audio-mode",
      "PUT /workspace/audio-mode",
      "GET /workspace/transcription-providers",
      "PUT /workspace/transcription-provider",
      "GET /workspace/transcription-provider-type",
      "PUT /workspace/transcription-provider-type",
      "GET /workspace/local-whisper-status",
      "POST /workspace/transcribe",
    ),
  ),
  agentStats: moduleContract(
    "mapped",
    "stats",
    disabled(PENDING, "GET /agent-stats"),
  ),
  agents: moduleContract(
    "mapped",
    "agents",
    mapped(
      "GET /agents",
      "GET /agents/:agentId",
      "PUT /agents/:agentId",
      "PUT /agents/order",
      "PATCH /agents/:agentId/toggle",
      "PATCH /agents/:agentId/pin",
    ),
    disabled(
      STABLE_CAPABILITY_CODES.multiAgentCreate,
      "POST /agents",
    ),
    disabled(
      STABLE_CAPABILITY_CODES.multiAgentDelete,
      "DELETE /agents/:agentId",
    ),
  ),
  auth: moduleContract(
    "mapped",
    "auth",
    mapped("GET /auth/status"),
    disabled(
      PENDING,
      "POST /auth/login",
      "POST /auth/register",
      "POST /auth/update-profile",
    ),
  ),
  backup: moduleContract(
    "mapped",
    "backups",
    disabled(
      PENDING,
      "GET /backups",
      "GET /backups/:backupId",
      "POST /backups/stream",
      "POST /backups/:backupId/restore",
      "POST /backups/delete",
      "GET /backups/:backupId/export",
      "POST /backups/import",
    ),
  ),
  channel: moduleContract(
    "mapped",
    "channels",
    mapped(
      "GET /config/channels/types",
      "GET /config/channels",
      "GET /config/channels/schemas",
      "PUT /config/channels",
      "GET /config/channels/:channelType",
      "PUT /config/channels/:channelType",
    ),
    disabled(
      PENDING,
      "GET /config/channels/:channelType/qrcode",
      "GET /config/channels/:channelType/qrcode/status",
    ),
  ),
  chat: moduleContract(
    "redirected",
    "home-chat",
    mapped(
      "GET /chats",
      "GET /chats/:chatId",
      "PUT /chats/:chatId",
      "DELETE /chats/:chatId",
      "POST /chats/batch-delete",
      "POST /chats/:chatId/archive",
      "POST /chats/:chatId/unarchive",
      "POST /chats/actions/batch-archive",
      "POST /chats/actions/batch-unarchive",
    ),
    redirected(
      "/",
      "POST /console/upload",
      "GET /files/preview/:filename",
      "POST /chats",
      "POST /console/chat/stop",
    ),
  ),
  codingMode: moduleContract(
    "disabled",
    "coding",
    disabled(
      STABLE_CAPABILITY_CODES.codingMode,
      "GET /coding-mode",
      "POST /coding-mode",
    ),
  ),
  codingProject: moduleContract(
    "disabled",
    "coding",
    disabled(
      STABLE_CAPABILITY_CODES.codingProject,
      "GET /workspace/coding-project",
      "PUT /workspace/coding-project",
      "POST /workspace/coding-project/create",
      "GET /workspace/coding-project/list",
      "POST /workspace/coding-project/import-local",
      "POST /workspace/coding-project/upload-zip",
      "GET /workspace/coding-project/browse-dirs",
      "POST /workspace/coding-project/clone",
    ),
  ),
  commands: moduleContract(
    "mapped",
    "inbox",
    mapped(
      "POST /commands/check",
      "POST /approval/:action",
    ),
  ),
  console: moduleContract(
    "redirected",
    "inbox",
    mapped(
      "GET /console/push-messages",
      "GET /console/inbox/events",
      "POST /console/inbox/read",
      "DELETE /console/inbox/events/:eventId",
      "GET /console/inbox/traces/:runId",
    ),
  ),
  cronjob: moduleContract(
    "mapped",
    "schedules",
    mapped(
      "GET /cron/jobs",
      "POST /cron/jobs",
      "GET /cron/jobs/:jobId",
      "PUT /cron/jobs/:jobId",
      "DELETE /cron/jobs/:jobId",
      "POST /cron/jobs/:jobId/pause",
      "POST /cron/jobs/:jobId/resume",
      "POST /cron/jobs/:jobId/run",
      "GET /cron/jobs/:jobId/state",
      "GET /cron/jobs/:jobId/history",
      "GET /cron/dispatch-targets",
    ),
  ),
  debug: moduleContract(
    "mapped",
    "operations",
    disabled(PENDING, "GET /console/debug/backend-logs"),
  ),
  env: moduleContract(
    "mapped",
    "operations",
    disabled(
      PENDING,
      "GET /envs",
      "PUT /envs",
      "DELETE /envs/:key",
    ),
  ),
  git: moduleContract(
    "disabled",
    "workspace",
    disabled(
      STABLE_CAPABILITY_CODES.workspaceGit,
      "GET /workspace/git/status",
      "GET /workspace/git/branches",
      "POST /workspace/git/checkout",
      "GET /workspace/git/diff",
      "POST /workspace/git/stage",
      "POST /workspace/git/unstage",
      "POST /workspace/git/commit",
      "GET /workspace/git/log",
      "POST /workspace/git/discard",
      "GET /workspace/git/commit-diff",
      "POST /workspace/git/revert",
    ),
  ),
  heartbeat: moduleContract(
    "mapped",
    "schedules",
    mapped(
      "GET /config/heartbeat",
      "PUT /config/heartbeat",
      "POST /config/heartbeat/run",
    ),
  ),
  language: moduleContract(
    "mapped",
    "preferences",
    mapped(
      "GET /settings/language",
      "PUT /settings/language",
    ),
    disabled(PENDING, "GET /settings/upload-limit"),
  ),
  localModel: moduleContract(
    "disabled",
    "models",
    disabled(
      STABLE_CAPABILITY_CODES.localModels,
      "GET /local-models/server",
      "GET /local-models/server/update",
      "POST /local-models/server/download",
      "GET /local-models/server/download",
      "DELETE /local-models/server/download",
      "GET /local-models/models",
      "POST /local-models/models/download",
      "GET /local-models/models/download",
      "DELETE /local-models/models/download",
      "DELETE /local-models/models/:modelId",
      "POST /local-models/server",
      "DELETE /local-models/server",
    ),
  ),
  market: moduleContract(
    "disabled",
    "plugins",
    disabled(
      STABLE_CAPABILITY_CODES.extensionMarket,
      "GET /market/providers",
      "GET /market/categories",
      "POST /market/search",
    ),
  ),
  mcp: moduleContract(
    "mapped",
    "agent-resources",
    disabled(
      PENDING,
      "GET /mcp",
      "GET /mcp/:clientKey",
      "POST /mcp",
      "PUT /mcp/:clientKey",
      "PATCH /mcp/toggle/:clientKey",
      "DELETE /mcp/:clientKey",
      "GET /mcp/tools/:clientKey",
      "GET /mcp/access-principals",
      "GET /mcp/policy/:clientKey",
      "PUT /mcp/policy/:clientKey",
      "PUT /mcp/tools/:clientKey",
      "POST /mcp/oauth/start/:clientKey",
      "GET /mcp/oauth/status/:clientKey",
      "DELETE /mcp/oauth/:clientKey",
    ),
  ),
  plugin: moduleContract(
    "disabled",
    "plugins",
    disabled(
      STABLE_CAPABILITY_CODES.plugins,
      "GET /plugins",
      "GET /plugins/catalog",
      "POST /plugins/install",
      "POST /plugins/upload",
      "DELETE /plugins/:pluginId",
      "GET /plugins/:pluginId/status",
    ),
  ),
  pluginMarket: moduleContract(
    "disabled",
    "plugins",
    disabled(
      STABLE_CAPABILITY_CODES.extensionMarket,
      "GET /plugins/market/search",
    ),
  ),
  provider: moduleContract(
    "mapped",
    "models",
    disabled(
      PENDING,
      "GET /models",
      "PUT /models/:providerId/config",
      "GET /models/active",
      "PUT /models/active",
      "POST /models/custom-providers",
      "DELETE /models/custom-providers/:providerId",
      "POST /models/:providerId/models",
      "DELETE /models/:providerId/models/:modelId",
      "PUT /models/:providerId/models/:modelId/config",
      "PUT /local-models/config",
      "GET /local-models/config",
      "POST /models/:providerId/test",
      "POST /models/:providerId/models/test",
      "POST /models/:providerId/discover",
      "POST /models/:providerId/models/:modelId/probe-multimodal",
      "GET /models/openrouter/series",
      "POST /models/openrouter/discover-extended",
      "POST /models/openrouter/models/filter",
      "POST /providers/:providerId/oauth/start",
      "GET /providers/:providerId/oauth/status",
    ),
  ),
  root: moduleContract(
    "mapped",
    "system",
    mapped("GET /", "GET /version"),
  ),
  security: moduleContract(
    "mapped",
    "security",
    disabled(
      PENDING,
      "GET /config/security/tool-guard",
      "PUT /config/security/tool-guard",
      "GET /config/security/tool-guard/builtin-rules",
      "GET /config/security/sandbox",
      "PUT /config/security/sandbox",
      "GET /config/security/file-guard",
      "PUT /config/security/file-guard",
      "GET /config/security/skill-scanner",
      "PUT /config/security/skill-scanner",
      "GET /config/security/skill-scanner/blocked-history",
      "DELETE /config/security/skill-scanner/blocked-history",
      "DELETE /config/security/skill-scanner/blocked-history/:index",
      "POST /config/security/skill-scanner/whitelist",
      "DELETE /config/security/skill-scanner/whitelist/:skillName",
      "GET /config/security/allow-no-auth-hosts",
      "PUT /config/security/allow-no-auth-hosts",
    ),
  ),
  skill: moduleContract(
    "mapped",
    "agent-resources",
    disabled(
      PENDING,
      "GET /skills",
      "GET /skills/workspaces",
      "GET /skills/pool",
      "POST /skills/refresh",
      "POST /skills/pool/refresh",
      "GET /skills/hub/search",
      "POST /skills",
      "PUT /skills/save",
      "POST /skills/pool/create",
      "PUT /skills/pool/save",
      "POST /skills/:skillName/enable",
      "POST /skills/:skillName/disable",
      "POST /skills/batch-enable",
      "POST /skills/batch-disable",
      "POST /skills/batch-delete",
      "POST /skills/pool/batch-delete",
      "DELETE /skills/:skillName",
      "POST /skills/hub/install/start",
      "POST /skills/pool/import",
      "GET /skills/hub/install/status/:taskId",
      "POST /skills/hub/install/cancel/:taskId",
      "GET /skills/pool/builtin-sources",
      "GET /skills/pool/builtin-notice",
      "POST /skills/pool/import-builtin",
      "POST /skills/pool/:skillName/update-builtin",
      "DELETE /skills/pool/:skillName",
      "POST /skills/pool/upload",
      "POST /skills/pool/download",
      "PUT /skills/:skillName/channels",
      "PUT /skills/:skillName/tags",
      "PUT /skills/pool/:skillName/tags",
      "PUT /skills/pool/:skillName/auto-update",
      "GET /skills/:skillName/config",
      "PUT /skills/:skillName/config",
      "DELETE /skills/:skillName/config",
      "GET /skills/pool/:skillName/config",
      "PUT /skills/pool/:skillName/config",
      "DELETE /skills/pool/:skillName/config",
      "POST /skills/ai/optimize/stream",
      "POST /skills/upload",
      "POST /skills/pool/upload-zip",
    ),
  ),
  tokenUsage: moduleContract(
    "mapped",
    "stats",
    disabled(
      PENDING,
      "GET /token-usage",
      "GET /token-usage/details",
    ),
  ),
  tools: moduleContract(
    "mapped",
    "agent-resources",
    disabled(
      PENDING,
      "GET /tools",
      "PATCH /tools/:toolName/toggle",
      "PATCH /tools/:toolName/async-execution",
      "GET /tools/:toolName/config",
      "POST /tools/:toolName/config",
    ),
  ),
  userTimezone: moduleContract(
    "mapped",
    "preferences",
    mapped(
      "GET /config/user-timezone",
      "PUT /config/user-timezone",
    ),
  ),
  workspace: moduleContract(
    "mapped",
    "workspace",
    disabled(
      PENDING,
      "GET /workspace/files",
      "GET /workspace/files/:fileName",
      "PUT /workspace/files/:fileName",
      "GET /workspace/download",
      "POST /workspace/upload",
      "GET /workspace/memory",
      "GET /workspace/memory/:memoryPath",
      "PUT /workspace/memory/:memoryPath",
      "GET /workspace/system-prompt-files",
      "PUT /workspace/system-prompt-files",
      "GET /workspace/code-files",
      "GET /workspace/code-files/:filePath",
      "PUT /workspace/code-files/:filePath",
      "GET /workspace/watch",
      "GET /workspace/binary-files/:filePath",
    ),
  ),
} satisfies Record<UpstreamApiModuleName, UpstreamApiModuleContract>);

export function listUpstreamEndpointContracts():
  readonly FlattenedUpstreamEndpointContract[] {
  return EXPECTED_UPSTREAM_API_MODULES.flatMap((moduleName) =>
    UPSTREAM_API_CONTRACT[moduleName].endpoints.map((endpoint) => ({
      module: moduleName,
      ...endpoint,
    })),
  );
}

function moduleContract(
  status: UpstreamEndpointStatus,
  domain: string,
  ...groups: readonly (readonly Omit<
    UpstreamEndpointContract,
    "domain"
  >[])[]
): UpstreamApiModuleContract {
  return Object.freeze({
    status,
    domain,
    endpoints: Object.freeze(
      groups.flat().map((endpoint) =>
        Object.freeze({ ...endpoint, domain }),
      ),
    ),
  });
}

function mapped(
  ...specs: readonly string[]
): readonly Omit<UpstreamEndpointContract, "domain">[] {
  return specs.map((spec) => ({
    ...parseSpec(spec),
    status: "mapped",
  }));
}

function disabled(
  disabledCode: StableCapabilityCode,
  ...specs: readonly string[]
): readonly Omit<UpstreamEndpointContract, "domain">[] {
  return specs.map((spec) => ({
    ...parseSpec(spec),
    status: "disabled",
    disabledCode,
  }));
}

function redirected(
  redirectTo: string,
  ...specs: readonly string[]
): readonly Omit<UpstreamEndpointContract, "domain">[] {
  return specs.map((spec) => ({
    ...parseSpec(spec),
    status: "redirected",
    redirectTo,
  }));
}

function parseSpec(spec: string): Readonly<{
  method: UpstreamEndpointMethod;
  path: string;
}> {
  const separator = spec.indexOf(" ");
  const method = spec.slice(0, separator);
  const path = spec.slice(separator + 1);
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    (path !== "/" && path.endsWith("/"))
  ) {
    throw new Error(`invalid_upstream_endpoint_spec:${spec}`);
  }
  return {
    method: method as UpstreamEndpointMethod,
    path,
  };
}
