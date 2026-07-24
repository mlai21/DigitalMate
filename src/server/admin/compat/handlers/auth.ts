import type {
  AdminCompatSessionHandler,
  AdminCompatStatusHandler,
} from "@/server/admin/compat/types";

export type SharedAuthStatusReader = (
  request: Request,
) => Promise<Response>;

export function createAuthStatusHandler(
  readStatus: SharedAuthStatusReader,
): AdminCompatStatusHandler {
  return (request) => readStatus(request);
}

export function createAuthVerifyHandler(
  readStatus: SharedAuthStatusReader,
): AdminCompatSessionHandler {
  return ({ request }) => readStatus(request);
}
