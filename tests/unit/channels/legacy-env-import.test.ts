import { describe, expect, it, vi } from "vitest";

import {
  importLegacyChannelEnvironment,
} from "@/server/channels/runtime/legacy-env-import";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("legacy channel environment import", () => {
  it("creates missing connections disabled and never returns secret values", async () => {
    const update = vi.fn(async (input) => snapshot(
      input.type,
      1,
    ));
    const result = await importLegacyChannelEnvironment({
      scope,
      env: {
        channelImportLegacyEnabled: false,
        telegramBotToken: "telegram-token",
        telegramWebhookSecret: "telegram-webhook",
        slackBotToken: "slack-token",
        slackSigningSecret: "slack-signing",
        feishuAppId: "feishu-app",
        feishuAppSecret: "feishu-secret",
        feishuVerificationToken: "feishu-verification",
        dingTalkRobotCode: "ding-robot",
      },
      service: {
        read: vi.fn(async () => snapshots()),
        update,
      },
    });

    expect(update).toHaveBeenCalledTimes(4);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "telegram",
        enabled: false,
        expectedRevision: 0,
        confirmationSource: "legacy_env_import",
        secretChanges: expect.arrayContaining([
          {
            fieldName: "bot_token",
            operation: "set",
            value: "telegram-token",
          },
          {
            fieldName: "webhook_secret",
            operation: "set",
            value: "telegram-webhook",
          },
        ]),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "slack",
        enabled: false,
        secretChanges: expect.arrayContaining([
          {
            fieldName: "bot_token",
            operation: "set",
            value: "slack-token",
          },
          {
            fieldName: "signing_secret",
            operation: "set",
            value: "slack-signing",
          },
        ]),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "feishu",
        config: expect.objectContaining({
          app_id: "feishu-app",
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dingtalk",
        config: expect.objectContaining({
          robot_code: "ding-robot",
        }),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("telegram-token");
    expect(serialized).not.toContain("slack-signing");
    expect(serialized).not.toContain("feishu-secret");
    expect(result).toEqual({
      imported: [
        {
          type: "telegram",
          enabled: false,
          fieldsPresent: {
            bot_token: true,
            webhook_secret: true,
          },
        },
        {
          type: "slack",
          enabled: false,
          fieldsPresent: {
            bot_token: true,
            signing_secret: true,
          },
        },
        {
          type: "feishu",
          enabled: false,
          fieldsPresent: {
            app_id: true,
            app_secret: true,
            verification_token: true,
          },
        },
        {
          type: "dingtalk",
          enabled: false,
          fieldsPresent: {
            robot_code: true,
          },
        },
      ],
      skippedExisting: [],
    });
  });

  it("enables imports only with the explicit opt-in and skips existing types", async () => {
    const existing = snapshots();
    existing.telegram = snapshot("telegram", 2);
    const update = vi.fn(async (input) => snapshot(
      input.type,
      1,
    ));

    const result = await importLegacyChannelEnvironment({
      scope,
      env: {
        channelImportLegacyEnabled: true,
        telegramBotToken: "existing",
        slackBotToken: "new",
      },
      service: {
        read: vi.fn(async () => existing),
        update,
      },
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "slack",
        enabled: true,
      }),
    );
    expect(result.skippedExisting).toEqual(["telegram"]);
  });
});

function snapshots(): Record<string, ReturnType<typeof snapshot>> {
  return {
    telegram: snapshot("telegram", 0),
    slack: snapshot("slack", 0),
    feishu: snapshot("feishu", 0),
    dingtalk: snapshot("dingtalk", 0),
  };
}

function snapshot(type: string, revision: number) {
  return {
    type,
    enabled: false,
    revision,
    config: {},
    secrets: {},
    health: {
      status: "disabled",
      detail: {},
    },
  };
}
