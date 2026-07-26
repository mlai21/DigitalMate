import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createChannelNodeAttachmentStore,
} from "@/server/channels/nodes/attachment-store";
import {
  parseNodeFrame,
  type NodeAttachmentChunkFrame,
  type NodeAttachmentCommitFrame,
  type NodeAttachmentStartFrame,
} from "@/server/channels/nodes/protocol";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const NODE_ID = "30000000-0000-4000-8000-000000000001";
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";
const TRANSFER_ID = "a".repeat(64);
const SENT_AT = "2026-07-26T00:00:00.000Z";

describe("channel node attachment store", () => {
  it("assembles bounded chunks, validates content and exposes a private fetcher", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-attachments-"),
    );
    const store = createChannelNodeAttachmentStore({
      rootDirectory: root,
    });
    const bytes = Buffer.from("hello");
    const start = attachmentStart(bytes);

    await expect(store.accept(node(), start)).resolves.toBeNull();
    await expect(store.accept(
      node(),
      attachmentChunk(bytes),
    )).resolves.toBeNull();
    await expect(store.accept(
      node(),
      attachmentCommit(),
    )).resolves.toEqual({ status: "ready" });

    const descriptor = {
      externalAttachmentId: start.externalAttachmentId,
      fileName: start.fileName,
      mimeType: start.mimeType,
      sizeBytes: start.sizeBytes,
      source: {
        kind: "node_transfer",
        transferId: TRANSFER_ID,
      },
    };
    const fetcher = store.createFetcher({
      node: node(),
      connectionId: CONNECTION_ID,
      externalEventId: start.externalEventId,
    });
    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of await fetcher.download(descriptor)) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);

    await fetcher.release(descriptor);
    expect(await readdir(root, { recursive: true }))
      .not.toContain(`${TRANSFER_ID}.bin`);
  });

  it("rejects disguised content before acknowledging the transfer", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-attachments-"),
    );
    const store = createChannelNodeAttachmentStore({
      rootDirectory: root,
    });
    const bytes = Buffer.from("not a png");
    const start = {
      ...attachmentStart(bytes),
      fileName: "image.png",
      mimeType: "image/png",
    } satisfies NodeAttachmentStartFrame;

    await store.accept(node(), start);
    await store.accept(node(), attachmentChunk(bytes));
    await expect(
      store.accept(node(), attachmentCommit()),
    ).resolves.toEqual({
      status: "rejected",
      errorCode: "attachment_signature_mismatch",
    });
  });

  it("removes abandoned private transfers after the bounded retention window", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-attachments-"),
    );
    const initialStore = createChannelNodeAttachmentStore({
      rootDirectory: root,
    });
    const bytes = Buffer.from("hello");
    await initialStore.accept(node(), attachmentStart(bytes));
    await initialStore.accept(node(), attachmentChunk(bytes));
    await initialStore.accept(node(), attachmentCommit());

    const restartedStore = createChannelNodeAttachmentStore({
      rootDirectory: root,
      now: () => new Date(Date.now() + 2 * 60 * 60 * 1_000),
    });
    await expect(
      restartedStore.cleanupExpired(node()),
    ).resolves.toBe(1);
    expect(await readdir(root, { recursive: true }))
      .not.toContain(`${TRANSFER_ID}.bin`);
    expect(await readdir(root, { recursive: true }))
      .not.toContain(`${TRANSFER_ID}.json`);
  });

  it("bounds active transfer capacity and discards partial files on disconnect", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digitalmate-node-attachments-"),
    );
    const store = createChannelNodeAttachmentStore({
      rootDirectory: root,
    });
    const starts = Array.from({ length: 9 }, (_, index) =>
      parseNodeFrame({
        ...attachmentStart(Buffer.from("a")),
        transferId: index.toString(16).padStart(64, "0"),
        sequence: index + 2,
        externalAttachmentId:
          `imessage:attachment:${index}`,
      }) as NodeAttachmentStartFrame
    );
    for (const start of starts.slice(0, 8)) {
      await expect(store.accept(node(), start))
        .resolves.toBeNull();
    }
    await expect(
      store.accept(node(), starts[8]),
    ).resolves.toEqual({
      status: "rejected",
      errorCode: "node_attachment_capacity_exceeded",
    });
    await expect(store.discardNode(node())).resolves.toBe(8);
    expect(await readdir(root, { recursive: true }))
      .not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\.part$/u),
        ]),
      );
  });
});

function node() {
  return {
    id: NODE_ID,
    userId: USER_ID,
  };
}

function attachmentStart(
  bytes: Buffer,
): NodeAttachmentStartFrame {
  return parseNodeFrame({
    type: "attachment_start",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence: 2,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    transferId: TRANSFER_ID,
    externalEventId: "imessage:rowid:42",
    externalAttachmentId: "imessage:attachment:note",
    fileName: "note.txt",
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  }) as NodeAttachmentStartFrame;
}

function attachmentChunk(
  bytes: Buffer,
): NodeAttachmentChunkFrame {
  return parseNodeFrame({
    type: "attachment_chunk",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence: 3,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    transferId: TRANSFER_ID,
    chunkIndex: 0,
    dataBase64: bytes.toString("base64"),
  }) as NodeAttachmentChunkFrame;
}

function attachmentCommit(): NodeAttachmentCommitFrame {
  return parseNodeFrame({
    type: "attachment_commit",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence: 4,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    transferId: TRANSFER_ID,
    chunkCount: 1,
  }) as NodeAttachmentCommitFrame;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
