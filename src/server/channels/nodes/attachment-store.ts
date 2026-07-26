import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  validateAttachmentFile,
  validateAttachmentMetadata,
} from "@/server/attachments/validation";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";
import type {
  InboundAttachmentFetcher,
  InboundAttachmentMetadata,
} from "@/server/channels/runtime/attachment-ingress";

import type {
  NodeAttachmentChunkFrame,
  NodeAttachmentCommitFrame,
  NodeAttachmentStartFrame,
} from "./protocol";

type NodeIdentity = Readonly<{
  id: string;
  userId: string;
}>;

type AttachmentTransferFrame =
  | NodeAttachmentStartFrame
  | NodeAttachmentChunkFrame
  | NodeAttachmentCommitFrame;

type ActiveTransfer = Readonly<{
  node: NodeIdentity;
  metadata: NodeAttachmentStartFrame;
  partPath: string;
}> & {
  nextChunkIndex: number;
  receivedBytes: number;
  lastActivityAt: number;
};

type TransferManifest = Readonly<{
  version: 1;
  nodeId: string;
  userId: string;
  connectionId: string;
  transferId: string;
  externalEventId: string;
  externalAttachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  readyAt: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSFER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSFER_FILE_PATTERN =
  /^([a-f0-9]{64})\.(?:part|bin|json)(?:\..+\.tmp)?$/u;
const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_ACTIVE_TRANSFERS_PER_NODE = 8;
const MAX_ACTIVE_DECLARED_BYTES_PER_NODE =
  40 * 1024 * 1024;
const MAX_STORED_TRANSFERS_PER_NODE = 64;
const MAX_STORED_BYTES_PER_NODE = 256 * 1024 * 1024;
const DEFAULT_TRANSFER_TTL_MS = 60 * 60 * 1_000;

export function createChannelNodeAttachmentStore(input: Readonly<{
  rootDirectory: string;
  now?: () => Date;
}>) {
  const rootDirectory = path.resolve(input.rootDirectory);
  const now = input.now ?? (() => new Date());
  const active = new Map<string, ActiveTransfer>();

  return {
    async cleanupExpired(
      node: NodeIdentity,
      maxAgeMs = DEFAULT_TRANSFER_TTL_MS,
    ): Promise<number> {
      return cleanupExpiredTransfers(node, maxAgeMs);
    },

    async discardNode(node: NodeIdentity): Promise<number> {
      if (
        !UUID_PATTERN.test(node.id)
        || !UUID_PATTERN.test(node.userId)
      ) {
        throw new Error("node_attachment_cleanup_invalid");
      }
      const transfers = [...active.values()].filter(
        (transfer) =>
          transfer.node.id === node.id
          && transfer.node.userId === node.userId,
      );
      await Promise.all(
        transfers.map((transfer) =>
          discardTransfer(
            transfer.node.id,
            transfer.metadata.transferId,
          )
        ),
      );
      return transfers.length;
    },

    async accept(
      node: NodeIdentity,
      frame: AttachmentTransferFrame,
    ): Promise<
      | null
      | Readonly<{
          status: "ready" | "rejected";
          errorCode?: string;
        }>
    > {
      assertIdentity(node, frame);
      if (frame.type === "attachment_start") {
        try {
          await startTransfer(node, frame);
          return null;
        } catch (error) {
          await discardFailedStart(node.id, frame.transferId);
          return {
            status: "rejected",
            errorCode: stableAttachmentError(error),
          };
        }
      }
      if (frame.type === "attachment_chunk") {
        try {
          await appendChunk(node, frame);
          return null;
        } catch (error) {
          await discardTransfer(node.id, frame.transferId);
          return {
            status: "rejected",
            errorCode: stableAttachmentError(error),
          };
        }
      }
      try {
        await commitTransfer(node, frame);
        return { status: "ready" };
      } catch (error) {
        await discardTransfer(node.id, frame.transferId);
        return {
          status: "rejected",
          errorCode: stableAttachmentError(error),
        };
      }
    },

    createFetcher(context: Readonly<{
      node: NodeIdentity;
      connectionId: string;
      externalEventId: string;
    }>): InboundAttachmentFetcher & Readonly<{
      release(
        descriptor: InboundAttachmentDescriptor,
      ): Promise<void>;
    }> {
      return {
        async inspect(descriptor) {
          const manifest = await loadMatchingManifest(
            context,
            descriptor,
          );
          return metadataFromManifest(manifest);
        },

        async download(descriptor) {
          const manifest = await loadMatchingManifest(
            context,
            descriptor,
          );
          const bytes = await readFile(
            transferPaths(
              manifest.nodeId,
              manifest.transferId,
            ).ready,
          );
          if (
            bytes.byteLength !== manifest.sizeBytes
            || sha256(bytes) !== manifest.sha256
          ) {
            throw new Error("node_attachment_storage_corrupt");
          }
          return (async function* () {
            yield bytes;
          })();
        },

        async release(descriptor) {
          let manifest: TransferManifest;
          try {
            manifest = await loadMatchingManifest(
              context,
              descriptor,
            );
          } catch (error) {
            if (isFileSystemError(error, "ENOENT")) return;
            throw error;
          }
          const paths = transferPaths(
            manifest.nodeId,
            manifest.transferId,
          );
          await Promise.all([
            removeIfPresent(paths.ready),
            removeIfPresent(paths.manifest),
          ]);
        },
      };
    },
  };

  async function startTransfer(
    node: NodeIdentity,
    frame: NodeAttachmentStartFrame,
  ): Promise<void> {
    await cleanupExpiredTransfers(
      node,
      DEFAULT_TRANSFER_TTL_MS,
    );
    validateAttachmentMetadata({
      fileName: frame.fileName,
      declaredMime: frame.mimeType,
      sizeBytes: frame.sizeBytes,
    });
    if (frame.sizeBytes > MAX_TRANSFER_BYTES) {
      throw new Error("attachment_file_too_large");
    }
    const key = transferKey(node.id, frame.transferId);
    if (active.has(key)) {
      await discardTransfer(node.id, frame.transferId);
    }
    const nodeTransfers = [...active.values()].filter(
      (transfer) =>
        transfer.node.id === node.id
        && transfer.node.userId === node.userId,
    );
    const declaredBytes = nodeTransfers.reduce(
      (total, transfer) =>
        total + transfer.metadata.sizeBytes,
      frame.sizeBytes,
    );
    const stored = await readStoredTransferUsage(
      node.id,
      frame.transferId,
    );
    if (
      nodeTransfers.length >= MAX_ACTIVE_TRANSFERS_PER_NODE
      || declaredBytes > MAX_ACTIVE_DECLARED_BYTES_PER_NODE
      || stored.count + nodeTransfers.length
        >= MAX_STORED_TRANSFERS_PER_NODE
      || stored.bytes + declaredBytes
        > MAX_STORED_BYTES_PER_NODE
    ) {
      throw new Error("node_attachment_capacity_exceeded");
    }
    const paths = transferPaths(node.id, frame.transferId);
    await mkdir(paths.directory, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(paths.directory, 0o700);
    await Promise.all([
      removeIfPresent(paths.part),
      removeIfPresent(paths.ready),
      removeIfPresent(paths.manifest),
    ]);
    const handle = await open(paths.part, "wx", 0o600);
    await handle.close();
    active.set(key, {
      node,
      metadata: frame,
      partPath: paths.part,
      nextChunkIndex: 0,
      receivedBytes: 0,
      lastActivityAt: now().getTime(),
    });
  }

  async function appendChunk(
    node: NodeIdentity,
    frame: NodeAttachmentChunkFrame,
  ): Promise<void> {
    const state = requireActive(node, frame.transferId);
    if (
      state.metadata.connectionId !== frame.connectionId
      || frame.chunkIndex !== state.nextChunkIndex
    ) {
      throw new Error("node_attachment_chunk_order_invalid");
    }
    const bytes = decodeBase64(frame.dataBase64);
    if (
      bytes.byteLength < 1
      || bytes.byteLength > MAX_CHUNK_BYTES
      || state.receivedBytes + bytes.byteLength
        > state.metadata.sizeBytes
    ) {
      throw new Error("node_attachment_chunk_size_invalid");
    }
    const handle = await open(state.partPath, "a", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    state.receivedBytes += bytes.byteLength;
    state.nextChunkIndex += 1;
    state.lastActivityAt = now().getTime();
  }

  async function commitTransfer(
    node: NodeIdentity,
    frame: NodeAttachmentCommitFrame,
  ): Promise<void> {
    const state = requireActive(node, frame.transferId);
    if (
      state.metadata.connectionId !== frame.connectionId
      || frame.chunkCount !== state.nextChunkIndex
      || state.receivedBytes !== state.metadata.sizeBytes
    ) {
      throw new Error("node_attachment_commit_invalid");
    }
    const bytes = await readFile(state.partPath);
    if (
      bytes.byteLength !== state.metadata.sizeBytes
      || sha256(bytes) !== state.metadata.sha256
    ) {
      throw new Error("node_attachment_checksum_invalid");
    }
    const validated = validateAttachmentFile({
      fileName: state.metadata.fileName,
      declaredMime: state.metadata.mimeType,
      bytes,
    });
    const paths = transferPaths(node.id, frame.transferId);
    await rename(paths.part, paths.ready);
    const manifest: TransferManifest = {
      version: 1,
      nodeId: node.id,
      userId: node.userId,
      connectionId: state.metadata.connectionId,
      transferId: state.metadata.transferId,
      externalEventId: state.metadata.externalEventId,
      externalAttachmentId:
        state.metadata.externalAttachmentId,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      sha256: state.metadata.sha256,
      readyAt: now().toISOString(),
    };
    await writePrivateJson(paths.manifest, manifest);
    await syncDirectory(paths.directory);
    active.delete(transferKey(node.id, frame.transferId));
  }

  async function discardTransfer(
    nodeId: string,
    transferId: string,
  ): Promise<void> {
    active.delete(transferKey(nodeId, transferId));
    const paths = transferPaths(nodeId, transferId);
    await Promise.all([
      removeIfPresent(paths.part),
      removeIfPresent(paths.ready),
      removeIfPresent(paths.manifest),
    ]);
  }

  async function discardFailedStart(
    nodeId: string,
    transferId: string,
  ): Promise<void> {
    if (active.has(transferKey(nodeId, transferId))) {
      await discardTransfer(nodeId, transferId);
      return;
    }
    await removeIfPresent(
      transferPaths(nodeId, transferId).part,
    );
  }

  async function cleanupExpiredTransfers(
    node: NodeIdentity,
    maxAgeMs: number,
  ): Promise<number> {
    if (
      !UUID_PATTERN.test(node.id)
      || !UUID_PATTERN.test(node.userId)
      || !Number.isSafeInteger(maxAgeMs)
      || maxAgeMs < 1
    ) {
      throw new Error("node_attachment_cleanup_invalid");
    }
    const directory = nodeDirectory(node.id);
    let entries;
    try {
      entries = await readdir(directory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return 0;
      throw error;
    }
    const candidates = new Map<string, string[]>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = TRANSFER_FILE_PATTERN.exec(entry.name);
      const transferId = match?.[1];
      if (!transferId) continue;
      const files = candidates.get(transferId) ?? [];
      files.push(path.join(directory, entry.name));
      candidates.set(transferId, files);
    }
    const cutoff = now().getTime() - maxAgeMs;
    let removedTransfers = 0;
    for (const [transferId, files] of candidates) {
      const key = transferKey(node.id, transferId);
      const activeTransfer = active.get(key);
      if (activeTransfer) {
        if (activeTransfer.lastActivityAt > cutoff) continue;
        active.delete(key);
      }
      const metadata = await Promise.all(
        files.map((file) => statIfPresent(file)),
      );
      const existing = metadata.filter(
        (value): value is NonNullable<typeof value> =>
          value !== null,
      );
      if (
        existing.length === 0
        || existing.some((value) =>
          value.mtime.getTime() > cutoff
        )
      ) {
        continue;
      }
      await Promise.all(files.map(removeIfPresent));
      removedTransfers += 1;
    }
    return removedTransfers;
  }

  async function readStoredTransferUsage(
    nodeId: string,
    excludedTransferId: string,
  ): Promise<Readonly<{ count: number; bytes: number }>> {
    const directory = nodeDirectory(nodeId);
    let entries;
    try {
      entries = await readdir(directory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return { count: 0, bytes: 0 };
      }
      throw error;
    }
    const readyFiles = entries.filter(
      (entry) =>
        entry.isFile()
        && /^[a-f0-9]{64}\.bin$/u.test(entry.name)
        && entry.name !== `${excludedTransferId}.bin`,
    );
    const metadata = await Promise.all(
      readyFiles.map((entry) =>
        statIfPresent(path.join(directory, entry.name))
      ),
    );
    return metadata.reduce(
      (usage, value) =>
        value
          ? {
              count: usage.count + 1,
              bytes: usage.bytes + Number(value.size),
            }
          : usage,
      { count: 0, bytes: 0 },
    );
  }

  function requireActive(
    node: NodeIdentity,
    transferId: string,
  ): ActiveTransfer {
    const state = active.get(transferKey(node.id, transferId));
    if (
      !state
      || state.node.userId !== node.userId
    ) {
      throw new Error("node_attachment_transfer_missing");
    }
    return state;
  }

  async function loadMatchingManifest(
    context: Readonly<{
      node: NodeIdentity;
      connectionId: string;
      externalEventId: string;
    }>,
    descriptor: InboundAttachmentDescriptor,
  ): Promise<TransferManifest> {
    const transferId = descriptor.source.transferId;
    if (
      descriptor.source.kind !== "node_transfer"
      || !transferId
      || !TRANSFER_ID_PATTERN.test(transferId)
    ) {
      throw new Error("node_attachment_locator_invalid");
    }
    const paths = transferPaths(context.node.id, transferId);
    const manifest = parseManifest(
      JSON.parse(await readFile(paths.manifest, "utf8")),
    );
    if (
      manifest.nodeId !== context.node.id
      || manifest.userId !== context.node.userId
      || manifest.connectionId !== context.connectionId
      || manifest.externalEventId !== context.externalEventId
      || manifest.externalAttachmentId
        !== descriptor.externalAttachmentId
      || manifest.fileName !== descriptor.fileName
      || manifest.mimeType !== descriptor.mimeType
      || manifest.sizeBytes !== descriptor.sizeBytes
    ) {
      throw new Error("node_attachment_scope_mismatch");
    }
    const metadata = await stat(paths.ready);
    if (
      !metadata.isFile()
      || metadata.size !== manifest.sizeBytes
    ) {
      throw new Error("node_attachment_storage_corrupt");
    }
    return manifest;
  }

  function transferPaths(nodeId: string, transferId: string) {
    if (
      !UUID_PATTERN.test(nodeId)
      || !TRANSFER_ID_PATTERN.test(transferId)
    ) {
      throw new Error("node_attachment_path_invalid");
    }
    const directory = nodeDirectory(nodeId);
    return {
      directory,
      part: path.join(directory, `${transferId}.part`),
      ready: path.join(directory, `${transferId}.bin`),
      manifest: path.join(directory, `${transferId}.json`),
    };
  }

  function nodeDirectory(nodeId: string): string {
    if (!UUID_PATTERN.test(nodeId)) {
      throw new Error("node_attachment_path_invalid");
    }
    const directory = path.resolve(rootDirectory, nodeId);
    if (!directory.startsWith(`${rootDirectory}${path.sep}`)) {
      throw new Error("node_attachment_path_invalid");
    }
    return directory;
  }
}

function transferKey(nodeId: string, transferId: string): string {
  return `${nodeId}:${transferId}`;
}

function assertIdentity(
  node: NodeIdentity,
  frame: AttachmentTransferFrame,
): void {
  if (
    frame.nodeId !== node.id
    || !UUID_PATTERN.test(node.id)
    || !UUID_PATTERN.test(node.userId)
  ) {
    throw new Error("node_attachment_scope_mismatch");
  }
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error("node_attachment_chunk_invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("node_attachment_chunk_invalid");
  }
  return bytes;
}

function metadataFromManifest(
  manifest: TransferManifest,
): InboundAttachmentMetadata {
  return {
    fileName: manifest.fileName,
    mimeType: manifest.mimeType,
    sizeBytes: manifest.sizeBytes,
  };
}

function parseManifest(value: unknown): TransferManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("node_attachment_manifest_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.nodeId !== "string"
    || typeof record.userId !== "string"
    || typeof record.connectionId !== "string"
    || typeof record.transferId !== "string"
    || typeof record.externalEventId !== "string"
    || typeof record.externalAttachmentId !== "string"
    || typeof record.fileName !== "string"
    || typeof record.mimeType !== "string"
    || !Number.isSafeInteger(record.sizeBytes)
    || typeof record.sha256 !== "string"
    || typeof record.readyAt !== "string"
  ) {
    throw new Error("node_attachment_manifest_invalid");
  }
  return record as TransferManifest;
}

async function writePrivateJson(
  target: string,
  value: unknown,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function removeIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function statIfPresent(
  target: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableAttachmentError(error: unknown): string {
  return error instanceof Error
    && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : "node_attachment_rejected";
}
