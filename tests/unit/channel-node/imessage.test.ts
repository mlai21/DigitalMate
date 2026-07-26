import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loadIMessageRunnerConfigs,
  resolveIMessageRunnerConfig,
} from "../../../runners/channel-node/src/imessage/config";
import {
  createIMessageDatabase,
} from "../../../runners/channel-node/src/imessage/database";
import {
  pollMessages,
} from "../../../runners/channel-node/src/imessage/normalize";
import {
  assertIMessagePrerequisites,
  createIMessageTransport,
  materializeIMessageAttachments,
} from "../../../runners/channel-node/src/imessage/transport";
import {
  reconcileChannelTransports,
} from "../../../runners/channel-node/src/index";
import {
  createIMessageRejectionLog,
} from "../../../runners/channel-node/src/imessage/rejections";
import type {
  RunnerSendFrame,
} from "../../../runners/channel-node/src/protocol";
import fixtureRows from "../../fixtures/channels/imessage/messages.json";

const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";

describe("macOS iMessage channel runner", () => {
  it("only reads rows after the startup cursor and ignores own, bot and group messages", () => {
    const events = pollMessages({
      connectionId: CONNECTION_ID,
      lastRowId: 40,
      rows: fixtureRows,
      botPrefix: "[Mate] ",
      receivedAt: new Date("2026-07-26T02:01:00.000Z"),
    });

    expect(events.map((event) => event.externalEventId))
      .toEqual(["imessage:rowid:42"]);
    expect(events[0]).toMatchObject({
      externalConversationId: "chat:7",
      externalSenderId: "+8613800000000",
      chatType: "direct",
      text: "你好",
    });
  });

  it("validates and expands the separate local runner configuration", () => {
    expect(resolveIMessageRunnerConfig({
      connection_id: CONNECTION_ID,
      db_path: "~/Library/Messages/chat.db",
      poll_sec: 1,
      media_dir: null,
      max_decoded_size: 10 * 1024 * 1024,
      bot_prefix: "[Mate] ",
    }, {
      homeDirectory: "/Users/mate",
      defaultMediaDirectory: "/private/imessage-media",
    })).toEqual({
      connectionId: CONNECTION_ID,
      dbPath: "/Users/mate/Library/Messages/chat.db",
      pollMilliseconds: 1_000,
      mediaDirectory: "/private/imessage-media",
      maxDecodedSize: 10 * 1024 * 1024,
      botPrefix: "[Mate] ",
    });

    expect(() => resolveIMessageRunnerConfig({
      connection_id: CONNECTION_ID,
      db_path: "relative/chat.db",
      poll_sec: 0,
      media_dir: null,
      max_decoded_size: 0,
      bot_prefix: "",
    }, {
      homeDirectory: "/Users/mate",
      defaultMediaDirectory: "/private/imessage-media",
    })).toThrow();

    expect(() => resolveIMessageRunnerConfig({
      connection_id: CONNECTION_ID,
      db_path: "~/Library/Messages/chat.db",
      poll_sec: 1,
      media_dir: null,
      max_decoded_size: 10 * 1024 * 1024 + 1,
      bot_prefix: "",
    }, {
      homeDirectory: "/Users/mate",
      defaultMediaDirectory: "/private/imessage-media",
    })).toThrow();
  });

  it("loads only private per-connection iMessage configuration files", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-config-"),
    );
    const nodeConfigPath = path.join(directory, "node.json");
    const channelDirectory = path.join(
      directory,
      "channels",
      "imessage",
    );
    const configPath = path.join(
      channelDirectory,
      `${CONNECTION_ID}.json`,
    );
    await mkdir(channelDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(configPath, JSON.stringify({
      connection_id: CONNECTION_ID,
      db_path: "~/Library/Messages/chat.db",
      poll_sec: 1,
      media_dir: null,
      max_decoded_size: 10 * 1024 * 1024,
      bot_prefix: "[Mate] ",
    }), { mode: 0o600 });

    await expect(loadIMessageRunnerConfigs({
      nodeConfigPath,
      connectionIds: [CONNECTION_ID],
      homeDirectory: "/Users/mate",
    })).resolves.toEqual([
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        dbPath: "/Users/mate/Library/Messages/chat.db",
        mediaDirectory: path.join(
          directory,
          "media",
          "imessage",
          CONNECTION_ID,
        ),
      }),
    ]);

    await chmod(configPath, 0o644);
    await expect(loadIMessageRunnerConfigs({
      nodeConfigPath,
      connectionIds: [CONNECTION_ID],
      homeDirectory: "/Users/mate",
    })).rejects.toThrow(
      "imessage_config_private_file_mode_invalid",
    );
  });

  it("uses sqlite3 readonly JSON mode and a bound numeric rowid parameter", async () => {
    const execute = vi.fn(async (
      _file: string,
      args: readonly string[],
    ) => ({
      stdout: args.includes("SELECT IFNULL(MAX(ROWID), 0) AS rowid FROM message")
        ? '[{"rowid":40}]'
        : JSON.stringify([fixtureRows[2]]),
      stderr: "",
    }));
    const database = createIMessageDatabase({
      dbPath: "/Users/mate/Library/Messages/chat.db",
      execute,
    });

    await expect(database.readStartupCursor()).resolves.toBe(40);
    await expect(database.readAfter(40)).resolves.toHaveLength(1);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/sqlite3",
      expect.arrayContaining([
        "-readonly",
        "-json",
        "/Users/mate/Library/Messages/chat.db",
        "SELECT IFNULL(MAX(ROWID), 0) AS rowid FROM message",
      ]),
    );
    const pollArgs = execute.mock.calls[1]?.[1] ?? [];
    expect(pollArgs).toContain(".parameter set ?1 40");
    expect(pollArgs.at(-1)).toContain("WHERE m.ROWID > ?1");
    expect(() => database.readAfter(Number.NaN))
      .toThrow("imessage_cursor_invalid");
  });

  it("fails closed without macOS, Full Disk Access, sqlite3 or imsg", async () => {
    const config = resolvedConfig();
    const ready = {
      platform: "darwin" as const,
      assertExecutable: vi.fn(async () => undefined),
      assertDatabaseReadable: vi.fn(async () => undefined),
      findExecutable: vi.fn(async () => "/opt/homebrew/bin/imsg"),
    };
    await expect(
      assertIMessagePrerequisites(config, ready),
    ).resolves.toBe("/opt/homebrew/bin/imsg");

    await expect(
      assertIMessagePrerequisites(config, {
        ...ready,
        platform: "linux",
      }),
    ).rejects.toThrow("imessage_macos_required");
    await expect(
      assertIMessagePrerequisites(config, {
        ...ready,
        assertExecutable: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
      }),
    ).rejects.toThrow("imessage_sqlite3_required");
    await expect(
      assertIMessagePrerequisites(config, {
        ...ready,
        assertDatabaseReadable: vi.fn(async () => {
          throw new Error("EACCES");
        }),
      }),
    ).rejects.toThrow("imessage_full_disk_access_required");
    await expect(
      assertIMessagePrerequisites(config, {
        ...ready,
        findExecutable: vi.fn(async () => null),
      }),
    ).rejects.toThrow("imessage_imsg_required");
  });

  it("records MAX(ROWID) before polling every second and never replays history", async () => {
    let intervalMs = 0;
    let intervalTask: (() => void) | undefined;
    const enqueueInbound = vi.fn(async () => undefined);
    const database = {
      readStartupCursor: vi.fn(async () => 40),
      readAfter: vi.fn(async () => [fixtureRows[2]]),
    };
    const runtime = createIMessageTransport({
      config: resolvedConfig(),
      database,
      enqueueInbound,
      resolvePrerequisites: vi.fn(
        async () => "/opt/homebrew/bin/imsg",
      ),
      execute: vi.fn(),
      setInterval(task, milliseconds) {
        intervalTask = task;
        intervalMs = milliseconds;
        return { timer: true };
      },
      clearInterval: vi.fn(),
      now: () => new Date("2026-07-26T02:01:00.000Z"),
    });

    await runtime.start();
    expect(database.readStartupCursor).toHaveBeenCalledOnce();
    expect(database.readAfter).not.toHaveBeenCalled();
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(intervalMs).toBe(1_000);
    expect(intervalTask).toBeTypeOf("function");

    await runtime.pollOnce();
    expect(database.readAfter).toHaveBeenCalledWith(40);
    expect(enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        payload: expect.objectContaining({
          externalEventId: "imessage:rowid:42",
        }),
      }),
    );
    await runtime.stop();
  });

  it("starts newly bound transports and stops transports removed on reconnect", async () => {
    const otherConnectionId =
      "20000000-0000-4000-8000-000000000002";
    const first = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const second = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const started = new Set<string>();
    const transports = new Map([
      [CONNECTION_ID, first],
      [otherConnectionId, second],
    ]);

    await reconcileChannelTransports({
      boundConnectionIds: [CONNECTION_ID],
      transports,
      startedConnectionIds: started,
    });
    await reconcileChannelTransports({
      boundConnectionIds: [otherConnectionId],
      transports,
      startedConnectionIds: started,
    });

    expect(first.start).toHaveBeenCalledOnce();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.start).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect([...started]).toEqual([otherConnectionId]);
  });

  it("sends direct text with argv only and never exposes imsg stderr", async () => {
    const execute = vi.fn(async () => ({
      stdout: '{"guid":"A1B2-C3D4"}',
      stderr: "",
    }));
    const runtime = createIMessageTransport({
      config: resolvedConfig(),
      database: {
        readStartupCursor: async () => 0,
        readAfter: async () => [],
      },
      enqueueInbound: vi.fn(),
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
      execute,
    });
    await runtime.start();

    await expect(runtime.send(sendFrame())).resolves.toMatchObject({
      status: "sent",
      externalMessageId: "imessage:guid:A1B2-C3D4",
    });
    expect(execute).toHaveBeenCalledWith(
      "/opt/homebrew/bin/imsg",
      [
        "send",
        "--to",
        "+8613800000000",
        "--text",
        "[Mate] 收到",
      ],
    );
    await expect(
      runtime.send(sendFrame({
        externalUserId: undefined,
      })),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "imessage_group_unsupported",
    });
    await expect(
      runtime.send(sendFrame({
        chatType: "group",
        externalUserId: "+8613800000000",
      })),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "imessage_group_unsupported",
    });
    await expect(
      runtime.send({
        ...sendFrame(),
        payload: {
          ...sendFrame().payload,
          recipient: {
            externalConversationId: "chat:7",
            externalUserId: "+8613800000000",
          },
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "imessage_group_unsupported",
    });

    execute.mockRejectedValueOnce(
      new Error("secret phone +8613800000000"),
    );
    const failure = await runtime.send(sendFrame());
    expect(failure).toEqual({
      status: "failed",
      errorCode: "imessage_send_outcome_unknown",
    });
    expect(JSON.stringify(failure)).not.toContain("+8613800000000");
    await runtime.stop();
  });

  it("copies allowlisted inbound attachments into a private bounded directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-source-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const source = path.join(root, "note.txt");
    await writeFile(source, "hello", { mode: 0o600 });

    const descriptors = await materializeIMessageAttachments({
      eventId: "imessage:rowid:42",
      attachments: [{
        guid: "attachment-guid",
        path: "~/note.txt",
        fileName: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      }],
      attachmentRoot: root,
      homeDirectory: root,
      mediaDirectory: media,
      maxDecodedSize: 10,
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      externalAttachmentId:
        "imessage:attachment:attachment-guid",
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    const copied = descriptors[0]?.source.localPath;
    expect(
      copied?.startsWith(`${await realpath(media)}${path.sep}`),
    ).toBe(true);
    expect(await readFile(copied!, "utf8")).toBe("hello");
    expect((await stat(copied!)).mode & 0o777).toBe(0o600);

    await writeFile(source, "too large", { mode: 0o600 });
    await expect(materializeIMessageAttachments({
      eventId: "imessage:rowid:43",
      attachments: [{
        guid: "oversized",
        path: "~/note.txt",
        fileName: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 9,
      }],
      attachmentRoot: root,
      homeDirectory: root,
      mediaDirectory: media,
      maxDecodedSize: 4,
    })).rejects.toThrow("imessage_attachment_too_large");
    await chmod(media, 0o700);
  });

  it("uploads copied bytes to the central node and deletes them only after inbound ACK", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-transfer-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const source = path.join(root, "note.txt");
    await writeFile(source, "hello", { mode: 0o600 });
    const transferAttachment = vi.fn(async () => ({
      transferId: "a".repeat(64),
    }));
    const enqueueInbound = vi.fn(async () => undefined);
    const runtime = createIMessageTransport({
      config: {
        ...resolvedConfig(),
        mediaDirectory: media,
      },
      database: {
        readStartupCursor: async () => 40,
        readAfter: async () => [
          messageRow(42, [
            attachment(
              "note",
              source,
              "note.txt",
              "text/plain",
              5,
            ),
          ]),
        ],
      },
      enqueueInbound,
      transferAttachment,
      attachmentRoot: root,
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
    });

    await runtime.start();
    await runtime.pollOnce();

    expect(transferAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        externalEventId: "imessage:rowid:42",
        externalAttachmentId: "imessage:attachment:note",
        bytes: Buffer.from("hello"),
      }),
    );
    expect(enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          attachments: [
            expect.objectContaining({
              source: {
                kind: "node_transfer",
                transferId: "a".repeat(64),
              },
            }),
          ],
        }),
      }),
    );
    const mediaEntriesBefore = await import("node:fs/promises")
      .then(({ readdir }) => readdir(media));
    expect(mediaEntriesBefore).toHaveLength(2);
    expect(mediaEntriesBefore).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[0-9a-f-]{36}\.txt$/u),
        expect.stringMatching(
          /^\.pending-[a-f0-9]{64}\.json$/u,
        ),
      ]),
    );

    await runtime.stop();
    const restarted = createIMessageTransport({
      config: {
        ...resolvedConfig(),
        mediaDirectory: media,
      },
      database: {
        readStartupCursor: async () => 42,
        readAfter: async () => [],
      },
      enqueueInbound: vi.fn(),
      transferAttachment,
      listPendingInboundEventIds: async () =>
        new Set(["imessage:rowid:42"]),
      attachmentRoot: root,
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
    });
    await restarted.start();
    expect(await import("node:fs/promises")
      .then(({ readdir }) => readdir(media)))
      .toHaveLength(2);
    await restarted.preparePendingInbound({
      type: "inbound",
      protocolVersion: 1,
      nodeId:
        "30000000-0000-4000-8000-000000000001",
      sequence: 2,
      sentAt: "2026-07-26T00:00:00.000Z",
      connectionId: CONNECTION_ID,
      payload: {
        externalEventId: "imessage:rowid:42",
        externalConversationId: "chat:7",
        externalSenderId: "+8613800000000",
        chatType: "direct",
        mentioned: false,
        text: "message 42",
        thread: {},
        attachments: [{
          externalAttachmentId:
            "imessage:attachment:note",
          fileName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          source: {
            kind: "node_transfer",
            transferId: "a".repeat(64),
          },
        }],
        occurredAt: "2026-07-26T00:00:00.000Z",
        rawSummary: {},
      },
    });
    expect(transferAttachment).toHaveBeenCalledTimes(2);
    await restarted.acknowledgeInbound("imessage:rowid:42");
    const mediaEntriesAfter = await import("node:fs/promises")
      .then(({ readdir }) => readdir(media));
    expect(mediaEntriesAfter).toEqual([]);
    await restarted.stop();
  });

  it("enforces the fixed 10 MiB file and 20 MiB message limits", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-limits-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const oversized = path.join(root, "oversized.txt");
    await writeFile(
      oversized,
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      { mode: 0o600 },
    );
    await expect(materializeIMessageAttachments({
      eventId: "imessage:rowid:50",
      attachments: [{
        guid: "oversized",
        path: oversized,
        fileName: "oversized.txt",
        mimeType: "text/plain",
        sizeBytes: 10 * 1024 * 1024 + 1,
      }],
      attachmentRoot: root,
      mediaDirectory: media,
      maxDecodedSize: 10 * 1024 * 1024,
    })).rejects.toThrow("imessage_attachment_too_large");

    const files = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const filePath = path.join(root, `part-${index}.txt`);
        await writeFile(
          filePath,
          Buffer.alloc(7 * 1024 * 1024, 0x61),
          { mode: 0o600 },
        );
        return filePath;
      }),
    );
    await expect(materializeIMessageAttachments({
      eventId: "imessage:rowid:51",
      attachments: files.map((filePath, index) => ({
        guid: `part-${index}`,
        path: filePath,
        fileName: `part-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 7 * 1024 * 1024,
      })),
      attachmentRoot: root,
      mediaDirectory: media,
      maxDecodedSize: 10 * 1024 * 1024,
    })).rejects.toThrow(
      "imessage_attachment_message_too_large",
    );
  });

  it("advances past a rejected attachment row, cleans partial copies and continues", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-poison-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const valid = path.join(root, "valid.txt");
    const blocked = path.join(root, "blocked.exe");
    await writeFile(valid, "hello", { mode: 0o600 });
    await writeFile(blocked, "blocked", { mode: 0o600 });
    const rejected = vi.fn(async () => undefined);
    const enqueueInbound = vi.fn(async () => undefined);
    const runtime = createIMessageTransport({
      config: {
        ...resolvedConfig(),
        mediaDirectory: media,
      },
      database: {
        readStartupCursor: async () => 40,
        readAfter: async () => [
          messageRow(41, [
            attachment("valid", valid, "valid.txt", "text/plain", 5),
            attachment(
              "blocked",
              blocked,
              "blocked.exe",
              "application/octet-stream",
              7,
            ),
          ]),
          messageRow(42, []),
        ],
      },
      enqueueInbound,
      onRowRejected: rejected,
      attachmentRoot: root,
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
    });

    await runtime.start();
    await runtime.pollOnce();

    expect(rejected).toHaveBeenCalledWith(
      41,
      "imessage_attachment_type_blocked",
    );
    expect(enqueueInbound).toHaveBeenCalledOnce();
    expect(enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          externalEventId: "imessage:rowid:42",
        }),
      }),
    );
    const mediaEntries = await import("node:fs/promises")
      .then(({ readdir }) => readdir(media));
    expect(mediaEntries).toEqual([]);
    await unlink(valid);
    await runtime.stop();
  });

  it("retries a transient attachment transfer without advancing past the row", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-retry-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const source = path.join(root, "note.txt");
    await writeFile(source, "hello", { mode: 0o600 });
    const rejected = vi.fn();
    const enqueueInbound = vi.fn(async () => undefined);
    const transferAttachment = vi.fn()
      .mockRejectedValueOnce(
        new Error("channel_node_connection_closed"),
      )
      .mockResolvedValue({
        transferId: "a".repeat(64),
      });
    const runtime = createIMessageTransport({
      config: {
        ...resolvedConfig(),
        mediaDirectory: media,
      },
      database: {
        readStartupCursor: async () => 40,
        readAfter: async () => [
          messageRow(41, [
            attachment(
              "note",
              source,
              "note.txt",
              "text/plain",
              5,
            ),
          ]),
          messageRow(42, []),
        ],
      },
      enqueueInbound,
      transferAttachment,
      onRowRejected: rejected,
      attachmentRoot: root,
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
    });

    await runtime.start();
    await expect(runtime.pollOnce()).rejects.toThrow(
      "channel_node_connection_closed",
    );
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    await runtime.pollOnce();
    expect(enqueueInbound).toHaveBeenCalledTimes(2);
    expect(enqueueInbound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: expect.objectContaining({
          externalEventId: "imessage:rowid:41",
        }),
      }),
    );
    expect(enqueueInbound).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          externalEventId: "imessage:rowid:42",
        }),
      }),
    );
    await runtime.stop();
  });

  it("does not advance a poison row until its private rejection record is durable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-rejection-retry-"),
    );
    const media = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-media-"),
    );
    const blocked = path.join(root, "blocked.exe");
    await writeFile(blocked, "blocked", { mode: 0o600 });
    const enqueueInbound = vi.fn(async () => undefined);
    const rejected = vi.fn()
      .mockRejectedValueOnce(new Error("rejection_log_full"))
      .mockResolvedValue(undefined);
    const runtime = createIMessageTransport({
      config: {
        ...resolvedConfig(),
        mediaDirectory: media,
      },
      database: {
        readStartupCursor: async () => 40,
        readAfter: async () => [
          messageRow(41, [
            attachment(
              "blocked",
              blocked,
              "blocked.exe",
              "application/octet-stream",
              7,
            ),
          ]),
          messageRow(42, []),
        ],
      },
      enqueueInbound,
      onRowRejected: rejected,
      attachmentRoot: root,
      resolvePrerequisites: async () => "/opt/homebrew/bin/imsg",
    });

    await runtime.start();
    await expect(runtime.pollOnce()).rejects.toThrow(
      "rejection_log_full",
    );
    expect(enqueueInbound).not.toHaveBeenCalled();

    await runtime.pollOnce();
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(enqueueInbound).toHaveBeenCalledOnce();
    expect(enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          externalEventId: "imessage:rowid:42",
        }),
      }),
    );
    await runtime.stop();
  });

  it("keeps a private durable local rejection trail without message contents", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-imessage-rejected-"),
    );
    const filePath = path.join(directory, "rejected.jsonl");
    const log = createIMessageRejectionLog(filePath);

    await log.record(
      42,
      "imessage_attachment_type_blocked",
      new Date("2026-07-26T00:00:00.000Z"),
    );

    const content = await readFile(filePath, "utf8");
    expect(content).toContain(
      "imessage_attachment_type_blocked",
    );
    expect(content).not.toContain("message 42");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("documents Full Disk Access, private config and the direct-only boundary", async () => {
    const guide = await readFile(
      path.join(process.cwd(), "docs/channels/imessage.md"),
      "utf8",
    );
    expect(guide).toMatch(/完全磁盘访问权限/u);
    expect(guide).toContain(
      "channels/imessage/<connection_id>.json",
    );
    expect(guide).toMatch(/只支持一对一会话/u);
    expect(guide).toMatch(/不回放历史消息/u);
    expect(guide).toMatch(/Apple[\s\S]*公开/u);
  });
});

function resolvedConfig() {
  return {
    connectionId: CONNECTION_ID,
    dbPath: "/Users/mate/Library/Messages/chat.db",
    pollMilliseconds: 1_000,
    mediaDirectory: "/private/imessage-media",
    maxDecodedSize: 10 * 1024 * 1024,
    botPrefix: "[Mate] ",
  } as const;
}

function sendFrame(
  input: Readonly<{
    externalUserId?: string;
    chatType?: "direct" | "group";
  }> = { externalUserId: "+8613800000000" },
): RunnerSendFrame {
  return {
    type: "send",
    protocolVersion: 1,
    nodeId: "30000000-0000-4000-8000-000000000001",
    sequence: 7,
    sentAt: "2026-07-26T02:01:00.000Z",
    connectionId: CONNECTION_ID,
    deliveryId: "40000000-0000-4000-8000-000000000001",
    expiresAt: "2026-07-26T02:02:00.000Z",
    payload: {
      body: "收到",
      recipient: {
        externalConversationId: "chat:7",
        chatType: input.chatType ?? "direct",
        ...(input.externalUserId
          ? { externalUserId: input.externalUserId }
          : {}),
      },
    },
  };
}

function attachment(
  guid: string,
  filePath: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
) {
  return {
    guid,
    path: filePath,
    fileName,
    mimeType,
    sizeBytes,
  };
}

function messageRow(
  rowid: number,
  attachments: ReturnType<typeof attachment>[],
) {
  return {
    rowid,
    guid: `message-${rowid}`,
    text: `message ${rowid}`,
    is_from_me: 0,
    date_utc: "2026-07-26T02:01:00.000Z",
    sender: "+8613800000000",
    chat_rowid: 7,
    chat_identifier: "+8613800000000",
    display_name: "",
    participant_count: 1,
    attachments,
  };
}
