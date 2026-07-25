import { timingSafeEqual } from "node:crypto";

import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

// Long secrets are distinctive enough to block when embedded in another
// public string; short values require an exact match to avoid false positives.
const SECRET_SUBSTRING_MIN_UTF8_BYTES = 8;
const DEFAULT_MAX_FINGERPRINT_WORK_UNITS = 100_000;

export type SecretExposureFingerprint = Readonly<{
  keyVersion: number;
  digest: Buffer;
  utf8Bytes: number;
  characterLength: number;
}>;

export function createSecretExposureFingerprint(
  key: ChannelSecretsKey,
  value: string,
): SecretExposureFingerprint {
  return {
    keyVersion: key.keyVersion,
    digest: key.secretExposureFingerprint(value),
    utf8Bytes: Buffer.byteLength(value, "utf8"),
    characterLength: Array.from(value).length,
  };
}

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

export function containsSecretFingerprintExposure(
  publicValue: unknown,
  fingerprints: readonly SecretExposureFingerprint[],
  key: ChannelSecretsKey,
  additionalPublicStrings: readonly string[] = [],
  options: Readonly<{ maxWorkUnits?: number }> = {},
): boolean {
  if (fingerprints.length === 0) return false;
  const maxWorkUnits = options.maxWorkUnits
    ?? DEFAULT_MAX_FINGERPRINT_WORK_UNITS;
  if (
    !Number.isSafeInteger(maxWorkUnits)
    || maxWorkUnits < 1
  ) {
    return true;
  }
  let remainingWorkUnits = maxWorkUnits;
  const consumeWork = (units = 1): boolean => {
    if (
      !Number.isSafeInteger(units)
      || units < 1
      || units > remainingWorkUnits
    ) {
      return false;
    }
    remainingWorkUnits -= units;
    return true;
  };
  const groups = new Map<string, SecretExposureFingerprint[]>();
  for (const fingerprint of fingerprints) {
    if (!consumeWork(2)) return true;
    if (
      fingerprint.keyVersion !== key.keyVersion
      || !Buffer.isBuffer(fingerprint.digest)
      || fingerprint.digest.length !== 32
      || !Number.isSafeInteger(fingerprint.utf8Bytes)
      || fingerprint.utf8Bytes <= 0
      || !Number.isSafeInteger(fingerprint.characterLength)
      || fingerprint.characterLength <= 0
    ) {
      return true;
    }
    const groupKey =
      `${fingerprint.characterLength}:${fingerprint.utf8Bytes}`;
    const group = groups.get(groupKey);
    if (group) group.push(fingerprint);
    else groups.set(groupKey, [fingerprint]);
  }

  const matches = (candidate: string): boolean => {
    if (!consumeWork(1 + candidate.length)) return true;
    const characters = Array.from(candidate);
    for (const group of groups.values()) {
      if (!consumeWork()) return true;
      const sample = group[0]!;
      const embeddedMatch =
        sample.utf8Bytes >= SECRET_SUBSTRING_MIN_UTF8_BYTES;
      if (!embeddedMatch) {
        if (characters.length !== sample.characterLength) continue;
        if (!consumeWork()) return true;
        if (Buffer.byteLength(candidate, "utf8") !== sample.utf8Bytes) {
          continue;
        }
        if (!consumeWork()) return true;
        const digest = key.secretExposureFingerprint(candidate);
        for (const fingerprint of group) {
          if (!consumeWork()) return true;
          if (timingSafeEqual(digest, fingerprint.digest)) return true;
        }
        continue;
      }
      if (characters.length < sample.characterLength) continue;
      const finalStart = characters.length - sample.characterLength;
      for (let start = 0; start <= finalStart; start += 1) {
        if (!consumeWork(3)) return true;
        const fragment = characters
          .slice(start, start + sample.characterLength)
          .join("");
        if (Buffer.byteLength(fragment, "utf8") !== sample.utf8Bytes) {
          continue;
        }
        if (!consumeWork()) return true;
        const digest = key.secretExposureFingerprint(fragment);
        for (const fingerprint of group) {
          if (!consumeWork()) return true;
          if (timingSafeEqual(digest, fingerprint.digest)) return true;
        }
      }
    }
    return false;
  };

  if (additionalPublicStrings.some(matches)) return true;
  const pending: unknown[] = [publicValue];
  while (pending.length > 0) {
    if (!consumeWork()) return true;
    const value = pending.pop();
    if (typeof value === "string") {
      if (matches(value)) return true;
      continue;
    }
    if (Array.isArray(value)) {
      if (
        value.length > 0
        && !consumeWork(value.length)
      ) {
        return true;
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]);
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const fieldName in value) {
      if (!Object.hasOwn(value, fieldName)) continue;
      if (!consumeWork()) return true;
      if (matches(fieldName)) return true;
      pending.push((value as Record<string, unknown>)[fieldName]);
    }
  }
  return false;
}
