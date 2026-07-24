export type RequestOriginOptions = {
  trustProxyHeaders?: boolean;
};

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function resolveRequestOrigin(
  request: Request,
  options: RequestOriginOptions = {},
): string | null {
  if (!options.trustProxyHeaders) {
    return parseAbsoluteOrigin(request.url, false);
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto === null && forwardedHost === null) {
    return parseAbsoluteOrigin(request.url, false);
  }
  if (
    !isSingleHeaderValue(forwardedProto) ||
    !isSingleHeaderValue(forwardedHost)
  ) {
    return null;
  }

  const protocol = forwardedProto.toLowerCase();
  if (protocol !== "http" && protocol !== "https") return null;
  if (!isValidForwardedAuthority(forwardedHost)) return null;

  return parseAbsoluteOrigin(`${protocol}://${forwardedHost}`, true);
}

export function hasSameRequestOrigin(
  request: Request,
  options: RequestOriginOptions = {},
): boolean {
  const originHeader = request.headers.get("origin");
  if (!isSingleHeaderValue(originHeader)) return false;
  if (originHeader.toLowerCase() === "null") return false;

  const suppliedOrigin = parseAbsoluteOrigin(originHeader, true);
  const requestOrigin = resolveRequestOrigin(request, options);
  return suppliedOrigin !== null && suppliedOrigin === requestOrigin;
}

function parseAbsoluteOrigin(
  value: string,
  requireOriginOnly: boolean,
): string | null {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f,\\]/.test(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    !HTTP_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (requireOriginOnly &&
      (parsed.pathname !== "/" || parsed.search || parsed.hash)) ||
    parsed.hostname.endsWith(".")
  ) {
    return null;
  }

  return parsed.origin;
}

function isSingleHeaderValue(
  value: string | null,
): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f,]/.test(value)
  );
}

function isValidForwardedAuthority(authority: string): boolean {
  if (authority.includes("@") || authority.includes("/") || authority.includes("\\")) {
    return false;
  }

  const portMatch = authority.match(/:(\d+)$/);
  if (portMatch) {
    const port = portMatch[1];
    if (
      port.length === 0 ||
      (port.length > 1 && port.startsWith("0")) ||
      Number(port) < 1 ||
      Number(port) > 65_535
    ) {
      return false;
    }
  }
  return true;
}
