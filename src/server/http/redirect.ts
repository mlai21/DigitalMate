export function redirectUrl(request: Request, path: string): URL {
  const internalUrl = new URL(request.url);
  const headers = request.headers;
  const forwardedHost = firstHeaderValue(headers?.get("x-forwarded-host") ?? null);
  const host = forwardedHost || firstHeaderValue(headers?.get("host") ?? null);
  const forwardedProto = firstHeaderValue(headers?.get("x-forwarded-proto") ?? null);
  const protocol = forwardedProto || internalUrl.protocol.replace(/:$/, "");
  const origin = host ? `${protocol}://${host}` : internalUrl.origin;

  return new URL(path, origin);
}

function firstHeaderValue(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}
