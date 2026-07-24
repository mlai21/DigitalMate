import { describe, expect, it } from "vitest";

import {
  containsSecretFingerprintExposure,
  createSecretExposureFingerprint,
} from "@/server/admin/secret-content";
import {
  createChannelSecretsKey,
} from "@/server/security/encrypted-secret";

const keyState = createChannelSecretsKey(
  Buffer.alloc(32, 29).toString("base64"),
);

describe("historical channel secret exposure fingerprints", () => {
  it("uses a key-versioned domain distinct from operation fingerprints", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const value = "historical-secret-value";
    const exposure = createSecretExposureFingerprint(
      keyState.key,
      value,
    );

    expect(exposure.keyVersion).toBe(keyState.key.keyVersion);
    expect(exposure.digest).toHaveLength(32);
    expect(exposure.digest.toString("hex")).not.toBe(
      keyState.key.fingerprint(value),
    );
    expect(JSON.stringify(exposure)).not.toContain(value);
  });

  it("matches long Unicode secrets recursively in keys and values", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const secret = "密钥-rotated-🔐";
    const fingerprints = [
      createSecretExposureFingerprint(keyState.key, secret),
    ];

    expect(containsSecretFingerprintExposure(
      { nested: [{ value: `prefix-${secret}-suffix` }] },
      fingerprints,
      keyState.key,
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      { [`prefix-${secret}-suffix`]: "safe" },
      fingerprints,
      keyState.key,
    )).toBe(true);
  });

  it("uses exact matching for short secrets and embedded matching from eight UTF-8 bytes", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const short = createSecretExposureFingerprint(
      keyState.key,
      "abc",
    );
    const long = createSecretExposureFingerprint(
      keyState.key,
      "abcdefgh",
    );

    expect(containsSecretFingerprintExposure(
      { value: "abc" },
      [short],
      keyState.key,
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      { value: "xabcx" },
      [short],
      keyState.key,
    )).toBe(false);
    expect(containsSecretFingerprintExposure(
      { value: "xabcdefghx" },
      [long],
      keyState.key,
    )).toBe(true);
  });

  it("fails closed for unsupported or malformed stored fingerprints", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const valid = createSecretExposureFingerprint(
      keyState.key,
      "historical-secret",
    );

    expect(containsSecretFingerprintExposure(
      { value: "safe" },
      [{ ...valid, keyVersion: valid.keyVersion + 1 }],
      keyState.key,
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      { value: "safe" },
      [{ ...valid, digest: Buffer.alloc(1) }],
      keyState.key,
    )).toBe(true);
  });
});
