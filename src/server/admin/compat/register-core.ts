import packageJson from "../../../../package.json";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {
  createAdminAuthStatusResponse,
  type AdminSecurityOptions,
} from "@/server/admin/compat/security";
import {
  createAuthStatusHandler,
  createAuthVerifyHandler,
  type SharedAuthStatusReader,
} from "@/server/admin/compat/handlers/auth";
import { createCapabilityDisabledHandler } from "@/server/admin/compat/handlers/capabilities";
import {
  getLanguage,
  getUserTimezone,
  putLanguage,
  putUserTimezone,
} from "@/server/admin/compat/handlers/preferences";
import {
  cloneAgent,
  createGetAgentHandler,
  createListAgentsHandler,
  createUpdateAgentHandler,
  createAgent,
  deleteAgent,
  importAgent,
  pinAgent,
  reorderAgents,
  toggleAgent,
  type AdminAgentProfileReader,
  type AdminAgentProfileUpdater,
} from "@/server/admin/compat/handlers/agents";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminCompatRouter,
  type AdminCompatRuntime,
} from "@/server/admin/compat/router";
import {
  listUpstreamEndpointContracts,
} from "@/server/admin/compat/upstream-contract";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { resolveDefaultAgentScope } from "@/server/agents/service";
import { STABLE_CAPABILITY_CODES } from "@/server/capabilities";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { getPool } from "@/server/db/client";
import {
  createAdminChannelConfigService,
} from "@/server/admin/channel-config";
import {
  createGetChannelHandler,
  createGetChannelHealthHandler,
  createListChannelsHandler,
  createUpdateChannelHandler,
  createUpdateChannelsHandler,
  createWechatQrCodeHandler,
  createWechatQrCodeStatusHandler,
  listChannelSchemas,
  listChannelTypes,
  type AdminChannelConfigReader,
  type AdminChannelConfigBatchWriter,
  type AdminChannelConfigWriter,
  type AdminChannelHealthResolver,
} from "@/server/admin/compat/handlers/channels";
import {
  createBindChannelNodeHandler,
  createChannelNodeEnrollmentHandler,
  createListChannelNodesHandler,
  createRevokeChannelNodeHandler,
  createRotateChannelNodeCertificateHandler,
  createUnbindChannelNodeHandler,
  type AdminChannelNodeService,
} from "@/server/admin/compat/handlers/nodes";
import {
  createWechatQrAuthService,
  type WechatQrAuthService,
} from "@/server/admin/wechat-qrcode";
import {
  createAdminChannelNodeService,
} from "@/server/admin/channel-nodes";
import {
  assertIndependentChannelNodeCertificateAuthorities,
  createOpenSslChannelNodeCertificateIssuer,
} from "@/server/admin/channel-node-certificates";
import {
  createAdminChannelHealthResolver,
} from "@/server/admin/channel-prerequisites";
import {
  createApprovalCommandHandler,
  createCheckCommandHandler,
  createDeleteInboxEventHandler,
  createGetInboxTraceHandler,
  createGetPushMessagesHandler,
  createListAccessControlHandler,
  createListInboxHandler,
  createListInboxEventsHandler,
  createListPendingAccessHandler,
  createMarkInboxReadHandler,
  createMutateAccessRulesHandler,
  createResolveAccessHandler,
  createUpdateAccessMetadataHandler,
  type AdminInboxService,
} from "@/server/admin/compat/handlers/inbox";
import {
  createBatchDeleteSessionsHandler,
  createBatchSetSessionsArchivedHandler,
  createDeleteSessionHandler,
  createGetSessionHandler,
  createListSessionsHandler,
  createSetSessionArchivedHandler,
  createUpdateSessionHandler,
  type AdminSessionsService,
} from "@/server/admin/compat/handlers/sessions";
import {
  createPostgresAdminInboxService,
} from "@/server/admin/views/inbox";
import {
  createPostgresAdminSessionsService,
} from "@/server/admin/views/sessions";
import {
  createCreateCronJobHandler,
  createDeleteCronJobHandler,
  createGetCronJobHandler,
  createGetCronJobHistoryHandler,
  createGetCronJobStateHandler,
  createGetHeartbeatHandler,
  createListCronDispatchTargetsHandler,
  createListCronJobsHandler,
  createReplaceCronJobHandler,
  createRunCronJobHandler,
  createRunHeartbeatHandler,
  createSetCronJobEnabledHandler,
  createUpdateHeartbeatHandler,
  type AdminSchedulesService,
} from "@/server/admin/compat/handlers/schedules";
import {
  createPostgresAdminSchedulesService,
} from "@/server/admin/views/schedules";
import {
  createDeleteMemoryHandler,
  createGetGoalHandler,
  createGetInterjectionsHandler,
  createGoalActionHandler,
  createListMemoriesHandler,
  createListReflectionsHandler,
  createListGoalsHandler,
  createReflectionActionHandler,
  createUpdateMemoryHandler,
  createUpdateInterjectionPolicyHandler,
  type AdminEvolutionService,
} from "@/server/admin/compat/handlers/evolution";
import {
  createPostgresAdminEvolutionService,
} from "@/server/admin/views/evolution";
import {
  createDownloadWorkspaceHandler,
  createGetWorkspaceFileHandler,
  createGetWorkspacePromptFilesHandler,
  createListWorkspaceFilesHandler,
  createPutWorkspaceFileHandler,
  createWatchWorkspaceHandler,
  type AdminWorkspaceService,
} from "@/server/admin/compat/handlers/workspace";
import {
  createPostgresAdminWorkspaceService,
} from "@/server/admin/workspace/service";
import {
  createCreateSkillHandler,
  createGetMcpClientHandler,
  createGetMcpPolicyHandler,
  createGetToolConfigHandler,
  createListMcpAccessPrincipalsHandler,
  createListMcpClientsHandler,
  createListMcpToolsHandler,
  createListSkillPoolHandler,
  createListSkillsHandler,
  createListSkillWorkspacesHandler,
  createListToolsHandler,
  createRefreshSkillsHandler,
  createSaveSkillHandler,
  createSetSkillEnabledHandler,
  type AdminAgentResourcesService,
} from "@/server/admin/compat/handlers/agent-resources";
import {
  createPostgresAdminAgentResourcesService,
} from "@/server/admin/views/agent-resources";
import {
  createGetActiveModelsHandler,
  createListModelsHandler,
  createPostgresAdminModelsService,
  createUpdateActiveModelsHandler,
  type AdminModelsService,
} from "@/server/admin/compat/handlers/models";
import {
  createGetAgentHealthHandler,
  createGetAgentStatsHandler,
  createGetAudioModeHandler,
  createGetBackendDebugLogsHandler,
  createGetEnvironmentHandler,
  createGetLocalWhisperStatusHandler,
  createGetTokenUsageDetailsHandler,
  createGetTokenUsageHandler,
  createGetTranscriptionProvidersHandler,
  createGetTranscriptionProviderTypeHandler,
  createGetVoiceOverviewHandler,
  type AdminOperationsService,
} from "@/server/admin/compat/handlers/operations";
import {
  createPostgresAdminOperationsService,
} from "@/server/admin/views/stats";
import {
  createGetAllowNoAuthHostsHandler,
  createGetBlockedSkillsHandler,
  createGetBuiltinSecurityRulesHandler,
  createGetFileGuardHandler,
  createGetSandboxHandler,
  createGetSecurityOverviewHandler,
  createGetSkillScannerHandler,
  createGetToolGuardHandler,
  createPostgresAdminSecurityService,
  type AdminSecurityService,
} from "@/server/admin/views/security";
import {
  createCreateBackupStreamHandler,
  createDeleteBackupsHandler,
  createExportBackupHandler,
  createGetBackupHandler,
  createImportBackupHandler,
  createListBackupsHandler,
  createRestoreBackupHandler,
  type AdminBackupsService,
} from "@/server/admin/compat/handlers/backups";
import {
  createGetPluginStatusHandler,
  createListPluginsHandler,
  createPluginCatalogHandler,
  createPluginMutationBlockedHandler,
  createPostgresAdminPluginsService,
  type AdminPluginsService,
} from "@/server/admin/compat/handlers/plugins";
import {
  createPostgresBackupRepository,
} from "@/server/admin/backups/repository";
import {
  BackupServiceError,
  createAdminBackupService,
} from "@/server/admin/backups/service";
import {
  defaultMatrixCryptoStorageRoot,
} from "@/server/channels/adapters/matrix/crypto-store";
import {
  createDisabledOnlyChannelShutdownPort,
} from "@/server/admin/personal-data";
import {
  userConnectionDisconnector,
} from "@/server/admin/user-connections";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

