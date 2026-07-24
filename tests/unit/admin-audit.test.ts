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
