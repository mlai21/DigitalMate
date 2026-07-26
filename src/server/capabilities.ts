export const STABLE_CAPABILITY_CODES = Object.freeze({
  p2Sandbox: "p2_sandbox",
  multiAgent: "multi_agent",
  multiAgentCreate: "multi_agent_create",
  multiAgentClone: "multi_agent_clone",
  multiAgentImport: "multi_agent_import",
  multiAgentDelete: "multi_agent_delete",
  adminConsoleMappingPending: "admin_console_mapping_pending",
  acp: "acp",
  codingMode: "coding_mode",
  codingProject: "coding_project",
  workspaceGit: "workspace_git",
  workspaceUpload: "workspace_upload",
  workspaceDailyMemoryFiles: "workspace_daily_memory_files",
  workspaceSystemPromptFiles: "workspace_system_prompt_files",
  workspaceCodeFiles: "workspace_code_files",
  localModels: "local_models",
  extensionMarket: "extension_market",
  plugins: "plugins",
} as const);

export type StableCapabilityCode =
  (typeof STABLE_CAPABILITY_CODES)[keyof typeof STABLE_CAPABILITY_CODES];

export const MULTI_AGENT_MUTATION_CAPABILITIES = Object.freeze({
  create: STABLE_CAPABILITY_CODES.multiAgentCreate,
  clone: STABLE_CAPABILITY_CODES.multiAgentClone,
  import: STABLE_CAPABILITY_CODES.multiAgentImport,
  delete: STABLE_CAPABILITY_CODES.multiAgentDelete,
} as const);

export type MultiAgentMutation =
  keyof typeof MULTI_AGENT_MUTATION_CAPABILITIES;

const stableCapabilityCodeSet: ReadonlySet<string> = new Set(
  Object.values(STABLE_CAPABILITY_CODES),
);

export function isStableCapabilityCode(
  value: unknown,
): value is StableCapabilityCode {
  return (
    typeof value === "string" &&
    stableCapabilityCodeSet.has(value)
  );
}
