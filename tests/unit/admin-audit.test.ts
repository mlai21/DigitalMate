import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createChannelConnectionAuditService } from "@/server/admin/audit";
import { createChannelSecretsKey } from "@/server/security/encrypted-secret";

const KEY_STATE = createChannelSecretsKey(
  Buffer.alloc(32, 23).toString("base64"),
);

describe("channel audit public config validation", () => {
  it.each([
    ["newline", "line-one\nline-two"],
    ["quote", 'secret-"quoted"-value'],
    ["backslash", String.raw`secret\path\value`],
  ])(
    "rejects an exact %s secret in top-level, nested object and nested array string values before connecting",
    async (_label, secret) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const configurations = [
        { endpoint: secret },
        { nested: { endpoint: secret } },
        { endpoints: ["safe", secret] },
      ];

      for (const config of configurations) {
        const connect = vi.fn(() => {
          throw new Error("pool_must_not_be_reached");
        });
        const service = createChannelConnectionAuditService(
          { connect } as unknown as Pool,
          KEY_STATE.key,
        );

        await expect(
          service.update(updateInput(secret, config)),
        ).rejects.toMatchObject({
          status: 400,
          code: "secret_in_public_config",
          message: "secret_in_public_config",
        });
        expect(connect).not.toHaveBeenCalled();
      }
    },
  );

  it("does not reject an unrelated public string containing a one-character secret", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const connect = vi.fn(() => {
      throw new Error("validation_passed");
    });
    const service = createChannelConnectionAuditService(
      { connect } as unknown as Pool,
      KEY_STATE.key,
    );

    await expect(
      service.update(updateInput("e", { endpoint: "safe" })),
    ).rejects.toThrow("validation_passed");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it.each(["\ud800", "\udc00", "\ud800secret"])(
    "rejects malformed UTF-16 secret changes before connecting",
    async (secret) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const connect = vi.fn(() => {
        throw new Error("pool_must_not_be_reached");
      });
      const service = createChannelConnectionAuditService(
        { connect } as unknown as Pool,
        KEY_STATE.key,
      );

      await expect(
        service.update(updateInput(secret, { endpoint: "safe" })),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_secret_change",
        message: "invalid_secret_change",
      });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "URL query substring",
      "query-secret-value",
      { endpoint: "https://example.test/hook?token=query-secret-value" },
      ["endpoint"],
    ],
    [
      "Bearer substring",
      "bearer-secret-value",
      { authorization: "Bearer bearer-secret-value" },
      ["authorization"],
    ],
    [
      "JSON fragment substring",
      "json-secret-value",
      { payload: '{"token":"json-secret-value"}' },
      ["payload"],
    ],
    [
      "nested object key",
      "secret_key",
      { nested: { secret_key: "safe" } },
      ["nested"],
    ],
    [
      "audit field name",
      "audit_field",
      { endpoint: "safe" },
      ["audit_field"],
    ],
    [
      "eight-byte substring",
      "12345678",
      { endpoint: "prefix-12345678-suffix" },
      ["endpoint"],
    ],
    [
      "multi-byte eight-byte substring",
      "密ab钥",
      { endpoint: "前缀密ab钥后缀" },
      ["endpoint"],
    ],
  ])(
    "rejects a new secret found as a %s before connecting",
    async (_label, secret, config, auditConfigFields) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const connect = vi.fn(() => {
        throw new Error("pool_must_not_be_reached");
      });
      const service = createChannelConnectionAuditService(
        { connect } as unknown as Pool,
        KEY_STATE.key,
      );

      await expect(
        service.update({
          ...updateInput(secret, config),
          auditConfigFields,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "secret_in_public_config",
        message: "secret_in_public_config",
      });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "seven-byte substring",
      "1234567",
      { endpoint: "prefix-1234567-suffix" },
    ],
    [
      "six-byte multi-byte substring",
      "密a钥",
      { endpoint: "前缀密a钥后缀" },
    ],
  ])(
    "allows an unrelated %s while retaining exact matching for short secrets",
    async (_label, secret, config) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const connect = vi.fn(() => {
        throw new Error("validation_passed");
      });
      const service = createChannelConnectionAuditService(
        { connect } as unknown as Pool,
        KEY_STATE.key,
      );

      await expect(
        service.update(updateInput(secret, config)),
      ).rejects.toThrow("validation_passed");
      expect(connect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["1234567", "密a钥"])(
    "still rejects an exact short secret",
    async (secret) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const connect = vi.fn(() => {
        throw new Error("pool_must_not_be_reached");
      });
      const service = createChannelConnectionAuditService(
        { connect } as unknown as Pool,
        KEY_STATE.key,
      );

      await expect(
        service.update(updateInput(secret, { endpoint: secret })),
      ).rejects.toMatchObject({
        status: 400,
        code: "secret_in_public_config",
      });
      expect(connect).not.toHaveBeenCalled();
    },
  );
});

function updateInput(
  secret: string,
  config: Record<string, unknown>,
) {
  return {
    scope: {
      userId: "10000000-0000-4000-8000-000000000001",
      agentId: "10000000-0000-4000-8000-000000000011",
    },
    connectionId: "10000000-0000-4000-8000-000000000021",
    expectedRevision: 1,
    config,
    secretFieldNames: ["bot_token"],
    secretChanges: [
      {
        fieldName: "bot_token",
        operation: "set" as const,
        value: secret,
      },
    ],
    auditConfigFields: ["endpoint"],
    confirmationSource: {
      type: "console" as const,
      requestId: "10000000-0000-4000-8000-000000000031",
    },
  };
}
