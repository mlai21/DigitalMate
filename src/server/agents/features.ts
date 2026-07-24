import {
  MULTI_AGENT_MUTATION_CAPABILITIES,
  type MultiAgentMutation,
} from "@/server/capabilities";

export const AGENT_FEATURES = Object.freeze({
  multiAgent: false,
});

export type { MultiAgentMutation } from "@/server/capabilities";

export function assertMultiAgentMutationAllowed(action: MultiAgentMutation): never {
  throw Object.assign(new Error("当前版本只启用默认数字分身"), {
    status: 501,
    code: "capability_disabled",
    details: {
      capability: MULTI_AGENT_MUTATION_CAPABILITIES[action],
    },
  });
}
