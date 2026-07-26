import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ChannelNodeClient,
  FileChannelNodeOutbox,
} from "./client.js";
import {
  assertRestrictedEnvironment,
  loadChannelNodeConfig,
} from "./config.js";
import { ChannelNodeHealth } from "./health.js";

export async function startChannelNode(
  environment: Readonly<
    Record<string, string | undefined>
  > = process.env,
): Promise<Readonly<{
  client: ChannelNodeClient;
  stop(): Promise<void>;
}>> {
  assertRestrictedEnvironment(environment);
  const configPath =
    environment.CHANNEL_NODE_CONFIG_PATH;
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error("channel_node_config_path_required");
  }
  const { config, tls } = await loadChannelNodeConfig(
    configPath,
    environment,
  );
  const health = new ChannelNodeHealth();
  const client = new ChannelNodeClient({
    config,
    tls,
    health,
    outbox: new FileChannelNodeOutbox(
      path.join(
        path.dirname(configPath),
        "outbox.jsonl",
      ),
    ),
    supportedChannelTypes: ["imessage", "sip"],
    clientVersion: "0.1.0",
  });
  void client.connect().catch((error) => {
    health.recordError(
      error instanceof Error
        ? error.message
        : "channel_node_connect_failed",
    );
  });
  return {
    client,
    stop: () => client.stop(),
  };
}

async function main(): Promise<void> {
  const runtime = await startChannelNode();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(
    path.resolve(process.argv[1]),
  ).href
) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
