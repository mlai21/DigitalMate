import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];

class FakeSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  isAlive = false;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  ping() {}

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  }

  terminate() {
    this.close();
  }
}

vi.mock("ws", () => ({
  default: FakeSocket,
  WebSocket: FakeSocket,
}));

const { parseDingTalkConfig } = await import(
  "@/server/channels/adapters/dingtalk/config"
);
const { createDingTalkSdkClient } = await import(
  "@/server/channels/adapters/dingtalk/transport"
);
const { createFakeHttpClient } = await import(
  "@/server/channels/testing/fixtures"
);

const CONFIG = {
  enabled: true,
  client_id: "ding-client-id",
  client_secret: "ding-client-secret",
  message_type: "markdown",
  cron_message_type: "markdown",
  card_template_id: "",
  card_template_key: "content",
  robot_code: "robot-1",
  media_dir: null,
  card_auto_layout: false,
  at_sender_on_reply: false,
  streaming_enabled: false,
  endpoint: "",
};

function streamClient() {
  const http = createFakeHttpClient();
  http.enqueue({
    status: 200,
    body: { accessToken: "ding-token", expireIn: 7_200 },
  });
  http.enqueue({
    status: 200,
    body: {
      endpoint: "wss://wss-open-connection.dingtalk.com:443/connect",
      ticket: "ticket-1",
    },
  });
  return createDingTalkSdkClient(parseDingTalkConfig(CONFIG), { http });
}

describe("dingtalk stream readiness", () => {
  it(
    "treats an open socket as ready without a REGISTERED frame",
    async () => {
      sockets.length = 0;
      const client = streamClient();
      const errors: Error[] = [];
      const started = client.start({
        signal: new AbortController().signal,
        onEvent: async () => {},
        onError: (error) => errors.push(error),
      });

      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.open();

      await expect(started).resolves.toBeUndefined();
      expect(errors).toEqual([]);
      await client.stop();
    },
  );

  it("still reports a failed handshake as unreachable", async () => {
    sockets.length = 0;
    const client = streamClient();
    const started = client.start({
      signal: new AbortController().signal,
      onEvent: async () => {},
      onError: () => {},
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.emit("error", new Error("handshake failed"));

    await expect(started).rejects.toMatchObject({
      code: "network_unreachable",
      retryable: true,
    });
    await client.stop();
  });
});
