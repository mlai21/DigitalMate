// Long secrets are distinctive enough to block when embedded in another
// public string; short values require an exact match to avoid false positives.
const SECRET_SUBSTRING_MIN_UTF8_BYTES = 8;

export function containsSecretExposure(
  publicValue: unknown,
  secretValues: readonly string[],
  additionalPublicStrings: readonly string[] = [],
): boolean {
  const secrets = secretValues.map((value) => ({
    value,
    embeddedMatch:
      Buffer.byteLength(value, "utf8") >=
      SECRET_SUBSTRING_MIN_UTF8_BYTES,
  }));
  if (secrets.length === 0) return false;
  const matches = (candidate: string) =>
    secrets.some((secret) =>
      secret.embeddedMatch
        ? candidate.includes(secret.value)
        : candidate === secret.value
    );
  if (additionalPublicStrings.some(matches)) return true;

  const pending: unknown[] = [publicValue];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (matches(value)) return true;
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const [key, nested] of Object.entries(value)) {
      if (matches(key)) return true;
      pending.push(nested);
    }
  }
  return false;
}
