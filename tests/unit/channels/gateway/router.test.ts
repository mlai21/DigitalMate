import { once } from "node:events";
import { connect as connectNet } from "node:net";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  createPublicChannelGateway,
} from "@/agent-service/channel-gateway";
import {
  CHANNEL_GATEWAY_MAX_BODY_BYTES,
  createChannelGatewayRouter,
} from "@/server/channels/gateway/router";

const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";

describe("channel gateway router", () => {
  it("only dispatches the fixed public channel routes", async () => {
    const onVoiceIncoming = vi.fn(async () =>
      new Response("voice", { status: 200 })
    );
    const router = createChannelGatewayRouter({
      onVoiceIncoming,
    });

    expect(
      (
        await router.dispatch(
          new Request(
            `http://localhost/channel-gateway/voice/${CONNECTION_ID}/incoming`,
            { method: "POST", body: "CallSid=CA1" },
          ),
        )
      ).status,
    ).toBe(200);
    expect(onVoiceIncoming).toHaveBeenCalledOnce();
    expect(
      (
        await router.dispatch(
          new Request("http://localhost/channel-gateway/unknown"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await router.dispatch(
          new Request("http://localhost/api/admin/compat/root"),
        )
      ).status,
    ).toBe(404);
  });

  it("matches only strict upgrade paths with UUID connection IDs", () => {
    const router = createChannelGatewayRouter();

    expect(
      router.matchUpgrade(
        `/channel-gateway/onebot/${CONNECTION_ID}`,
      ),
    ).toEqual({ type: "onebot", connectionId: CONNECTION_ID });
    expect(
      router.matchUpgrade(
        `/channel-gateway/voice/${CONNECTION_ID}/relay`,
      ),
    ).toEqual({ type: "voice-relay", connectionId: CONNECTION_ID });
    expect(
      router.matchUpgrade(
        "/channel-gateway/onebot/not-a-uuid",
      ),
    ).toBeNull();
    expect(
      router.matchUpgrade(
        `/channel-gateway/onebot/${CONNECTION_ID}/extra`,
      ),
    ).toBeNull();
  });

  it("rejects request bodies larger than one MiB before handlers run", async () => {
    const onVoiceStatus = vi.fn(async () => new Response(null));
    const router = createChannelGatewayRouter({ onVoiceStatus });
    const response = await router.dispatch(
      new Request(
        `http://localhost/channel-gateway/voice/${CONNECTION_ID}/status`,
        {
          method: "POST",
          body: "x".repeat(CHANNEL_GATEWAY_MAX_BODY_BYTES + 1),
        },
      ),
    );

    expect(response.status).toBe(413);
    expect(onVoiceStatus).not.toHaveBeenCalled();
  });

  it("serves the allowlist on an isolated HTTP listener", async () => {
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
    });
    const { port } = await gateway.start();
    try {
      const unknown = await fetch(
        `http://127.0.0.1:${port}/api/admin/compat/root`,
      );
      const knownWithoutHandler = await fetch(
        `http://127.0.0.1:${port}/channel-gateway/voice/${CONNECTION_ID}/status`,
        { method: "POST", body: "CallSid=CA1" },
      );

      expect(unknown.status).toBe(404);
      expect(knownWithoutHandler.status).toBe(503);
    } finally {
      await gateway.stop();
    }
  });

  it("enforces the one MiB WebSocket frame limit without stopping HTTP", async () => {
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
      onUpgrade: async () => undefined,
    });
    const { port } = await gateway.start();
    const webSocket = new WebSocket(
      `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
      { perMessageDeflate: false },
    );
    webSocket.on("error", () => undefined);
    try {
      await once(webSocket, "open");
      webSocket.send(
        Buffer.alloc(CHANNEL_GATEWAY_MAX_BODY_BYTES + 1),
      );
      const [code] = await once(webSocket, "close") as [number];
      expect([1006, 1009]).toContain(code);

      const stillAlive = await fetch(
        `http://127.0.0.1:${port}/api/admin/compat/root`,
      );
      expect(stillAlive.status).toBe(404);
    } finally {
      webSocket.terminate();
      await gateway.stop();
    }
  });

  it("rejects a malformed upgrade target without stopping the gateway", async () => {
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
      onUpgrade: async () => undefined,
    });
    const { port } = await gateway.start();
    try {
      const response = await sendRawUpgrade(
        port,
        "GET //[ HTTP/1.1\r\n"
          + "Host: localhost\r\n"
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
      );
      expect(response).toContain("HTTP/1.1 400");

      const stillAlive = await fetch(
        `http://127.0.0.1:${port}/api/admin/compat/root`,
      );
      expect(stillAlive.status).toBe(404);
    } finally {
      await gateway.stop();
    }
  });

  it("terminates an idle WebSocket without pong and keeps a responsive peer", async () => {
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
      idleTimeoutMs: 40,
      onUpgrade: async () => undefined,
    });
    const { port } = await gateway.start();
    const idle = new WebSocket(
      `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
      { autoPong: false, perMessageDeflate: false },
    );
    idle.on("error", () => undefined);
    try {
      await once(idle, "open");
      const [code] = await once(idle, "close") as [number];
      expect(code).toBe(1006);

      const responsive = new WebSocket(
        `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
        { perMessageDeflate: false },
      );
      responsive.on("error", () => undefined);
      await once(responsive, "open");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(responsive.readyState).toBe(WebSocket.OPEN);
      responsive.terminate();
    } finally {
      idle.terminate();
      await gateway.stop();
    }
  });
});

async function sendRawUpgrade(
  port: number,
  request: string,
): Promise<string> {
  const socket = connectNet(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(socket, "connect");
  socket.end(request);
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}
