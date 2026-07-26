import { execFile } from "node:child_process";
import {
  createHash,
  X509Certificate,
} from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  createChannelNodeServer,
} from "@/server/channels/gateway/node-server";
import {
  buildNodeTlsOptions,
} from "@/server/channels/gateway/tls";
import {
  ChannelNodeClient,
  FileChannelNodeOutbox,
  computeReconnectDelayMs,
  type ChannelNodeSocket,
  type ChannelNodeSocketOptions,
} from "../../../runners/channel-node/src/client";
import {
  assertRestrictedEnvironment,
  channelNodeConfigSchema,
  loadChannelNodeConfig,
} from "../../../runners/channel-node/src/config";
import type {
  RunnerInboundFrame,
  RunnerRegisteredFrame,
  RunnerSendFrame,
} from "../../../runners/channel-node/src/protocol";
import {
  TEST_NODE_CA_CERTIFICATE,
  TEST_NODE_CLIENT_CERTIFICATE,
  TEST_NODE_CLIENT_KEY,
  TEST_NODE_SERVER_CERTIFICATE,
  TEST_NODE_SERVER_KEY,
} from "../../fixtures/channels/gateway/node-tls";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";
const OTHER_CONNECTION_ID =
  "20000000-0000-4000-8000-000000000002";
const execFileAsync = promisify(execFile);

