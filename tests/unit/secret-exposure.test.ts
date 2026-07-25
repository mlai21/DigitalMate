import { describe, expect, it, vi } from "vitest";

import {
  containsSecretFingerprintExposure,
  createSecretExposureFingerprint,
} from "@/server/admin/secret-content";
import {
  ChannelSecretsKey,
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

  it("charges byte-mismatched Unicode windows before slicing and hashing", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprint = createSecretExposureFingerprint(
      keyState.key,
      "🔐🔐",
    );

    expect(containsSecretFingerprintExposure(
      { value: "abcdefghijklmnopqrstuvwxyz" },
      [fingerprint],
      keyState.key,
      [],
      { maxWorkUnits: 12 },
    )).toBe(true);
  });

  it("fails closed before grouping more fingerprints than the work budget", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprints = ["alpha-key", "bravo-key", "charlie-k"]
      .map((value) =>
        createSecretExposureFingerprint(keyState.key, value)
      );

    expect(containsSecretFingerprintExposure(
      { value: "safe" },
      fingerprints,
      keyState.key,
      [],
      { maxWorkUnits: 4 },
    )).toBe(true);
  });

  it("fails closed on oversized safe export text without scanning every window", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprint = createSecretExposureFingerprint(
      keyState.key,
      "historical-secret",
    );

    expect(containsSecretFingerprintExposure(
      { value: "x".repeat(100_001) },
      [fingerprint],
      keyState.key,
    )).toBe(true);
  });

  it("precharges a long window before its first slice or HMAC", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprint = createSecretExposureFingerprint(
      keyState.key,
      "a".repeat(20_000),
    );
    const hmac = vi.spyOn(
      ChannelSecretsKey.prototype,
      "secretExposureFingerprint",
    );
    const slice = vi.spyOn(Array.prototype, "slice");
    hmac.mockClear();
    slice.mockClear();
    let result: boolean;
    let hmacCalls = -1;
    let sliceCalls = -1;
    try {
      result = containsSecretFingerprintExposure(
        "b".repeat(40_000),
        [fingerprint],
        keyState.key,
        [],
        { maxWorkUnits: 40_010 },
      );
      hmacCalls = hmac.mock.calls.length;
      sliceCalls = slice.mock.calls.length;
    } finally {
      hmac.mockRestore();
      slice.mockRestore();
    }

    expect(result!).toBe(true);
    expect(sliceCalls).toBe(0);
    expect(hmacCalls).toBe(0);
  });

  it("uses the exact bounded cost for one ASCII digest comparison", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprint = createSecretExposureFingerprint(
      keyState.key,
      "abcdefgh",
    );

    expect(containsSecretFingerprintExposure(
      "abcdefgi",
      [fingerprint],
      keyState.key,
      [],
      { maxWorkUnits: 61 },
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      "abcdefgi",
      [fingerprint],
      keyState.key,
      [],
      { maxWorkUnits: 62 },
    )).toBe(false);
  });

  it("charges surrogate pairs and multibyte windows within a sufficient budget", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const fingerprint = createSecretExposureFingerprint(
      keyState.key,
      "🔐🔐",
    );

    expect(containsSecretFingerprintExposure(
      "x🔐🔐y",
      [fingerprint],
      keyState.key,
      [],
      { maxWorkUnits: 45 },
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      "🔐🧪",
      [fingerprint],
      keyState.key,
      [],
      { maxWorkUnits: 32 },
    )).toBe(false);
  });

  it("retains short and long matching when the bounded budget is sufficient", () => {
    if (keyState.status !== "ready") throw new Error("key_not_ready");
    const short = createSecretExposureFingerprint(
      keyState.key,
      "abc",
    );
    const sameLengthOther = createSecretExposureFingerprint(
      keyState.key,
      "def",
    );
    const long = createSecretExposureFingerprint(
      keyState.key,
      "abcdefgh",
    );

    expect(containsSecretFingerprintExposure(
      { value: "def" },
      [short, sameLengthOther],
      keyState.key,
      [],
      { maxWorkUnits: 100 },
    )).toBe(true);
    expect(containsSecretFingerprintExposure(
      { value: "xabcdefghx" },
      [long],
      keyState.key,
      [],
      { maxWorkUnits: 100 },
    )).toBe(true);
  });
});
