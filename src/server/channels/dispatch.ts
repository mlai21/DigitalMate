import { withUserDataFence } from "@/server/admin/user-data-lease";
import { handleChannelMessage } from "@/server/channels/handler";
import { sendChannelMessage } from "@/server/channels/outbound";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { AppEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import type {
  UserDataRequestFence,
} from "@/server/db/repositories";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";
import {
  assertAuthorizedModelRoutes,
  resolveDefaultAgentScope,
} from "@/server/agents/service";

type ChannelMessageAdmission = Readonly<{
  repositories: ReturnType<typeof createRepositories>;
  userId: string;
  fence: UserDataRequestFence;
}>;

export const CHANNEL_WEBHOOK_ADMISSION_TIMEOUT_MS = 750;

export async function scheduleChannelMessageHandling(input: {
  env: AppEnv;
  message: NormalizedChannelMessage;
  source: string;
}): Promise<void> {
  const admissionController = new AbortController();
  const admissionTimer = setTimeout(() => {
    admissionController.abort(
      new Error("channel_webhook_admission_timeout"),
    );
  }, CHANNEL_WEBHOOK_ADMISSION_TIMEOUT_MS);
  admissionTimer.unref?.();
  let admission: ChannelMessageAdmission;
  try {
    const repositories = createRepositories();
    const fence = await repositories.userDataMutations
      .tryAdmitDefaultUserRequest({
        signal: admissionController.signal,
      });
    if (fence === null) return;
    admission = {
      repositories,
      userId: fence.userId,
      fence,
    };
  } catch {
    const code = admissionController.signal.aborted
      ? "channel_webhook_admission_timeout"
      : "channel_webhook_admission_failed";
    console.error(code, {
      code,
      source: input.source,
    });
    return;
  } finally {
    clearTimeout(admissionTimer);
  }

  const timeout = setTimeout(() => {
    void processChannelMessage(input, admission).catch(() => {
      console.error("channel_webhook_handling_failed", {
        code: "channel_webhook_handling_failed",
        source: input.source,
      });
    });
  }, 0);

  if (typeof timeout === "object" && typeof timeout.unref === "function") {
    timeout.unref();
  }
}

async function processChannelMessage(
  input: { env: AppEnv; message: NormalizedChannelMessage },
  admission: ChannelMessageAdmission,
): Promise<void> {
  const { repositories } = admission;
  await withUserDataFence(
    repositories,
    admission.fence,
    async (_lease, signal) => {
      const scope = await resolveDefaultAgentScope(
        admission.userId,
        repositories.agents,
      );
      const settings = await repositories.settings.get(scope);
      await assertAuthorizedModelRoutes(
        scope,
        ["main", "light"],
        settings.modelRouting,
        repositories.agents,
      );
      const { client, model } = getLlmClient(
        "main",
        input.env,
        settings.modelRouting,
      );
      const light = getLlmClient(
        "light",
        input.env,
        settings.modelRouting,
      );

      await handleChannelMessage({
        message: input.message,
        scope,
        repositories,
        llm: client,
        model,
        lightLlm: { client: light.client, model: light.model },
        signal,
        send: (normalized, text, sendSignal) =>
          sendChannelMessage(
            input.env,
            normalized,
            text,
            sendSignal,
          ),
        skillInstaller: {
          install: (url, installSignal) =>
            installSkillsFromGitHub({
              url,
              userId: admission.userId,
              repositories,
              scanner: { llm: light.client, model: light.model },
              token: input.env.githubToken,
              signal: installSignal,
            }),
        },
      });
    },
  );
}
