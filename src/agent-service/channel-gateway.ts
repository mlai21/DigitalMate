import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import {
  WebSocket,
  WebSocketServer,
} from "ws";

import type { AppEnv } from "@/server/config/env";
import { getPool } from "@/server/db/client";
import {
  CHANNEL_GATEWAY_MAX_BODY_BYTES,
  createChannelGatewayRouter,
  type ChannelGatewayUpgradeRoute,
} from "@/server/channels/gateway/router";
import {
  createChannelNodeServer,
} from "@/server/channels/gateway/node-server";
import {
  buildNodeTlsOptions,
} from "@/server/channels/gateway/tls";
import {
  oneBotGatewayHub,
} from "@/server/channels/adapters/onebot/transport";
import {
  createChannelNodeRepository,
} from "@/server/channels/nodes/repository";

type PublicUpgradeHandler = (
  route: ChannelGatewayUpgradeRoute,
  webSocket: WebSocket,
  request: IncomingMessage,
) => void | Promise<void>;

type PublicUpgradeAuthorizer = (
  route: ChannelGatewayUpgradeRoute,
  request: IncomingMessage,
) => boolean | number | Promise<boolean | number>;

export function createPublicChannelGateway(input: Readonly<{
  port: number;
  host?: string;
  authorizeUpgrade?: PublicUpgradeAuthorizer;
  onUpgrade?: PublicUpgradeHandler;
  idleTimeoutMs?: number;
}>) {
  const router = createChannelGatewayRouter();
  const idleTimeoutMs = input.idleTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new Error("channel_gateway_idle_timeout_invalid");
  }
  let accepting = true;
  const sockets = new Set<Duplex>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: CHANNEL_GATEWAY_MAX_BODY_BYTES,
    perMessageDeflate: false,
  });
  const webSockets = new Map<WebSocket, number>();
  const server = createServer((request, response) => {
    void dispatchHttp(request)
      .then(async (result) => {
        response.writeHead(
          result.status,
          Object.fromEntries(result.headers.entries()),
        );
        const body = Buffer.from(await result.arrayBuffer());
        response.end(body);
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 60_000;
  server.maxHeadersCount = 100;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      if (!accepting) {
        rejectUpgrade(socket, 503);
        return;
      }
      const pathname = new URL(
        request.url ?? "/",
        "http://channel-gateway.invalid",
      ).pathname;
      const route = router.matchUpgrade(pathname);
      if (!route) {
        rejectUpgrade(socket, 404);
        return;
      }
      if (!input.onUpgrade) {
        rejectUpgrade(socket, 503);
        return;
      }
      socket.pause();
      const authorization = input.authorizeUpgrade
        ? await input.authorizeUpgrade(route, request)
        : true;
      if (authorization !== true) {
        const status = typeof authorization === "number"
          && Number.isSafeInteger(authorization)
          && authorization >= 400
          && authorization <= 599
          ? authorization
          : 403;
        rejectUpgrade(
          socket,
          status,
        );
        return;
      }
      if (!accepting || socket.destroyed) {
        rejectUpgrade(socket, 503);
        return;
      }
      socket.resume();
      webSocketServer.handleUpgrade(
        request,
        socket,
        head,
        (webSocket) => {
          webSockets.set(webSocket, Date.now());
          webSocket.on("message", () => {
            webSockets.set(webSocket, Date.now());
          });
          webSocket.on("pong", () => {
            webSockets.set(webSocket, Date.now());
          });
          webSocket.on("error", () => {
            webSocket.terminate();
          });
          webSocket.once("close", () => {
            webSockets.delete(webSocket);
          });
          void Promise.resolve(
            input.onUpgrade!(route, webSocket, request),
          ).catch(() => {
            webSocket.close(1011, "channel_upgrade_failed");
          });
        },
      );
    } catch {
      rejectUpgrade(socket, 400);
    }
  }
  const idleTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [webSocket, lastActivity] of webSockets) {
        if (now - lastActivity > idleTimeoutMs) {
          webSocket.terminate();
        } else if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.ping();
        }
      }
    },
    Math.max(1, Math.min(15_000, Math.floor(idleTimeoutMs / 2))),
  );
  idleTimer.unref();

  async function dispatchHttp(
    incoming: IncomingMessage,
  ): Promise<Response> {
    const body = await readIncomingBody(incoming);
    if (body === null) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = incoming.method ?? "GET";
    return router.dispatch(
      new Request(
        new URL(
          incoming.url ?? "/",
          "http://channel-gateway.internal",
        ),
        {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: new Uint8Array(body).buffer }),
        },
      ),
    );
  }

  return {
    async start(): Promise<{ port: number }> {
      await listen(server, input.port, input.host ?? "0.0.0.0");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("channel_gateway_address_unavailable");
      }
      return { port: address.port };
    },

    async stop(): Promise<void> {
      accepting = false;
      clearInterval(idleTimer);
      if (!server.listening) {
        webSocketServer.close();
        return;
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      for (const webSocket of webSockets.keys()) {
        webSocket.close(1001, "channel_gateway_stopping");
      }
      for (const socket of sockets) {
        if (!webSockets.size) socket.destroy();
      }
      await closeWebSocketServer(webSocketServer, webSockets);
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function closeWebSocketServer(
  server: WebSocketServer,
  sockets: Map<WebSocket, number>,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  const timer = new Promise<void>((resolve) => {
    setTimeout(resolve, 1_000);
  });
  await Promise.race([closed, timer]);
  for (const socket of sockets.keys()) socket.terminate();
  await closed;
}

export async function startAgentChannelGateway(input: Readonly<{
  env: AppEnv;
}>): Promise<Readonly<{ stop(): Promise<void> }>> {
  const publicGateway = createPublicChannelGateway({
    port: input.env.channelGatewayPort,
    authorizeUpgrade: (route, request) =>
      oneBotGatewayHub.authorize(route, request),
    onUpgrade: (route, socket, request) =>
      oneBotGatewayHub.accept(route, socket, request),
  });
  let nodeServer:
    | ReturnType<typeof createChannelNodeServer>
    | undefined;
  let unsubscribeRevocations:
    | (() => Promise<void>)
    | undefined;
  try {
    await publicGateway.start();
    if (input.env.channelNodeTls.status === "ready") {
      const [
        certificate,
        privateKey,
        certificateAuthority,
      ] = await Promise.all([
        readFile(input.env.channelNodeTls.certificatePath),
        readFile(input.env.channelNodeTls.privateKeyPath),
        readFile(input.env.channelNodeTls.certificateAuthorityPath),
      ]);
      const repository = createChannelNodeRepository(getPool());
      nodeServer = createChannelNodeServer({
        port: input.env.channelNodePort,
        tls: buildNodeTlsOptions({
          certificate,
          privateKey,
          certificateAuthority,
        }),
        repository,
      });
      unsubscribeRevocations =
        await repository.subscribeToRevocations((nodeId) => {
          nodeServer?.revokeNode(nodeId);
        });
      await nodeServer.start();
    }
  } catch (error) {
    await nodeServer?.stop(0).catch(() => undefined);
    await unsubscribeRevocations?.().catch(() => undefined);
    await publicGateway.stop().catch(() => undefined);
    throw error;
  }

  return {
    async stop(): Promise<void> {
      let failure: unknown;
      try {
        await publicGateway.stop();
      } catch (error) {
        failure = error;
      }
      try {
        await nodeServer?.stop();
      } catch (error) {
        failure ??= error;
      }
      try {
        await unsubscribeRevocations?.();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    },
  };
}

async function readIncomingBody(
  request: IncomingMessage,
): Promise<Buffer | null> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isFinite(declaredLength)
    || declaredLength < 0
    || declaredLength > CHANNEL_GATEWAY_MAX_BODY_BYTES
  ) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += buffer.length;
    if (size > CHANNEL_GATEWAY_MAX_BODY_BYTES) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`,
    );
  }
}
