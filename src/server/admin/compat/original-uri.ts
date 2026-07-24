import { AdminCompatError } from "@/server/admin/compat/types";

export const digitalMateOriginalUriHeader =
  "x-digitalmate-original-uri";

const MAX_ORIGINAL_URI_LENGTH = 8_192;

export function readTrustedOriginalRequestPath(
  request: Request,
  trustProxyHeaders: boolean,
): string | null {
  if (!trustProxyHeaders) return null;

  const requestTarget = request.headers.get(
    digitalMateOriginalUriHeader,
  );
  if (
    requestTarget === null ||
    requestTarget.length === 0 ||
    requestTarget.length > MAX_ORIGINAL_URI_LENGTH ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//") ||
    /[\u0000-\u0020\u007f#]/u.test(requestTarget) ||
    /,\s/u.test(requestTarget)
  ) {
    throw invalidOriginalUri();
  }

  const queryIndex = requestTarget.indexOf("?");
  const rawPath =
    queryIndex === -1
      ? requestTarget
      : requestTarget.slice(0, queryIndex);
  if (rawPath.includes(",")) {
    throw invalidOriginalUri();
  }
  return rawPath;
}

function invalidOriginalUri(): AdminCompatError {
  return new AdminCompatError(
    400,
    "invalid_request",
    "invalid_path",
  );
}