export const consoleUpstreamTag = "v2.0.0.post3";
export const consoleUpstreamCommit =
  "fef7e64d984f4332d0b84a343cd209bd3ea5d316";
export const adminCompatApiRevision = "2026-07-27.6";

export type CoreAdminCompatDependencies = Readonly<{
  createAuthStatusResponse: SharedAuthStatusReader;
  digitalMateVersion: string;
  upstreamTag: string;
  upstreamCommit: string;
  compatApiRevision: string;
  readAgentProfile?: AdminAgentProfileReader;
  updateAgentProfile?: AdminAgentProfileUpdater;
  readChannelConfigs?: AdminChannelConfigReader;
  updateChannelConfig?: AdminChannelConfigWriter;
  updateChannelConfigs?: AdminChannelConfigBatchWriter;
  wechatQrAuth?: WechatQrAuthService;
  resolveChannelHealth?: AdminChannelHealthResolver;
  channelNodes?: AdminChannelNodeService;
  inbox?: AdminInboxService;
  sessions?: AdminSessionsService;
  schedules?: AdminSchedulesService;
  evolution?: AdminEvolutionService;
  workspace?: AdminWorkspaceService;
  agentResources?: AdminAgentResourcesService;
  models?: AdminModelsService;
  operations?: AdminOperationsService;
  securityOverview?: AdminSecurityService;
  backups?: AdminBackupsService;
  plugins?: AdminPluginsService;
  verifyUpstreamContract?: boolean;
}>;

