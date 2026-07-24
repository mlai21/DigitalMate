import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import type { StableCapabilityCode } from "@/server/capabilities";

export function createCapabilityDisabledHandler(
  capability: StableCapabilityCode,
): AdminCompatHandler {
  return async () => {
    throw new AdminCompatError(
      501,
      "capability_disabled",
      "capability_disabled",
      { capability },
    );
  };
}
