export const STABLE_CAPABILITY_CODES = Object.freeze({
  p2Sandbox: "p2_sandbox",
  multiAgent: "multi_agent",
  multiAgentCreate: "multi_agent_create",
  multiAgentClone: "multi_agent_clone",
  multiAgentImport: "multi_agent_import",
  multiAgentDelete: "multi_agent_delete",
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