export function createCoreAdminCompatRouter(
  dependencies: CoreAdminCompatDependencies,
): AdminCompatRouter {
  const router = new AdminCompatRouter();
  const authStatus = createAuthStatusHandler(
    dependencies.createAuthStatusResponse,
  );
  const authVerify = createAuthVerifyHandler(
    dependencies.createAuthStatusResponse,
  );
  const root = createRootHandler(dependencies);

  router.statusGet("/auth/status", authStatus);
  router.sessionGet("/auth/verify", authVerify);
  router.get("/", root);
  router.get("/root", root);
  router.get("/version", root);
  router.get(
    "/agents",
    createListAgentsHandler(dependencies.readAgentProfile),
  );
  router.get(
    "/agents/:agentId",
    createGetAgentHandler(dependencies.readAgentProfile),
    {
      agentHeader: "required",
    },
  );
  router.put(
    "/agents/:agentId",
    createUpdateAgentHandler(dependencies.updateAgentProfile),
    { agentHeader: "required" },
  );
  router.post("/agents", createAgent, {
    contract: {
      status: "disabled",
      disabledCode: STABLE_CAPABILITY_CODES.multiAgentCreate,
    },
  });
  router.post("/agents/import", importAgent);
  router.post("/agents/:agentId/clone", cloneAgent, {
    agentHeader: "required",
  });
  router.delete("/agents/:agentId", deleteAgent, {
    agentHeader: "required",
    contract: {
      status: "disabled",
      disabledCode: STABLE_CAPABILITY_CODES.multiAgentDelete,
    },
  });
  router.patch("/agents/:agentId/toggle", toggleAgent, {
    agentHeader: "required",
  });
  router.patch("/agents/:agentId/pin", pinAgent, {
    agentHeader: "required",
  });
  router.put("/agents/order", reorderAgents, {
    agentHeader: "required",
  });

  if (
    dependencies.readChannelConfigs &&
    dependencies.updateChannelConfig &&
    dependencies.updateChannelConfigs
  ) {
    const channelRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/config/channels/types",
      listChannelTypes,
      channelRouteOptions,
    );
    router.put(
      "/config/channels",
      createUpdateChannelsHandler(
        dependencies.updateChannelConfigs,
        dependencies.resolveChannelHealth,
      ),
      channelRouteOptions,
    );
    router.get(
      "/config/channels/schemas",
      listChannelSchemas,
      channelRouteOptions,
    );
    router.get(
      "/config/channels",
      createListChannelsHandler(
        dependencies.readChannelConfigs,
        dependencies.resolveChannelHealth,
      ),
      channelRouteOptions,
    );
    router.get(
      "/config/channels/:channelType/health",
      createGetChannelHealthHandler(
        dependencies.readChannelConfigs,
        dependencies.resolveChannelHealth,
      ),
      channelRouteOptions,
    );
    router.get(
      "/config/channels/:channelType",
      createGetChannelHandler(
        dependencies.readChannelConfigs,
        dependencies.resolveChannelHealth,
      ),
      channelRouteOptions,
    );
    router.put(
      "/config/channels/:channelType",
      createUpdateChannelHandler(
        dependencies.updateChannelConfig,
        dependencies.resolveChannelHealth,
      ),
      channelRouteOptions,
    );
    if (dependencies.wechatQrAuth) {
      router.get(
        "/config/channels/wechat/qrcode",
        createWechatQrCodeHandler(
          dependencies.wechatQrAuth,
        ),
        channelRouteOptions,
      );
      router.get(
        "/config/channels/wechat/qrcode/status",
        createWechatQrCodeStatusHandler(
          dependencies.wechatQrAuth,
        ),
        channelRouteOptions,
      );
    }
  }

  if (dependencies.channelNodes) {
    const nodeRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/channel-nodes",
      createListChannelNodesHandler(dependencies.channelNodes),
      nodeRouteOptions,
    );
    router.post(
      "/channel-nodes/enrollments",
      createChannelNodeEnrollmentHandler(
        dependencies.channelNodes,
      ),
      nodeRouteOptions,
    );
    router.post(
      "/channel-nodes/:nodeId/bindings",
      createBindChannelNodeHandler(dependencies.channelNodes),
      nodeRouteOptions,
    );
    router.delete(
      "/channel-nodes/:nodeId/bindings/:connectionId",
      createUnbindChannelNodeHandler(
        dependencies.channelNodes,
      ),
      nodeRouteOptions,
    );
    router.post(
      "/channel-nodes/:nodeId/certificate/rotate",
      createRotateChannelNodeCertificateHandler(
        dependencies.channelNodes,
      ),
      nodeRouteOptions,
    );
    router.post(
      "/channel-nodes/:nodeId/revoke",
      createRevokeChannelNodeHandler(dependencies.channelNodes),
      nodeRouteOptions,
    );
  }

  if (dependencies.inbox) {
    const inboxRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/inbox",
      createListInboxHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.get(
      "/access-control",
      createListAccessControlHandler(dependencies.inbox, false),
      inboxRouteOptions,
    );
    router.get(
      "/access-control/pending/all",
      createListPendingAccessHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.get(
      "/access-control/:channel",
      createListAccessControlHandler(dependencies.inbox, true),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/whitelist/add",
      createMutateAccessRulesHandler(
        dependencies.inbox,
        "add",
        "allow",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/whitelist/remove",
      createMutateAccessRulesHandler(
        dependencies.inbox,
        "remove",
        "allow",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/blacklist/add",
      createMutateAccessRulesHandler(
        dependencies.inbox,
        "add",
        "deny",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/blacklist/remove",
      createMutateAccessRulesHandler(
        dependencies.inbox,
        "remove",
        "deny",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/remark",
      createUpdateAccessMetadataHandler(
        dependencies.inbox,
        "remark",
        false,
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/pending/approve",
      createResolveAccessHandler(
        dependencies.inbox,
        "approve",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/pending/deny",
      createResolveAccessHandler(
        dependencies.inbox,
        "deny",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/pending/dismiss",
      createResolveAccessHandler(
        dependencies.inbox,
        "dismiss",
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/pending/remark",
      createUpdateAccessMetadataHandler(
        dependencies.inbox,
        "remark",
        true,
      ),
      inboxRouteOptions,
    );
    router.post(
      "/access-control/username",
      createUpdateAccessMetadataHandler(
        dependencies.inbox,
        "username",
        false,
      ),
      inboxRouteOptions,
    );
    router.post(
      "/commands/check",
      createCheckCommandHandler(),
      inboxRouteOptions,
    );
    router.post(
      "/approval/:action",
      createApprovalCommandHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.get(
      "/console/push-messages",
      createGetPushMessagesHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.get(
      "/console/inbox/events",
      createListInboxEventsHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.post(
      "/console/inbox/read",
      createMarkInboxReadHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.delete(
      "/console/inbox/events/:eventId",
      createDeleteInboxEventHandler(dependencies.inbox),
      inboxRouteOptions,
    );
    router.get(
      "/console/inbox/traces/:runId",
      createGetInboxTraceHandler(dependencies.inbox),
      inboxRouteOptions,
    );
  }

  if (dependencies.sessions) {
    const sessionRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/chats",
      createListSessionsHandler(dependencies.sessions),
      sessionRouteOptions,
    );
    router.get(
      "/chats/:chatId",
      createGetSessionHandler(dependencies.sessions),
      sessionRouteOptions,
    );
    router.put(
      "/chats/:chatId",
      createUpdateSessionHandler(dependencies.sessions),
      sessionRouteOptions,
    );
    router.delete(
      "/chats/:chatId",
      createDeleteSessionHandler(dependencies.sessions),
      sessionRouteOptions,
    );
    router.post(
      "/chats/batch-delete",
      createBatchDeleteSessionsHandler(dependencies.sessions),
      sessionRouteOptions,
    );
    router.post(
      "/chats/:chatId/archive",
      createSetSessionArchivedHandler(
        dependencies.sessions,
        true,
      ),
      sessionRouteOptions,
    );
    router.post(
      "/chats/:chatId/unarchive",
      createSetSessionArchivedHandler(
        dependencies.sessions,
        false,
      ),
      sessionRouteOptions,
    );
    router.post(
      "/chats/actions/batch-archive",
      createBatchSetSessionsArchivedHandler(
        dependencies.sessions,
        true,
      ),
      sessionRouteOptions,
    );
    router.post(
      "/chats/actions/batch-unarchive",
      createBatchSetSessionsArchivedHandler(
        dependencies.sessions,
        false,
      ),
      sessionRouteOptions,
    );
  }

  if (dependencies.schedules) {
    const scheduleRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/cron/jobs",
      createListCronJobsHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.post(
      "/cron/jobs",
      createCreateCronJobHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.get(
      "/cron/jobs/:jobId",
      createGetCronJobHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.put(
      "/cron/jobs/:jobId",
      createReplaceCronJobHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.delete(
      "/cron/jobs/:jobId",
      createDeleteCronJobHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.post(
      "/cron/jobs/:jobId/pause",
      createSetCronJobEnabledHandler(
        dependencies.schedules,
        false,
      ),
      scheduleRouteOptions,
    );
    router.post(
      "/cron/jobs/:jobId/resume",
      createSetCronJobEnabledHandler(
        dependencies.schedules,
        true,
      ),
      scheduleRouteOptions,
    );
    router.post(
      "/cron/jobs/:jobId/run",
      createRunCronJobHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.get(
      "/cron/jobs/:jobId/state",
      createGetCronJobStateHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.get(
      "/cron/jobs/:jobId/history",
      createGetCronJobHistoryHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.get(
      "/cron/dispatch-targets",
      createListCronDispatchTargetsHandler(
        dependencies.schedules,
      ),
      scheduleRouteOptions,
    );
    router.get(
      "/config/heartbeat",
      createGetHeartbeatHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.put(
      "/config/heartbeat",
      createUpdateHeartbeatHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
    router.post(
      "/config/heartbeat/run",
      createRunHeartbeatHandler(dependencies.schedules),
      scheduleRouteOptions,
    );
  }

  if (dependencies.evolution) {
    const evolutionRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/interjections",
      createGetInterjectionsHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.put(
      "/interjections/policy",
      createUpdateInterjectionPolicyHandler(
        dependencies.evolution,
      ),
      evolutionRouteOptions,
    );
    router.get(
      "/goals",
      createListGoalsHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.get(
      "/goals/:goalId",
      createGetGoalHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.post(
      "/goals/:goalId/actions/:action",
      createGoalActionHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.get(
      "/memories",
      createListMemoriesHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.put(
      "/memories/:memoryId",
      createUpdateMemoryHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.delete(
      "/memories/:memoryId",
      createDeleteMemoryHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.get(
      "/reflections",
      createListReflectionsHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
    router.post(
      "/reflections/:reflectionId/actions/:action",
      createReflectionActionHandler(dependencies.evolution),
      evolutionRouteOptions,
    );
  }

  if (dependencies.workspace) {
    const workspaceRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/workspace/files",
      createListWorkspaceFilesHandler(
        dependencies.workspace,
      ),
      workspaceRouteOptions,
    );
    router.get(
      "/workspace/files/:fileName",
      createGetWorkspaceFileHandler(dependencies.workspace),
      workspaceRouteOptions,
    );
    router.put(
      "/workspace/files/:fileName",
      createPutWorkspaceFileHandler(dependencies.workspace),
      workspaceRouteOptions,
    );
    router.get(
      "/workspace/download",
      createDownloadWorkspaceHandler(dependencies.workspace),
      workspaceRouteOptions,
    );
    router.get(
      "/workspace/system-prompt-files",
      createGetWorkspacePromptFilesHandler(),
      workspaceRouteOptions,
    );
    router.get(
      "/workspace/watch",
      createWatchWorkspaceHandler(dependencies.workspace),
      workspaceRouteOptions,
    );
  }

  if (dependencies.agentResources) {
    const resourceRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/skills",
      createListSkillsHandler(dependencies.agentResources),
      resourceRouteOptions,
    );
    router.get(
      "/skills/workspaces",
      createListSkillWorkspacesHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/skills/pool",
      createListSkillPoolHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills/refresh",
      createRefreshSkillsHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills",
      createCreateSkillHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.put(
      "/skills/save",
      createSaveSkillHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills/pool/create",
      createCreateSkillHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.put(
      "/skills/pool/save",
      createSaveSkillHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills/pool/refresh",
      createRefreshSkillsHandler(
        dependencies.agentResources,
        true,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills/:skillName/enable",
      createSetSkillEnabledHandler(
        dependencies.agentResources,
        true,
      ),
      resourceRouteOptions,
    );
    router.post(
      "/skills/:skillName/disable",
      createSetSkillEnabledHandler(
        dependencies.agentResources,
        false,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/tools",
      createListToolsHandler(dependencies.agentResources),
      resourceRouteOptions,
    );
    router.get(
      "/tools/:toolName/config",
      createGetToolConfigHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/mcp",
      createListMcpClientsHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/mcp/access-principals",
      createListMcpAccessPrincipalsHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/mcp/tools/:clientKey",
      createListMcpToolsHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/mcp/policy/:clientKey",
      createGetMcpPolicyHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
    router.get(
      "/mcp/:clientKey",
      createGetMcpClientHandler(
        dependencies.agentResources,
      ),
      resourceRouteOptions,
    );
  }

  if (dependencies.models) {
    const modelRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/models",
      createListModelsHandler(dependencies.models),
      modelRouteOptions,
    );
    router.get(
      "/models/active",
      createGetActiveModelsHandler(dependencies.models),
      modelRouteOptions,
    );
    router.put(
      "/models/active",
      createUpdateActiveModelsHandler(
        dependencies.models,
      ),
      modelRouteOptions,
    );
  }

  if (dependencies.operations) {
    const operationsRouteOptions = {
      agentHeader: "required",
    } as const;
    const agentHealth = createGetAgentHealthHandler(
      dependencies.operations,
    );
    router.get(
      "/agent-stats",
      createGetAgentStatsHandler(dependencies.operations),
      operationsRouteOptions,
    );
    router.get(
      "/token-usage",
      createGetTokenUsageHandler(dependencies.operations),
      operationsRouteOptions,
    );
    router.get(
      "/token-usage/details",
      createGetTokenUsageDetailsHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
    router.get(
      "/envs",
      createGetEnvironmentHandler(dependencies.operations),
      operationsRouteOptions,
    );
    for (const path of [
      "/agent",
      "/agent/health",
      "/agent/admin/status",
    ]) {
      router.get(
        path,
        agentHealth,
        operationsRouteOptions,
      );
    }
    router.get(
      "/console/debug/backend-logs",
      createGetBackendDebugLogsHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
    router.get(
      "/voice/overview",
      createGetVoiceOverviewHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
    router.get(
      "/workspace/audio-mode",
      createGetAudioModeHandler(dependencies.operations),
      operationsRouteOptions,
    );
    router.get(
      "/workspace/transcription-providers",
      createGetTranscriptionProvidersHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
    router.get(
      "/workspace/transcription-provider-type",
      createGetTranscriptionProviderTypeHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
    router.get(
      "/workspace/local-whisper-status",
      createGetLocalWhisperStatusHandler(
        dependencies.operations,
      ),
      operationsRouteOptions,
    );
  }

  if (dependencies.securityOverview) {
    const securityRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/security/overview",
      createGetSecurityOverviewHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/tool-guard",
      createGetToolGuardHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/tool-guard/builtin-rules",
      createGetBuiltinSecurityRulesHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/sandbox",
      createGetSandboxHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/file-guard",
      createGetFileGuardHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/skill-scanner",
      createGetSkillScannerHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/skill-scanner/blocked-history",
      createGetBlockedSkillsHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
    router.get(
      "/config/security/allow-no-auth-hosts",
      createGetAllowNoAuthHostsHandler(
        dependencies.securityOverview,
      ),
      securityRouteOptions,
    );
  }

  if (dependencies.backups) {
    const backupRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/backups",
      createListBackupsHandler(dependencies.backups),
      backupRouteOptions,
    );
    router.get(
      "/backups/:backupId",
      createGetBackupHandler(dependencies.backups),
      backupRouteOptions,
    );
    router.post(
      "/backups/stream",
      createCreateBackupStreamHandler(dependencies.backups),
      backupRouteOptions,
    );
    router.post(
      "/backups/:backupId/restore",
      createRestoreBackupHandler(dependencies.backups),
      {
        ...backupRouteOptions,
        userDataLease: "exclusive",
      },
    );
    router.post(
      "/backups/delete",
      createDeleteBackupsHandler(dependencies.backups),
      backupRouteOptions,
    );
    router.get(
      "/backups/:backupId/export",
      createExportBackupHandler(dependencies.backups),
      backupRouteOptions,
    );
    router.post(
      "/backups/import",
      createImportBackupHandler(dependencies.backups),
      backupRouteOptions,
    );
  }

  if (dependencies.plugins) {
    const pluginRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/plugins",
      createListPluginsHandler(dependencies.plugins),
      pluginRouteOptions,
    );
    router.get(
      "/plugins/catalog",
      createPluginCatalogHandler(),
      pluginRouteOptions,
    );
    router.get(
      "/plugins/:pluginId/status",
      createGetPluginStatusHandler(dependencies.plugins),
      pluginRouteOptions,
    );
    const blockedPluginMutation =
      createPluginMutationBlockedHandler();
    const blockedPluginRouteOptions = {
      ...pluginRouteOptions,
      contract: {
        status: "disabled",
        disabledCode: STABLE_CAPABILITY_CODES.plugins,
      },
    } as const;
    router.post(
      "/plugins/install",
      blockedPluginMutation,
      blockedPluginRouteOptions,
    );
    router.post(
      "/plugins/upload",
      blockedPluginMutation,
      blockedPluginRouteOptions,
    );
    router.delete(
      "/plugins/:pluginId",
      blockedPluginMutation,
      blockedPluginRouteOptions,
    );
  }

  for (const path of ["/language", "/settings/language"]) {
    router.get(path, getLanguage);
    router.put(path, putLanguage);
  }
  for (const path of [
    "/user-timezone",
    "/config/user-timezone",
  ]) {
    router.get(path, getUserTimezone);
    router.put(path, putUserTimezone);
  }

  router.post(
    "/capabilities/p2-sandbox",
    createCapabilityDisabledHandler(
      STABLE_CAPABILITY_CODES.p2Sandbox,
    ),
  );
  router.post(
    "/capabilities/multi-agent",
    createCapabilityDisabledHandler(
      STABLE_CAPABILITY_CODES.multiAgent,
    ),
  );
  registerUpstreamContractFallbacks(router);
  if (dependencies.verifyUpstreamContract) {
    router.assertUpstreamContract(
      listUpstreamEndpointContracts(),
    );
  }
  return router;
}

export async function dispatchAdminCompatRequest(
  request: Request,
  route: { routeSegments?: readonly string[] } = {},
): Promise<Response> {
  const env = readEnv();
  const channelSecretKey =
    env.channelSecretsKey?.status === "ready"
      ? env.channelSecretsKey.key
      : null;
  const getChannelConfigService = () =>
    createAdminChannelConfigService(getPool(), channelSecretKey);
  const pool = getPool();
  const channelNodeIssuer =
    env.channelNodeEnrollmentCa?.status === "ready"
      ? createOpenSslChannelNodeCertificateIssuer({
          certificateAuthorityPath:
            env.channelNodeEnrollmentCa
              .certificateAuthorityPath,
          certificateAuthorityKeyPath:
            env.channelNodeEnrollmentCa
              .certificateAuthorityPrivateKeyPath,
        })
      : null;
  const channelNodeServerCertificateAuthority =
    env.channelNodeServerCaPath
      ? await readFile(
          env.channelNodeServerCaPath,
          "utf8",
        )
      : null;
  if (
    channelNodeServerCertificateAuthority
    && env.channelNodeEnrollmentCa?.status === "ready"
  ) {
    const enrollmentCertificateAuthority =
      await readFile(
        env.channelNodeEnrollmentCa
          .certificateAuthorityPath,
        "utf8",
      );
    const enrollmentCertificateAuthorityPrivateKey =
      await readFile(
        env.channelNodeEnrollmentCa
          .certificateAuthorityPrivateKeyPath,
        "utf8",
      );
    assertIndependentChannelNodeCertificateAuthorities(
      channelNodeServerCertificateAuthority,
      enrollmentCertificateAuthority,
      enrollmentCertificateAuthorityPrivateKey,
    );
  }
  const channelNodes = createAdminChannelNodeService(
    pool,
    {
      issueCertificate: channelNodeIssuer,
      serverCertificateAuthority:
        channelNodeServerCertificateAuthority,
      serverUrl: channelNodeServerUrl(
        env.publicBaseUrl ?? null,
        env.channelNodePort ?? 9_443,
      ),
    },
  );
  const wechatQrAuth = getDefaultWechatQrAuth({
    hmacKey: env.appSecret,
    readChannels: (scope, signal) =>
      getChannelConfigService().read(scope, signal),
    updateChannel: (input, signal) =>
      getChannelConfigService().update(input, signal),
  });
  const securityRepositories = createRepositories();
  const defaultUser = await securityRepositories.users.ensureDefault();
  const security = {
    defaultUserId: defaultUser.id,
    appSecret: env.appSecret,
    appPasswordEnabled: Boolean(env.appPassword),
    production: process.env.NODE_ENV === "production",
    trustProxyHeaders: env.trustProxyHeaders,
    loadSessionGeneration: (userId: string) =>
      securityRepositories.sessionStates.getGeneration(userId),
  } satisfies AdminSecurityOptions;
  const router = createCoreAdminCompatRouter({
    createAuthStatusResponse: (statusRequest) =>
      createAdminAuthStatusResponse(statusRequest, security),
    digitalMateVersion: packageJson.version,
    upstreamTag: consoleUpstreamTag,
    upstreamCommit: consoleUpstreamCommit,
    compatApiRevision: adminCompatApiRevision,
    readChannelConfigs: (scope, signal) =>
      getChannelConfigService().read(scope, signal),
    updateChannelConfig: (input, signal) =>
      getChannelConfigService().update(input, signal),
    updateChannelConfigs: (inputs, signal) =>
      getChannelConfigService().updateMany(inputs, signal),
    resolveChannelHealth:
      createAdminChannelHealthResolver(pool, {
        publicBaseUrl: env.publicBaseUrl ?? null,
      }),
    channelNodes,
    inbox: createPostgresAdminInboxService(pool),
    sessions: createPostgresAdminSessionsService(
      pool,
      env.attachmentStorageDir,
    ),
    schedules: createPostgresAdminSchedulesService(pool),
    evolution: createPostgresAdminEvolutionService(pool),
    workspace: createPostgresAdminWorkspaceService(pool),
    agentResources:
      createPostgresAdminAgentResourcesService(pool),
    models: createPostgresAdminModelsService(pool, {
      credentialsConfigured: Boolean(env.kieAiApiKey),
    }),
    operations: createPostgresAdminOperationsService(pool),
    securityOverview:
      createPostgresAdminSecurityService(pool),
    backups: createConfiguredBackupsService({
      env,
      pool,
      channelSecretKey,
    }),
    plugins: createPostgresAdminPluginsService(pool),
    wechatQrAuth,
    verifyUpstreamContract: true,
  });
  const runtime = {
    security,
    withUserDataLease: (userId, work) =>
      withFreshUserDataLease(userId, work, {
        signal: request.signal,
        timeoutCode: "admin_compat_request_timeout",
      }),
    withExclusiveUserDataLease: async (userId, work) => {
      const resources = createRepositories();
      const lease =
        await resources.userDataMutations
          .acquireExclusiveClearLease(userId);
      try {
        request.signal.throwIfAborted();
        return await work(resources, request.signal);
      } finally {
        await lease.release();
      }
    },
    resolveDefaultScope: async (
      userId,
      resources,
      signal,
    ) => {
      signal.throwIfAborted();
      try {
        return await resolveDefaultAgentScope(
          userId,
          resources.agents,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "default_agent_not_found"
        ) {
          throw new AdminCompatError(
            409,
            "agent_inactive",
            "active_agent_required",
          );
        }
        throw error;
      }
    },
  } satisfies AdminCompatRuntime;
  return router.dispatch(request, runtime, {
    routeSegments: route.routeSegments,
  });
}

function channelNodeServerUrl(
  publicBaseUrl: string | null,
  port: number,
): string {
  const url = new URL(
    publicBaseUrl ?? "https://localhost",
  );
  url.protocol = "wss:";
  url.port = port === 443 ? "" : String(port);
  url.pathname = "/channel-node";
  return url.toString();
}

function createConfiguredBackupsService(input: Readonly<{
  env: ReturnType<typeof readEnv>;
  pool: Pool;
  channelSecretKey: ChannelSecretsKey | null;
}>): AdminBackupsService {
  if (input.env.backupEncryptionKey?.status !== "ready") {
    return createUnavailableBackupsService(
      input.env.backupEncryptionKey?.code
        ?? "backup_encryption_key_missing",
    );
  }
  if (!input.channelSecretKey) {
    return createUnavailableBackupsService(
      input.env.channelSecretsKey?.status === "blocked"
        ? input.env.channelSecretsKey.code
        : "channel_secrets_key_missing",
    );
  }
  const repositories = createRepositories();
  const channelShutdown =
    createDisabledOnlyChannelShutdownPort(repositories);
  return createAdminBackupService({
    repository: createPostgresBackupRepository(input.pool),
    encryptionKey: input.env.backupEncryptionKey.key,
    channelSecretKeyFingerprint:
      input.channelSecretKey.backupKeyFingerprint(),
    backupStorageRoot: input.env.backupStorageDir,
    attachmentStorageRoot:
      input.env.attachmentStorageDir,
    matrixStorageRoot:
      defaultMatrixCryptoStorageRoot(),
    retentionDays: input.env.backupRetentionDays,
    stopConnections: async (scope) => {
      await channelShutdown.stopAll({
        userId: scope.userId,
      });
      return userConnectionDisconnector.disconnectUser(
        scope.userId,
      );
    },
  });
}

function createUnavailableBackupsService(
  code: string,
): AdminBackupsService {
  const blocked = async (): Promise<never> => {
    throw new BackupServiceError(code);
  };
  return {
    list: blocked,
    get: blocked,
    create: blocked,
    restore: blocked,
    delete: blocked,
    export: blocked,
    import: blocked,
  };
}

let defaultWechatQrAuth:
  WechatQrAuthService | null = null;

function getDefaultWechatQrAuth(input: Readonly<{
  hmacKey: string;
  readChannels: AdminChannelConfigReader;
  updateChannel: AdminChannelConfigWriter;
}>): WechatQrAuthService {
  defaultWechatQrAuth ??= createWechatQrAuthService(input);
  return defaultWechatQrAuth;
}

function createRootHandler(
  dependencies: CoreAdminCompatDependencies,
): AdminCompatHandler {
  return async () => ({
    name: "DigitalMate",
    version: dependencies.digitalMateVersion,
    upstream: {
      tag: dependencies.upstreamTag,
      commit: dependencies.upstreamCommit,
    },
    compat_api_revision: dependencies.compatApiRevision,
  });
}

function registerUpstreamContractFallbacks(
  router: AdminCompatRouter,
): void {
  for (const endpoint of listUpstreamEndpointContracts()) {
    if (router.hasContractRoute(endpoint.method, endpoint.path)) {
      continue;
    }
    if (
      endpoint.status === "disabled" &&
      endpoint.disabledCode
    ) {
      router.disabled(
        endpoint.method,
        endpoint.path,
        endpoint.disabledCode,
        { allowContractOverlap: true },
      );
      continue;
    }
    if (
      endpoint.status === "redirected" &&
      endpoint.redirectTo
    ) {
      router.redirected(
        endpoint.method,
        endpoint.path,
        endpoint.redirectTo,
        { allowContractOverlap: true },
      );
    }
  }
}