describe("channel-node restricted runner", () => {
  it("only accepts the minimum node configuration", () => {
    expect(
      Object.keys(channelNodeConfigSchema.shape).sort(),
    ).toEqual([
      "caPath",
      "certificatePath",
      "connectionIds",
      "keyPath",
      "nodeId",
      "serverUrl",
    ]);
    expect(() =>
      channelNodeConfigSchema.parse({
        ...validConfig(),
        databaseUrl: "postgres://forbidden",
      })
    ).toThrow();
    expect(() =>
      channelNodeConfigSchema.parse({
        ...validConfig(),
        serverUrl:
          "wss://user:secret@central.example/channel-node",
      })
    ).toThrow("channel_node_server_url_invalid");
  });

  it.each([
    "DATABASE_URL",
    "KIE_AI_API_KEY",
    "SEARCH_PROVIDER",
    "GITHUB_TOKEN",
    "CHANNEL_SECRETS_KEY",
    "APP_SECRET",
    "EMBEDDING_API_KEY",
  ])("rejects server privilege %s from its environment", (name) => {
    expect(() =>
      assertRestrictedEnvironment({ [name]: "configured" })
    ).toThrow(`channel_node_forbidden_environment:${name}`);
  });

  it("loads mTLS material only from private certificate and key files", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-config-"),
    );
    const configPath = path.join(directory, "node.json");
    const caPath = path.join(directory, "ca.pem");
    const certificatePath = path.join(directory, "node.pem");
    const keyPath = path.join(directory, "node.key");
    await writeFile(caPath, TEST_NODE_CA_CERTIFICATE, {
      mode: 0o644,
    });
    await writeFile(
      certificatePath,
      TEST_NODE_CLIENT_CERTIFICATE,
      { mode: 0o600 },
    );
    await writeFile(keyPath, TEST_NODE_CLIENT_KEY, {
      mode: 0o600,
    });
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfig(),
        caPath,
        certificatePath,
        keyPath,
      }),
      { mode: 0o600 },
    );

    const loaded = await loadChannelNodeConfig(configPath, {});
    expect(loaded).toMatchObject({
      config: {
        nodeId: NODE_ID,
        serverUrl: "wss://central.example/channel-node",
      },
      tls: {
        ca: Buffer.from(TEST_NODE_CA_CERTIFICATE),
        certificate: Buffer.from(
          TEST_NODE_CLIENT_CERTIFICATE,
        ),
        key: Buffer.from(TEST_NODE_CLIENT_KEY),
      },
    });

    await chmod(caPath, 0o666);
    await expect(
      loadChannelNodeConfig(configPath, {}),
    ).rejects.toThrow("channel_node_trust_file_writable");
    await chmod(caPath, 0o644);
    await chmod(keyPath, 0o640);
    await expect(
      loadChannelNodeConfig(configPath, {}),
    ).rejects.toThrow("channel_node_private_file_mode_invalid");
  });

  it("persists an append-only private outbox with checksums and atomically removes ACKed events", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-outbox-"),
    );
    const outboxPath = path.join(directory, "outbox.jsonl");
    const outbox = new FileChannelNodeOutbox(outboxPath);
    const frame7 = inboundFrame(7);
    const frame8 = inboundFrame(8);

    await outbox.append(frame7);
    await outbox.append(frame8);
    expect(await outbox.list()).toEqual([frame7, frame8]);
    expect((await stat(outboxPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(outboxPath, "utf8"))
      .toMatch(/"sha256":"[a-f0-9]{64}"/);
    await unlink(`${outboxPath}.state`);
    await outbox.append(frame8);

    await outbox.acknowledge({
      connectionId: CONNECTION_ID,
      externalEventId: frame7.payload.externalEventId,
    });
    expect(await outbox.list()).toEqual([frame8]);
    expect(await outbox.reserveSequence()).toBe(9);
  });

  it("fails closed when the outbox is full or its checksum is changed", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-outbox-limit-"),
    );
    const outboxPath = path.join(directory, "outbox.jsonl");
    const outbox = new FileChannelNodeOutbox(outboxPath, {
      maximumFrames: 1,
    });
    await outbox.append(inboundFrame(7));
    await expect(outbox.append(inboundFrame(8)))
      .rejects.toThrow("channel_node_outbox_limit_exceeded");

    const record = JSON.parse(
      (await readFile(outboxPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    record.sequence = 999;
    await writeFile(
      outboxPath,
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    await expect(outbox.list()).rejects.toThrow(
      "channel_node_outbox_sequence_mismatch",
    );
    record.sequence = 7;
    record.sha256 = "0".repeat(64);
    await writeFile(
      outboxPath,
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    await expect(outbox.list()).rejects.toThrow(
      "channel_node_outbox_checksum_invalid",
    );
  });

  it("atomically allocates and persists inbound sequences after heartbeat allocations", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-sequence-"),
    );
    const outbox = new FileChannelNodeOutbox(
      path.join(directory, "outbox.jsonl"),
    );
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "d".repeat(64),
      },
      outbox,
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
    });
    await outbox.reserveSequence();
    const first = await client.enqueueInbound(
      inboundDraft("imessage:rowid:atomic-1"),
    );
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client.enqueueInbound(
          inboundDraft(
            `imessage:rowid:atomic-${index + 2}`,
          ),
        )
      ),
    );

    expect(first.sequence).toBe(2);
    expect(
      new Set(concurrent.map((frame) => frame.sequence)).size,
    ).toBe(8);
    expect(
      (await outbox.list()).map((frame) => frame.sequence),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await client.stop();
  });

  it("reconnects with mTLS and only resends unacknowledged frames with their original sequence", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-client-"),
    );
    const outbox = new FileChannelNodeOutbox(
      path.join(directory, "outbox.jsonl"),
    );
    const sockets: FakeSocket[] = [];
    const socketOptions: ChannelNodeSocketOptions[] = [];
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint:
          "a".repeat(64),
      },
      outbox,
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      socketFactory: (_url, options) => {
        socketOptions.push(options);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstConnected = client.connect();
    sockets[0].open();
    expect(parseSent(sockets[0], 0)).toMatchObject({
      type: "register",
      nodeId: NODE_ID,
      certificateFingerprint: "a".repeat(64),
    });
    sockets[0].message(registeredFrame(1));
    await firstConnected;

    await client.sendInbound(inboundFrame(7));
    await client.sendInbound(inboundFrame(8));
    sockets[0].message({
      type: "inbound_ack",
      protocolVersion: 1,
      nodeId: NODE_ID,
      sequence: 2,
      sentAt: new Date().toISOString(),
      connectionId: CONNECTION_ID,
      externalEventId: "imessage:rowid:7",
      disposition: "accepted",
    });
    await vi.waitFor(async () => {
      expect(await outbox.list()).toEqual([inboundFrame(8)]);
    });

    sockets[0].close();
    const reconnected = client.reconnect();
    sockets[1].open();
    sockets[1].message(registeredFrame(3));
    await reconnected;

    expect(
      sockets[1].sent.map((raw) => JSON.parse(raw)),
    ).toEqual([
      expect.objectContaining({ type: "register" }),
      inboundFrame(8),
    ]);
    expect(socketOptions).toEqual([
      expect.objectContaining({
        rejectUnauthorized: true,
        perMessageDeflate: false,
      }),
      expect.objectContaining({
        rejectUnauthorized: true,
        perMessageDeflate: false,
      }),
    ]);
    await client.stop();
  });

  it("ignores a queued registration frame from a replaced socket generation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-generation-"),
    );
    const sockets: FakeSocket[] = [];
    const onRegistered = vi.fn();
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "e".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      onRegistered,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstConnection = client.connect().catch(
      (error: unknown) => error,
    );
    sockets[0].open();
    sockets[0].message(registeredFrame(1));
    const replacementConnection = client.reconnect();
    sockets[1].open();
    sockets[1].message(registeredFrame(2));

    await replacementConnection;
    expect(await firstConnection).toBeInstanceOf(Error);
    expect(onRegistered).toHaveBeenCalledTimes(1);
    expect(onRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 2 }),
    );
    await client.stop();
  });

  it("does not let a blocked old registration mutate a replacement socket", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-generation-await-"),
    );
    const sockets: FakeSocket[] = [];
    let releaseStart: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const canStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const onRegistered = vi.fn(async () => {
      markStarted?.();
      await canStart;
    });
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "f".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      onRegistered,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstConnection = client.connect().catch(
      (error: unknown) => error,
    );
    sockets[0].open();
    sockets[0].message(registeredFrame(1));
    await started;
    const replacementConnection = client.reconnect();
    sockets[1].open();
    sockets[1].message(registeredFrame(2));
    releaseStart?.();

    await replacementConnection;
    expect(await firstConnection).toBeInstanceOf(Error);
    expect(onRegistered).toHaveBeenCalledOnce();
    expect(sockets[1].closedWith).toBeNull();
    expect(client.getHealth().state).toBe("registered");
    await client.stop();
  });

  it("completes a real loopback mTLS registration with the central node server", async () => {
    const certificateFingerprint = createHash("sha256")
      .update(
        new X509Certificate(
          TEST_NODE_CLIENT_CERTIFICATE,
        ).raw,
      )
      .digest();
    let serverSequence = 0;
    let clientSequence = 0;
    const repository = {
      findByCertificateFingerprint: async (
        fingerprint: Buffer,
      ) => fingerprint.equals(certificateFingerprint)
        ? {
            id: NODE_ID,
            userId:
              "10000000-0000-4000-8000-000000000001",
            status: "disconnected" as const,
            certificateFingerprint,
          }
        : null,
      isBound: async (
        _userId: string,
        _nodeId: string,
        connectionId: string,
      ) => connectionId === CONNECTION_ID,
      listBoundConnectionIds: async () => [CONNECTION_ID],
      allocateServerSequence: async () => {
        serverSequence += 1;
        return serverSequence;
      },
      assertSequenceAvailable: async (
        _userId: string,
        _nodeId: string,
        sequence: number,
      ) => {
        if (sequence <= clientSequence) {
          throw new Error("node_sequence_replayed");
        }
      },
      replayInboundAck: async () => null,
      recordInboundAck: async (input: {
        nodeId: string;
        connectionId: string;
        clientSequence: number;
        externalEventId: string;
        disposition:
          | "accepted"
          | "duplicate"
          | "ignored"
          | "rejected";
        eventId?: string;
        sentAt: Date;
      }) => {
        clientSequence = input.clientSequence;
        serverSequence += 1;
        return {
          type: "inbound_ack" as const,
          protocolVersion: 1 as const,
          nodeId: input.nodeId,
          sequence: serverSequence,
          sentAt: input.sentAt.toISOString(),
          connectionId: input.connectionId,
          externalEventId: input.externalEventId,
          ...(input.eventId ? { eventId: input.eventId } : {}),
          disposition: input.disposition,
        };
      },
      acceptSequence: async (
        _userId: string,
        _nodeId: string,
        sequence: number,
      ) => {
        clientSequence = sequence;
      },
      recordHeartbeat: async (
        _userId: string,
        _nodeId: string,
        sequence: number,
      ) => {
        clientSequence = sequence;
      },
    };
    const server = createChannelNodeServer({
      host: "127.0.0.1",
      port: 0,
      tls: buildNodeTlsOptions({
        certificate: Buffer.from(
          TEST_NODE_SERVER_CERTIFICATE,
        ),
        privateKey: Buffer.from(TEST_NODE_SERVER_KEY),
        certificateAuthority: Buffer.from(
          TEST_NODE_CA_CERTIFICATE,
        ),
      }),
      repository,
    });
    const { port } = await server.start();
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-mtls-"),
    );
    const onRegistered = vi.fn();
    const client = new ChannelNodeClient({
      config: {
        ...validConfig(),
        serverUrl: `wss://localhost:${port}/channel-node`,
      },
      tls: {
        ca: Buffer.from(TEST_NODE_CA_CERTIFICATE),
        certificate: Buffer.from(
          TEST_NODE_CLIENT_CERTIFICATE,
        ),
        key: Buffer.from(TEST_NODE_CLIENT_KEY),
        certificateFingerprint:
          certificateFingerprint.toString("hex"),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      onRegistered,
    });
    try {
      await client.connect();
      expect(onRegistered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "registered",
          boundConnectionIds: [CONNECTION_ID],
        }),
      );
      expect(client.getHealth().state).toBe("registered");
    } finally {
      await client.stop();
      await server.stop(100);
    }
  });

  it("starts local channels only after registration and rejects sends for unbound connections", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-binding-"),
    );
    const sockets: FakeSocket[] = [];
    const onRegistered = vi.fn();
    const onSend = vi.fn();
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "b".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["sip"],
      clientVersion: "test",
      autoReconnect: false,
      onRegistered,
      onSend,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const connected = client.connect();
    sockets[0].open();
    expect(onRegistered).not.toHaveBeenCalled();
    sockets[0].message(registeredFrame(1));
    await connected;
    expect(onRegistered).toHaveBeenCalledOnce();

    sockets[0].emitCloseOnClose = false;
    sockets[0].message(sendFrame(OTHER_CONNECTION_ID));
    sockets[0].message(sendFrame(CONNECTION_ID, 3));
    await vi.waitFor(() => {
      expect(sockets[0].closedWith).toEqual({
        code: 1008,
        reason: "node_connection_not_configured",
      });
    });
    expect(onSend).not.toHaveBeenCalled();
    await client.stop();
  });

  it("replays a durable send result without repeating the platform side effect", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-delivery-"),
    );
    const sockets: FakeSocket[] = [];
    const onSend = vi.fn(async () => {
      sockets[0].close();
      return {
        status: "sent" as const,
        externalMessageId: "imessage:guid:1",
        platformSentAt: "2026-07-26T00:00:01.000Z",
        rawSummary: {},
      };
    });
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "1".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      onSend,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const firstConnection = client.connect();
    sockets[0].open();
    sockets[0].message(registeredFrame(1));
    await firstConnection;
    const delivery = {
      ...sendFrame(CONNECTION_ID, 2),
      sentAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2036-07-26T00:00:00.000Z",
    };
    sockets[0].message(delivery);
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledOnce();
      expect(client.getHealth().state).toBe("disconnected");
    });

    const replacementConnection = client.reconnect();
    sockets[1].open();
    sockets[1].message(registeredFrame(3));
    await replacementConnection;
    sockets[1].message({
      ...delivery,
      sequence: 4,
      sentAt: "2026-07-26T00:00:02.000Z",
    });
    await vi.waitFor(() => {
      expect(sockets[1].sent).toHaveLength(2);
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(parseSent(sockets[1], 1)).toMatchObject({
      type: "send_result",
      connectionId: CONNECTION_ID,
      deliveryId: delivery.deliveryId,
      status: "sent",
      externalMessageId: "imessage:guid:1",
    });
    await client.stop();
  });

  it("normalizes an invalid platform outcome before it becomes a durable receipt", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-outcome-"),
    );
    const sockets: FakeSocket[] = [];
    const onSend = vi.fn(async () => ({
      status: "sent" as const,
      externalMessageId: "imessage:guid:invalid-date",
      platformSentAt: "2026",
      rawSummary: {},
    }));
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "2".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      autoReconnect: false,
      onSend,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const connected = client.connect();
    sockets[0].open();
    sockets[0].message(registeredFrame(1));
    await connected;
    const delivery = {
      ...sendFrame(CONNECTION_ID, 2),
      expiresAt: "2036-07-26T00:00:00.000Z",
    };
    sockets[0].message(delivery);
    await vi.waitFor(() => {
      expect(sockets[0].sent).toHaveLength(2);
    });
    expect(parseSent(sockets[0], 1)).toMatchObject({
      type: "send_result",
      status: "failed",
      errorCode: "channel_send_result_invalid",
    });

    sockets[0].message({
      ...delivery,
      sequence: 3,
      sentAt: "2026-07-26T00:00:03.000Z",
    });
    await vi.waitFor(() => {
      expect(sockets[0].sent).toHaveLength(3);
    });
    expect(onSend).toHaveBeenCalledOnce();
    expect(sockets[0].closedWith).toBeNull();
    await client.stop();
  });

  it("automatically reconnects using the configured backoff", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-reconnect-"),
    );
    const sockets: FakeSocket[] = [];
    const client = new ChannelNodeClient({
      config: validConfig(),
      tls: {
        ca: Buffer.from("ca"),
        certificate: Buffer.from("certificate"),
        key: Buffer.from("key"),
        certificateFingerprint: "c".repeat(64),
      },
      outbox: new FileChannelNodeOutbox(
        path.join(directory, "outbox.jsonl"),
      ),
      supportedChannelTypes: ["imessage"],
      clientVersion: "test",
      random: () => 0.5,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      const connected = client.connect();
      sockets[0].open();
      sockets[0].message(registeredFrame(1));
      await connected;
      sockets[0].close();

      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it("uses bounded jitter for the 1/2/5/10/30/60 second reconnect schedule", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) =>
        computeReconnectDelayMs(attempt, () => 0.5)
      ),
    ).toEqual([
      1_000,
      2_000,
      5_000,
      10_000,
      30_000,
      60_000,
      60_000,
    ]);
    expect(computeReconnectDelayMs(0, () => 0)).toBe(800);
    expect(computeReconnectDelayMs(0, () => 1)).toBe(1_200);
  });

  it("only writes a private launchd plist in the requested current directory", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-launchd-"),
    );
    const logs = path.join(directory, "logs");
    const runner = path.join(directory, "dist", "index.js");
    const config = path.join(directory, "node.json");
    await Promise.all([
      mkdir(logs, { mode: 0o700 }),
      mkdir(path.dirname(runner), { mode: 0o700 }),
    ]);
    await writeFile(runner, "", { mode: 0o700 });
    await writeFile(config, "{}", { mode: 0o600 });
    const script = path.resolve(
      "runners/channel-node/scripts/install-launchd.mjs",
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        script,
        "--runner",
        runner,
        "--config",
        config,
        "--logs",
        logs,
        "--output",
        "com.digitalmate.channel-node.plist",
      ],
      { cwd: directory },
    );
    const outputPath = stdout.trim();
    const plist = await readFile(outputPath, "utf8");

    expect(stderr).toBe("");
    expect(path.dirname(outputPath)).toBe(
      await realpath(directory),
    );
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain(runner);
    expect(plist).toContain("CHANNEL_NODE_CONFIG_PATH");
    expect(plist).not.toContain("launchctl");
    expect(plist.match(/EnvironmentVariables/g)).toHaveLength(1);
  });
});

