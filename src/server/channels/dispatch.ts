import { handleChannelMessage } from "@/server/channels/handler";
import { sendChannelMessage } from "@/server/channels/outbound";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { AppEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";

export function scheduleChannelMessageHandling(input: {
  env: AppEnv;
  message: NormalizedChannelMessage;
  source: string;
}): void {
  const timeout = setTimeout(() => {
    void processChannelMessage(input).catch((error) => {
      console.error(`${input.source} webhook handling failed`, error);
    });
  }, 0);

  if (typeof timeout === "object" && typeof timeout.unref === "function") {
    timeout.unref();
  }
}

async function processChannelMessage(input: { env: AppEnv; message: NormalizedChannelMessage }): Promise<void> {
  const repositories = createRepositories();
  const user = await repositories.users.ensureDefault();
  const settings = await repositories.settings.get(user.id);
  const { client, model } = getLlmClient("main", input.env, settings.modelRouting);
  const light = getLlmClient("light", input.env, settings.modelRouting);

  await handleChannelMessage({
    message: input.message,
    userId: user.id,
    repositories,
    llm: client,
    model,
    lightLlm: { client: light.client, model: light.model },
    send: (normalized, text) => sendChannelMessage(input.env, normalized, text),
    skillInstaller: {
      install: (url) =>
        installSkillsFromGitHub({
          url,
          userId: user.id,
          repositories,
          scanner: { llm: light.client, model: light.model },
          token: input.env.githubToken,
        }),
    },
  });
}
