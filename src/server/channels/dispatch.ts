import { withUserDataLease } from "@/server/admin/user-data-lease";
import { handleChannelMessage } from "@/server/channels/handler";
import { sendChannelMessage } from "@/server/channels/outbound";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { AppEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";
import {
  assertAuthorizedModelRoutes,
  resolveDefaultAgentScope,
} from "@/server/agents/service";

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
  await withUserDataLease(repositories, user.id, async (_lease, signal) => {
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const settings = await repositories.settings.get(scope);
    await assertAuthorizedModelRoutes(
      scope,
      ["main", "light"],
      settings.modelRouting,
      repositories.agents,
    );
    const { client, model } = getLlmClient("main", input.env, settings.modelRouting);
    const light = getLlmClient("light", input.env, settings.modelRouting);

    await handleChannelMessage({
      message: input.message,
      scope,
      repositories,
      llm: client,
      model,
      lightLlm: { client: light.client, model: light.model },
      signal,
      send: (normalized, text, sendSignal) =>
        sendChannelMessage(input.env, normalized, text, sendSignal),
      skillInstaller: {
        install: (url, installSignal) =>
          installSkillsFromGitHub({
            url,
            userId: user.id,
            repositories,
            scanner: { llm: light.client, model: light.model },
            token: input.env.githubToken,
            signal: installSignal,
          }),
      },
    });
  });
}