class FakeSocket
  extends EventEmitter
  implements ChannelNodeSocket {
  readonly sent: string[] = [];
  readyState = 0;
  emitCloseOnClose = true;
  closedWith: { code?: number; reason?: string } | null = null;

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    if (this.emitCloseOnClose) {
      this.emit(
        "close",
        code ?? 1000,
        Buffer.from(reason ?? ""),
      );
    }
  }

  terminate(): void {
    this.close(1006);
  }
}

function parseSent(
  socket: FakeSocket,
  index: number,
): Record<string, unknown> {
  return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

function validConfig() {
  return {
    nodeId: NODE_ID,
    serverUrl: "wss://central.example/channel-node",
    caPath: "/private/ca.pem",
    certificatePath: "/private/node.pem",
    keyPath: "/private/node.key",
    connectionIds: [CONNECTION_ID],
  };
}

function registeredFrame(
  sequence: number,
): RunnerRegisteredFrame {
  return {
    type: "registered",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: new Date().toISOString(),
    heartbeatIntervalMs: 15_000,
    boundConnectionIds: [CONNECTION_ID],
  };
}

function inboundFrame(sequence: number): RunnerInboundFrame {
  return {
    type: "inbound",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: "2026-07-26T00:00:00.000Z",
    connectionId: CONNECTION_ID,
    payload: {
      externalEventId: `imessage:rowid:${sequence}`,
      externalConversationId: "chat:1",
      externalSenderId: "+8613800000000",
      chatType: "direct",
      mentioned: false,
      text: "hello",
      thread: {},
      attachments: [],
      occurredAt: "2026-07-26T00:00:00.000Z",
      rawSummary: {},
    },
  };
}

function inboundDraft(externalEventId: string) {
  const frame = inboundFrame(1);
  return {
    connectionId: frame.connectionId,
    payload: {
      ...frame.payload,
      externalEventId,
    },
  };
}

function sendFrame(
  connectionId: string,
  sequence = 2,
): RunnerSendFrame {
  return {
    type: "send",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: new Date().toISOString(),
    connectionId,
    deliveryId: "40000000-0000-4000-8000-000000000001",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: {
      body: "hello",
      recipient: {
        externalConversationId: "chat:1",
      },
    },
  };
}
