import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  createChannelSecretsKey,
  decryptSecret,
  encryptSecret,
  encryptedSecretFromStorage,
} from "@/server/security/encrypted-secret";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const PLAINTEXT = "task5-super-secret-value";

describe("encrypted channel secret", () => {
  it("uses AES-256-GCM storage sizes and decrypts the original value", () => {
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
    });
    const storage = encrypted.toStorageRecord();

    expect(storage.nonce).toHaveLength(12);
    expect(storage.authTag).toHaveLength(16);
    expect(storage.keyVersion).toBe(1);
    expect(storage.ciphertext.equals(Buffer.from(PLAINTEXT))).toBe(false);
    expect(decryptSecret(encrypted, KEY)).toBe(PLAINTEXT);
  });

  it("uses a fresh nonce for each encryption", () => {
    const first = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });
    const second = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });

    expect(
      first.toStorageRecord().nonce.equals(second.toStorageRecord().nonce),
    ).toBe(false);
    expect(
      first.toStorageRecord().ciphertext.equals(
        second.toStorageRecord().ciphertext,
      ),
    ).toBe(false);
  });

  it("does not expose plaintext or encryption materials through ordinary serialization", () => {
    const encrypted = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });
    const storage = encrypted.toStorageRecord();
    const forbidden = [
      PLAINTEXT,
      storage.ciphertext.toString("base64"),
      storage.nonce.toString("base64"),
      storage.authTag.toString("base64"),
    ];
    const ordinaryRepresentations = [
      JSON.stringify(encrypted),
      String(encrypted),
      inspect(encrypted),
      `${encrypted}`,
    ];

    for (const representation of ordinaryRepresentations) {
      for (const value of forbidden) {
        expect(representation).not.toContain(value);
      }
      expect(representation).not.toMatch(/ciphertext|nonce|authTag|auth_tag/i);
    }
  });

  it.each([
    ["authentication tag", (storage: ReturnType<ReturnType<typeof encryptSecret>["toStorageRecord"]>) => ({
      ...storage,
      authTag: flipFirstByte(storage.authTag),
    })],
    ["ciphertext", (storage: ReturnType<ReturnType<typeof encryptSecret>["toStorageRecord"]>) => ({
      ...storage,
      ciphertext: flipFirstByte(storage.ciphertext),
    })],
  ])("returns one stable error for tampered %s", (_label, tamper) => {
    const encrypted = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });
    const tampered = encryptedSecretFromStorage(
      tamper(encrypted.toStorageRecord()),
    );

    expectStableSecretError(
      () => decryptSecret(tampered, KEY),
      "secret_authentication_failed",
      [PLAINTEXT],
    );
  });

  it("returns the same stable authentication error for a wrong key", () => {
    const encrypted = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });

    expectStableSecretError(
      () => decryptSecret(encrypted, OTHER_KEY),
      "secret_authentication_failed",
      [PLAINTEXT],
    );
  });

  it.each([
    {
      label: "nonce",
      mutate: (storage: ReturnType<ReturnType<typeof encryptSecret>["toStorageRecord"]>) => ({
        ...storage,
        nonce: Buffer.alloc(11),
      }),
    },
    {
      label: "authentication tag",
      mutate: (storage: ReturnType<ReturnType<typeof encryptSecret>["toStorageRecord"]>) => ({
        ...storage,
        authTag: Buffer.alloc(15),
      }),
    },
    {
      label: "ciphertext",
      mutate: (storage: ReturnType<ReturnType<typeof encryptSecret>["toStorageRecord"]>) => ({
        ...storage,
        ciphertext: Buffer.alloc(0),
      }),
    },
  ])("rejects invalid stored $label with a stable encoding error", ({ mutate }) => {
    const encrypted = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });

    expectStableSecretError(
      () => encryptedSecretFromStorage(mutate(encrypted.toStorageRecord())),
      "invalid_secret_encoding",
      [PLAINTEXT],
    );
  });

  it("rejects an unsupported key version without trying the configured key", () => {
    const encrypted = encryptSecret(PLAINTEXT, { key: KEY, keyVersion: 1 });

    expectStableSecretError(
      () =>
        encryptedSecretFromStorage({
          ...encrypted.toStorageRecord(),
          keyVersion: 2,
        }),
      "secret_key_version_unsupported",
      [PLAINTEXT],
    );
  });

  it.each([
    ["not base64", "not***base64"],
    ["non-canonical base64", `${KEY.toString("base64")}=`],
    ["31 bytes", Buffer.alloc(31).toString("base64")],
    ["33 bytes", Buffer.alloc(33).toString("base64")],
  ])("blocks an invalid CHANNEL_SECRETS_KEY: %s", (_label, encoded) => {
    const state = createChannelSecretsKey(encoded);

    expect(state).toEqual({
      status: "blocked",
      code: "channel_secrets_key_invalid",
    });
    expect(JSON.stringify(state)).not.toContain(encoded);
    expect(inspect(state)).not.toContain(encoded);
  });

  it("represents a missing key as blocked and never invents a fallback", () => {
    expect(createChannelSecretsKey(undefined)).toEqual({
      status: "blocked",
      code: "channel_secrets_key_missing",
    });
  });

  it("keeps a valid parsed key opaque while allowing encryption", () => {
    const encoded = KEY.toString("base64");
    const state = createChannelSecretsKey(encoded);

    expect(state.status).toBe("ready");
    expect(JSON.stringify(state)).not.toContain(encoded);
    expect(inspect(state)).not.toContain(encoded);
    if (state.status !== "ready") throw new Error("expected_ready_key");
    const encrypted = state.key.encrypt(PLAINTEXT);
    expect(state.key.decrypt(encrypted)).toBe(PLAINTEXT);
  });
});

function flipFirstByte(value: Buffer): Buffer {
  const copy = Buffer.from(value);
  copy[0] ^= 1;
  return copy;
}

function expectStableSecretError(
  action: () => unknown,
  code: string,
  forbidden: readonly string[],
): void {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  expect(captured).toMatchObject({ code, message: code });
  const serialized = `${String(captured)} ${inspect(captured)} ${JSON.stringify(captured)}`;
  for (const value of forbidden) {
    expect(serialized).not.toContain(value);
  }
}
