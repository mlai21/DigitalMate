import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";

export function createCapabilityDisabledHandler(
  capability: string,
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
