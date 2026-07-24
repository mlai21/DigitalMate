const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

export function sanitizeInternalRedirect(
  value: unknown,
  fallback = "/",
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return fallback;
  }

  let decoded = value;
  let stabilized = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isSafeInternalPath(decoded)) return fallback;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (next === decoded) {
      stabilized = true;
      break;
    }
    decoded = next;
  }
  if (!stabilized || !isSafeInternalPath(decoded)) return fallback;

  const originalUrl = new URL(value, "https://digitalmate.invalid");
  if (originalUrl.origin !== "https://digitalmate.invalid") return fallback;
  return `${originalUrl.pathname}${originalUrl.search}`;
}

function isSafeInternalPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    controlCharacterPattern.test(value)
  ) {
    return false;
  }

  const pathname = value.split("?", 1)[0];
  return !pathname
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}
