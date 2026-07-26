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
import {
  loadIMessageRunnerConfigs,
} from "./imessage/config.js";
import {
  createIMessageDatabase,
} from "./imessage/database.js";
import {
  createIMessageTransport,
} from "./imessage/transport.js";
import {
  createIMessageRejectionLog,
} from "./imessage/rejections.js";

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
  const imessageConfigs =
    await loadIMessageRunnerConfigs({
      nodeConfigPath: configPath,
      connectionIds: config.connectionIds,
    });
  if (imessageConfigs.length === 0) {
    throw new Error(
      "channel_node_local_channel_config_required",
    );
  }
  const health = new ChannelNodeHealth();
  const outbox = new FileChannelNodeOutbox(
    path.join(
      path.dirname(configPath),
      "outbox.jsonl",
    ),
  );
  const imessageTransports = new Map<
    string,
    ReturnType<typeof createIMessageTransport>
  >();
  const startedTransports = new Set<string>();
  const client = new ChannelNodeClient({
    config,
    tls,
    health,
    outbox,
    supportedChannelTypes: ["imessage"],
    clientVersion: "0.1.0",
    onRegistered: async (frame) => {
      await reconcileChannelTransports({
        boundConnectionIds: frame.boundConnectionIds,
        transports: imessageTransports,
        startedConnectionIds: startedTransports,
      });
    },
    onBeforeInboundReplay: async (frame) => {
      const bound = new Set(frame.boundConnectionIds);
      for (const pending of await outbox.list()) {
        if (!bound.has(pending.connectionId)) continue;
        await imessageTransports
          .get(pending.connectionId)
          ?.preparePendingInbound(pending);
      }
    },
    onInboundAcknowledged: async (frame) => {
      await imessageTransports
        .get(frame.connectionId)
        ?.acknowledgeInbound(frame.externalEventId);
    },
    onSend: async (frame) => {
      const transport =
        imessageTransports.get(frame.connectionId);
      return transport
        ? transport.send(frame)
        : {
            status: "failed",
            errorCode: "channel_handler_unavailable",
          };
    },
  });
  for (const imessageConfig of imessageConfigs) {
    const rejectionLog = createIMessageRejectionLog(
      path.join(
        imessageConfig.mediaDirectory,
        "rejected.jsonl",
      ),
    );
    imessageTransports.set(
      imessageConfig.connectionId,
      createIMessageTransport({
        config: imessageConfig,
        database: createIMessageDatabase({
          dbPath: imessageConfig.dbPath,
        }),
        enqueueInbound: (draft) =>
          client.enqueueInbound(draft),
        transferAttachment: (attachment) =>
          client.transferAttachment(attachment),
        listPendingInboundEventIds: async () =>
          new Set(
            (await outbox.list())
              .filter((frame) =>
                frame.connectionId
                  === imessageConfig.connectionId
              )
              .map((frame) =>
                frame.payload.externalEventId
              ),
          ),
        onRowRejected: async (rowId, errorCode) => {
          await rejectionLog.record(rowId, errorCode);
          health.recordError(errorCode);
        },
      }),
    );
  }
  void client.connect().catch((error) => {
    health.recordError(
      error instanceof Error
        ? error.message
        : "channel_node_connect_failed",
    );
  });
  return {
    client,
    async stop() {
      await Promise.allSettled(
        [...imessageTransports.values()].map(
          (transport) => transport.stop(),
        ),
      );
      await client.stop();
    },
  };
}

export async function reconcileChannelTransports(input: Readonly<{
  boundConnectionIds: readonly string[];
  transports: ReadonlyMap<
    string,
    Readonly<{
      start(): Promise<void>;
      stop(): Promise<void>;
    }>
  >;
  startedConnectionIds: Set<string>;
}>): Promise<void> {
  const bound = new Set(input.boundConnectionIds);
  const removed = [...input.startedConnectionIds]
    .filter((connectionId) => !bound.has(connectionId));
  await Promise.all(
    removed.map(async (connectionId) => {
      await input.transports.get(connectionId)?.stop();
      input.startedConnectionIds.delete(connectionId);
    }),
  );

  const startedNow: string[] = [];
  try {
    for (const connectionId of input.boundConnectionIds) {
      const transport = input.transports.get(connectionId);
      if (
        !transport
        || input.startedConnectionIds.has(connectionId)
      ) {
        continue;
      }
      await transport.start();
      input.startedConnectionIds.add(connectionId);
      startedNow.push(connectionId);
    }
  } catch (error) {
    await Promise.allSettled(
      startedNow.map(async (connectionId) => {
        await input.transports.get(connectionId)?.stop();
        input.startedConnectionIds.delete(connectionId);
      }),
    );
    throw error;
  }
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
