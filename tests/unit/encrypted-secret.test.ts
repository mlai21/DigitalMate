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
const CONTEXT = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
  connectionId: "10000000-0000-4000-8000-000000000021",
  fieldName: "bot_token",
} as const;

describe("encrypted channel secret", () => {
  it("uses AES-256-GCM storage sizes and decrypts the original value", () => {
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });
    const storage = encrypted.toStorageRecord();

    expect(storage.nonce).toHaveLength(12);
    expect(storage.authTag).toHaveLength(16);
    expect(storage.keyVersion).toBe(1);
    expect(storage.ciphertext.equals(Buffer.from(PLAINTEXT))).toBe(false);
    expect(decryptSecret(encrypted, KEY, CONTEXT)).toBe(PLAINTEXT);
  });

  it("uses a fresh nonce for each encryption", () => {
    const first = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });
    const second = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });

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
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });
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
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });
    const tampered = encryptedSecretFromStorage(
      tamper(encrypted.toStorageRecord()),
    );

    expectStableSecretError(
      () => decryptSecret(tampered, KEY, CONTEXT),
      "secret_authentication_failed",
      [PLAINTEXT],
    );
  });

  it("returns the same stable authentication error for a wrong key", () => {
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });

    expectStableSecretError(
      () => decryptSecret(encrypted, OTHER_KEY, CONTEXT),
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
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });

    expectStableSecretError(
      () => encryptedSecretFromStorage(mutate(encrypted.toStorageRecord())),
      "invalid_secret_encoding",
      [PLAINTEXT],
    );
  });

  it("rejects an unsupported key version without trying the configured key", () => {
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });

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
    const encrypted = state.key.encrypt(PLAINTEXT, CONTEXT);
    expect(state.key.decrypt(encrypted, CONTEXT)).toBe(PLAINTEXT);
  });

  it.each([
    ["user", { ...CONTEXT, userId: "20000000-0000-4000-8000-000000000002" }],
    ["agent", { ...CONTEXT, agentId: "10000000-0000-4000-8000-000000000012" }],
    ["connection", { ...CONTEXT, connectionId: "10000000-0000-4000-8000-000000000022" }],
    ["field", { ...CONTEXT, fieldName: "app_secret" }],
  ])("binds copied storage to its original %s context", (_label, changedContext) => {
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });
    const copied = encryptedSecretFromStorage(
      encrypted.toStorageRecord(),
    );

    expectStableSecretError(
      () => decryptSecret(copied, KEY, changedContext),
      "secret_authentication_failed",
      [
        PLAINTEXT,
        CONTEXT.userId,
        CONTEXT.agentId,
        CONTEXT.connectionId,
        CONTEXT.fieldName,
      ],
    );
  });

  it("uses an unambiguous context encoding for neighboring field names", () => {
    const firstContext = { ...CONTEXT, fieldName: "token_a" };
    const secondContext = { ...CONTEXT, fieldName: "token" };
    const encrypted = encryptSecret(PLAINTEXT, {
      key: KEY,
      keyVersion: 1,
      context: firstContext,
    });

    expectStableSecretError(
      () => decryptSecret(encrypted, KEY, secondContext),
      "secret_authentication_failed",
      [PLAINTEXT, firstContext.fieldName, secondContext.fieldName],
    );
  });

  it.each([
    ["user UUID", { ...CONTEXT, userId: "not-a-uuid" }],
    ["agent UUID", { ...CONTEXT, agentId: "not-a-uuid" }],
    ["connection UUID", { ...CONTEXT, connectionId: "not-a-uuid" }],
    ["field name", { ...CONTEXT, fieldName: "token:ambiguous" }],
  ])("rejects invalid secret context %s without echoing it", (_label, context) => {
    expectStableSecretError(
      () =>
        encryptSecret(PLAINTEXT, {
          key: KEY,
          keyVersion: 1,
          context,
        }),
      "invalid_secret_context",
      [
        PLAINTEXT,
        context.userId,
        context.agentId,
        context.connectionId,
        context.fieldName,
      ],
    );
  });

  it.each([
    ["isolated high surrogate", "\ud800"],
    ["isolated low surrogate", "\udc00"],
    ["high surrogate followed by text", "\ud800secret"],
  ])("rejects malformed UTF-16 plaintext: %s", (_label, plaintext) => {
    expectStableSecretError(
      () =>
        encryptSecret(plaintext, {
          key: KEY,
          keyVersion: 1,
          context: CONTEXT,
        }),
      "invalid_secret_plaintext",
      [plaintext],
    );
  });

  it.each([
    ["中文", "渠道密钥中文值"],
    ["emoji", "🔐🤝🏻"],
    ["combining characters", "e\u0301-a\u0308"],
  ])("round-trips well-formed Unicode plaintext: %s", (_label, plaintext) => {
    const encrypted = encryptSecret(plaintext, {
      key: KEY,
      keyVersion: 1,
      context: CONTEXT,
    });

    expect(decryptSecret(encrypted, KEY, CONTEXT)).toBe(plaintext);
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
