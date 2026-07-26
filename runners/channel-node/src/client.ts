import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import type {
  ChannelNodeConfig,
  ChannelNodeTlsMaterial,
} from "./config.js";
import { ChannelNodeHealth } from "./health.js";
import {
  isRunnerSendOutcome,
  parseRunnerInboundFrame,
  parseRunnerSendOutcome,
  parseRunnerServerFrame,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  serializeRunnerFrame,
  type RunnerChannelType,
  type RunnerFrame,
  type RunnerInboundAckFrame,
  type RunnerInboundFrame,
  type RunnerRegisteredFrame,
  type RunnerSendFrame,
  type RunnerSendOutcome,
} from "./protocol.js";

const OUTBOX_MAX_FRAMES = 1_000;
const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;
const DELIVERY_MAX_RECORDS = 10_000;
const DELIVERY_MAX_BYTES = 50 * 1024 * 1024;
const DELIVERY_RECEIPT_TTL_MS =
  7 * 24 * 60 * 60 * 1_000;
const OPEN_READY_STATE = 1;
const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
const ATTACHMENT_ACK_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
] as const;

type OutboxRecord = Readonly<{
  sequence: number;
  sha256: string;
  frame: RunnerInboundFrame;
}>;

export type ChannelNodeSocketOptions = Readonly<{
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  rejectUnauthorized: true;
  perMessageDeflate: false;
  maxPayload: number;
  handshakeTimeout: number;
}>;

export interface ChannelNodeSocket {
  readyState: number;
  on(
    event: "open",
    listener: () => void,
  ): this;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  on(
    event: "close",
    listener: (code: number, reason: Buffer) => void,
  ): this;
  on(
    event: "error",
    listener: (error: Error) => void,
  ): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type ChannelNodeSocketFactory = (
  url: string,
  options: ChannelNodeSocketOptions,
) => ChannelNodeSocket;

export type RunnerInboundDraft = Omit<
  RunnerInboundFrame,
  | "type"
  | "protocolVersion"
  | "nodeId"
  | "sequence"
  | "sentAt"
>;

export class FileChannelNodeOutbox {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly limits: Readonly<{
      maximumFrames?: number;
      maximumBytes?: number;
    }> = {},
  ) {}

  async append(frameInput: RunnerInboundFrame): Promise<void> {
    return this.runExclusive(async () => {
      const frame = parseRunnerInboundFrame(frameInput);
      const records = await this.readRecords();
      await this.appendFrame(records, frame);
    });
  }

  async appendNext(
    createFrame: (sequence: number) => RunnerInboundFrame,
  ): Promise<RunnerInboundFrame> {
    return this.runExclusive(async () => {
      const records = await this.readRecords();
      const lastSequence = Math.max(
        await this.readLastSequence(),
        ...records.map((record) => record.sequence),
      );
      if (lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("channel_node_sequence_exhausted");
      }
      const sequence = lastSequence + 1;
      const frame = parseRunnerInboundFrame(
        createFrame(sequence),
      );
      if (frame.sequence !== sequence) {
        throw new Error(
          "channel_node_outbox_sequence_mismatch",
        );
      }
      await this.appendFrame(records, frame);
      return frame;
    });
  }

  async list(): Promise<RunnerInboundFrame[]> {
    return this.runExclusive(async () =>
      (await this.readRecords()).map(
        (record) => record.frame,
      )
    );
  }

  async acknowledge(input: Readonly<{
    connectionId: string;
    externalEventId: string;
  }>): Promise<boolean> {
    return this.runExclusive(async () => {
      const records = await this.readRecords();
      const retained = records.filter(
        ({ frame }) =>
          frame.connectionId !== input.connectionId
          || frame.payload.externalEventId
            !== input.externalEventId,
      );
      if (retained.length === records.length) return false;
      await this.atomicRewrite(retained);
      return true;
    });
  }

  async reserveSequence(): Promise<number> {
    return this.runExclusive(async () => {
      const records = await this.readRecords();
      const persisted = await this.readLastSequence();
      const lastSequence = Math.max(
        persisted,
        ...records.map((record) => record.sequence),
      );
      if (lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("channel_node_sequence_exhausted");
      }
      const next = lastSequence + 1;
      await this.persistLastSequence(next);
      return next;
    });
  }

  private async readRecords(): Promise<OutboxRecord[]> {
    let content: string;
    try {
      await assertPrivateFileIfPresent(this.filePath);
      const metadata = await lstat(this.filePath);
      if (
        metadata.size
        > (this.limits.maximumBytes ?? OUTBOX_MAX_BYTES)
      ) {
        throw new Error("channel_node_outbox_limit_exceeded");
      }
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    if (!content) return [];
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let previousSequence = 0;
    const records = lines.map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("channel_node_outbox_corrupt");
      }
      if (!isOutboxRecord(value)) {
        throw new Error("channel_node_outbox_corrupt");
      }
      const frame = parseRunnerInboundFrame(value.frame);
      if (value.sequence !== frame.sequence) {
        throw new Error(
          "channel_node_outbox_sequence_mismatch",
        );
      }
      if (value.sequence <= previousSequence) {
        throw new Error(
          "channel_node_outbox_sequence_order_invalid",
        );
      }
      previousSequence = value.sequence;
      const digest = sha256(JSON.stringify(frame));
      if (digest !== value.sha256) {
        throw new Error("channel_node_outbox_checksum_invalid");
      }
      return {
        sequence: value.sequence,
        sha256: value.sha256,
        frame,
      };
    });
    if (
      records.length
      > (this.limits.maximumFrames ?? OUTBOX_MAX_FRAMES)
    ) {
      throw new Error("channel_node_outbox_limit_exceeded");
    }
    return records;
  }

  private async appendFrame(
    records: readonly OutboxRecord[],
    frame: RunnerInboundFrame,
  ): Promise<void> {
    const serializedFrame = JSON.stringify(frame);
    const digest = sha256(serializedFrame);
    const existing = records.find(
      (record) => record.sequence === frame.sequence,
    );
    if (existing) {
      if (existing.sha256 === digest) {
        await this.persistLastSequence(frame.sequence);
        return;
      }
      throw new Error("channel_node_outbox_sequence_conflict");
    }
    if (frame.sequence <= await this.readLastSequence()) {
      throw new Error("channel_node_outbox_sequence_replayed");
    }
    const record: OutboxRecord = {
      sequence: frame.sequence,
      sha256: digest,
      frame,
    };
    const line = `${JSON.stringify(record)}\n`;
    const maximumFrames =
      this.limits.maximumFrames ?? OUTBOX_MAX_FRAMES;
    const maximumBytes =
      this.limits.maximumBytes ?? OUTBOX_MAX_BYTES;
    const currentBytes = await this.fileSize();
    if (
      records.length >= maximumFrames
      || currentBytes + Buffer.byteLength(line) > maximumBytes
    ) {
      throw new Error("channel_node_outbox_limit_exceeded");
    }
    await this.ensurePrivateFile();
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.persistLastSequence(frame.sequence);
  }

  private async ensurePrivateFile(): Promise<void> {
    await mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await assertPrivateFileIfPresent(this.filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const handle = await open(this.filePath, "wx", 0o600);
      await handle.close();
    }
  }

  private async atomicRewrite(
    records: readonly OutboxRecord[],
  ): Promise<void> {
    await this.ensurePrivateFile();
    const temporaryPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      const body = records.length > 0
        ? `${records.map((record) =>
            JSON.stringify(record)
          ).join("\n")}\n`
        : "";
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    await syncDirectory(path.dirname(this.filePath));
  }

  private async fileSize(): Promise<number> {
    try {
      return (await lstat(this.filePath)).size;
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
  }

  private get statePath(): string {
    return `${this.filePath}.state`;
  }

  private async readLastSequence(): Promise<number> {
    try {
      await assertPrivateFileIfPresent(this.statePath);
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as unknown;
      if (
        !parsed
        || typeof parsed !== "object"
        || !("lastSequence" in parsed)
        || !Number.isSafeInteger(parsed.lastSequence)
        || (parsed.lastSequence as number) < 0
      ) {
        throw new Error("channel_node_sequence_state_invalid");
      }
      return parsed.lastSequence as number;
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
  }

  private async persistLastSequence(
    sequence: number,
  ): Promise<void> {
    const current = await this.readLastSequence();
    if (sequence <= current) return;
    await mkdir(path.dirname(this.statePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = path.join(
      path.dirname(this.statePath),
      `.${path.basename(this.statePath)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ lastSequence: sequence })}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.statePath);
    await syncDirectory(path.dirname(this.statePath));
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending
      .catch(() => undefined)
      .then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type ChannelNodeSendOutcome = RunnerSendOutcome;

type DeliveryRecord = Readonly<{
  deliveryId: string;
  requestSequence: number;
  requestDigest: string;
  expiresAt: string;
  state: "processing" | "completed";
  outcome?: ChannelNodeSendOutcome;
  sha256: string;
}>;

type DeliveryClaim =
  | Readonly<{ status: "execute" }>
  | Readonly<{
      status: "replay";
      outcome: ChannelNodeSendOutcome;
    }>
  | Readonly<{ status: "outcome_unknown" }>;

type RunnerAttachmentFrame = Extract<
  RunnerFrame,
  {
    type:
      | "attachment_start"
      | "attachment_chunk"
      | "attachment_commit";
  }
>;
type RunnerAttachmentDraft<T = RunnerAttachmentFrame> =
  T extends RunnerAttachmentFrame
    ? Omit<
        T,
        | "protocolVersion"
        | "nodeId"
        | "sequence"
        | "sentAt"
      >
    : never;

export interface ChannelNodeDeliveryStore {
  claim(
    frame: RunnerSendFrame,
    now: Date,
  ): Promise<DeliveryClaim>;
  complete(
    frame: RunnerSendFrame,
    outcome: ChannelNodeSendOutcome,
  ): Promise<void>;
}

export class FileChannelNodeDeliveryStore
  implements ChannelNodeDeliveryStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  claim(
    frame: RunnerSendFrame,
    now: Date,
  ): Promise<DeliveryClaim> {
    return this.runExclusive(async () => {
      const requestDigest = createDeliveryRequestDigest(frame);
      const records = (await this.readRecords()).filter(
        (record) =>
          new Date(record.expiresAt).getTime() > now.getTime(),
      );
      const existing = records.find(
        (record) => record.deliveryId === frame.deliveryId,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new Error(
            "channel_node_delivery_id_conflict",
          );
        }
        if (frame.sequence < existing.requestSequence) {
          throw new Error(
            "channel_node_delivery_sequence_replayed",
          );
        }
        if (frame.sequence > existing.requestSequence) {
          if (
            existing.state !== "completed"
            || !existing.outcome
          ) {
            return { status: "outcome_unknown" };
          }
          if (existing.outcome.status !== "retryable") {
            records[records.indexOf(existing)] =
              createDeliveryRecord({
                deliveryId: frame.deliveryId,
                requestSequence: frame.sequence,
                requestDigest,
                expiresAt: deliveryReceiptExpiresAt(
                  frame,
                  now,
                ),
                state: "completed",
                outcome: existing.outcome,
              });
            await this.atomicRewrite(records);
            return {
              status: "replay",
              outcome: existing.outcome,
            };
          }
          records[records.indexOf(existing)] =
            createDeliveryRecord({
              deliveryId: frame.deliveryId,
              requestSequence: frame.sequence,
              requestDigest,
              expiresAt: deliveryReceiptExpiresAt(
                frame,
                now,
              ),
              state: "processing",
            });
          await this.atomicRewrite(records);
          return { status: "execute" };
        }
        if (
          existing.state === "completed"
          && existing.outcome
        ) {
          return {
            status: "replay",
            outcome: existing.outcome,
          };
        }
        return { status: "outcome_unknown" };
      }
      if (records.length >= DELIVERY_MAX_RECORDS) {
        throw new Error(
          "channel_node_delivery_store_limit_exceeded",
        );
      }
      records.push(
        createDeliveryRecord({
          deliveryId: frame.deliveryId,
          requestSequence: frame.sequence,
          requestDigest,
          expiresAt: deliveryReceiptExpiresAt(
            frame,
            now,
          ),
          state: "processing",
        }),
      );
      await this.atomicRewrite(records);
      return { status: "execute" };
    });
  }

  complete(
    frame: RunnerSendFrame,
    outcome: ChannelNodeSendOutcome,
  ): Promise<void> {
    return this.runExclusive(async () => {
      let parsedOutcome: ChannelNodeSendOutcome;
      try {
        parsedOutcome = parseRunnerSendOutcome(outcome);
      } catch {
        throw new Error(
          "channel_node_send_outcome_invalid",
        );
      }
      const records = await this.readRecords();
      const index = records.findIndex(
        (record) => record.deliveryId === frame.deliveryId,
      );
      if (index < 0) {
        throw new Error(
          "channel_node_delivery_claim_missing",
        );
      }
      const existing = records[index];
      const requestDigest = createDeliveryRequestDigest(frame);
      if (existing.requestDigest !== requestDigest) {
        throw new Error(
          "channel_node_delivery_id_conflict",
        );
      }
      if (existing.requestSequence !== frame.sequence) {
        throw new Error(
          "channel_node_delivery_sequence_mismatch",
        );
      }
      if (
        existing.state === "completed"
        && existing.outcome
      ) {
        if (
          JSON.stringify(existing.outcome)
          !== JSON.stringify(parsedOutcome)
        ) {
          throw new Error(
            "channel_node_delivery_outcome_conflict",
          );
        }
        return;
      }
      records[index] = createDeliveryRecord({
        deliveryId: existing.deliveryId,
        requestSequence: existing.requestSequence,
        requestDigest,
        expiresAt: existing.expiresAt,
        state: "completed",
        outcome: parsedOutcome,
      });
      await this.atomicRewrite(records);
    });
  }

  private async readRecords(): Promise<DeliveryRecord[]> {
    let content: string;
    try {
      await assertPrivateFileIfPresent(this.filePath);
      const metadata = await lstat(this.filePath);
      if (metadata.size > DELIVERY_MAX_BYTES) {
        throw new Error(
          "channel_node_delivery_store_limit_exceeded",
        );
      }
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    if (!content) return [];
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length > DELIVERY_MAX_RECORDS) {
      throw new Error(
        "channel_node_delivery_store_limit_exceeded",
      );
    }
    const deliveryIds = new Set<string>();
    return lines.map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(
          "channel_node_delivery_store_corrupt",
        );
      }
      if (!isDeliveryRecord(value)) {
        throw new Error(
          "channel_node_delivery_store_corrupt",
        );
      }
      const expected = sha256(
        JSON.stringify(deliveryRecordContent(value)),
      );
      if (expected !== value.sha256) {
        throw new Error(
          "channel_node_delivery_store_checksum_invalid",
        );
      }
      if (deliveryIds.has(value.deliveryId)) {
        throw new Error(
          "channel_node_delivery_store_duplicate",
        );
      }
      deliveryIds.add(value.deliveryId);
      return value;
    });
  }

  private async atomicRewrite(
    records: readonly DeliveryRecord[],
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const body = records.length > 0
      ? `${records.map((record) =>
          JSON.stringify(record)
        ).join("\n")}\n`
      : "";
    if (Buffer.byteLength(body) > DELIVERY_MAX_BYTES) {
      throw new Error(
        "channel_node_delivery_store_limit_exceeded",
      );
    }
    const temporaryPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    await syncDirectory(path.dirname(this.filePath));
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending
      .catch(() => undefined)
      .then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type ChannelNodeClientInput = Readonly<{
  config: ChannelNodeConfig;
  tls: ChannelNodeTlsMaterial;
  outbox: FileChannelNodeOutbox;
  supportedChannelTypes: readonly RunnerChannelType[];
  clientVersion: string;
  socketFactory?: ChannelNodeSocketFactory;
  autoReconnect?: boolean;
  random?: () => number;
  now?: () => Date;
  health?: ChannelNodeHealth;
  deliveryStore?: ChannelNodeDeliveryStore;
  onRegistered?: (
    frame: RunnerRegisteredFrame,
  ) => void | Promise<void>;
  onBeforeInboundReplay?: (
    frame: RunnerRegisteredFrame,
  ) => void | Promise<void>;
  onInboundAcknowledged?: (
    frame: RunnerInboundAckFrame,
  ) => void | Promise<void>;
  onSend?: (
    frame: RunnerSendFrame,
  ) => ChannelNodeSendOutcome
    | Promise<ChannelNodeSendOutcome>;
}>;

export class ChannelNodeClient {
  private readonly socketFactory: ChannelNodeSocketFactory;
  private readonly autoReconnect: boolean;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly health: ChannelNodeHealth;
  private readonly deliveryStore: ChannelNodeDeliveryStore;
  private socket: ChannelNodeSocket | null = null;
  private registered = false;
  private registrationReady = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null =
    null;
  private heartbeatTimer:
    | ReturnType<typeof setInterval>
    | null = null;
  private receiveQueue: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private connectionDeferred: Deferred<void> | null = null;
  private boundConnectionIds = new Set<string>();
  private lastServerSequence = 0;
  private socketGeneration = 0;
  private localChannelsReconciliation: Promise<void> =
    Promise.resolve();
  private readonly attachmentTransfers = new Map<
    string,
    Deferred<void> & {
      timer: ReturnType<typeof setTimeout>;
      connectionId: string;
    }
  >();

  constructor(private readonly input: ChannelNodeClientInput) {
    this.autoReconnect = input.autoReconnect ?? true;
    this.random = input.random ?? Math.random;
    this.now = input.now ?? (() => new Date());
    this.health = input.health ?? new ChannelNodeHealth();
    this.deliveryStore =
      input.deliveryStore
      ?? new FileChannelNodeDeliveryStore(
        `${input.outbox.filePath}.deliveries`,
      );
    this.socketFactory =
      input.socketFactory
      ?? ((url, options) => new WebSocket(url, options));
    if (new Set(input.supportedChannelTypes).size < 1) {
      throw new Error("channel_node_channel_types_required");
    }
  }

  connect(): Promise<void> {
    if (this.stopped) {
      throw new Error("channel_node_client_stopped");
    }
    if (this.connectionDeferred) {
      return this.connectionDeferred.promise;
    }
    if (
      this.registered
      && this.socket?.readyState === OPEN_READY_STATE
    ) {
      return Promise.resolve();
    }
    return this.openSocket();
  }

  reconnect(): Promise<void> {
    if (this.stopped) {
      throw new Error("channel_node_client_stopped");
    }
    this.cancelReconnect();
    const previous = this.socket;
    this.socketGeneration += 1;
    this.socket = null;
    this.registered = false;
    this.registrationReady = false;
    this.boundConnectionIds.clear();
    this.clearHeartbeat();
    this.connectionDeferred?.reject(
      new Error("channel_node_connection_replaced"),
    );
    this.connectionDeferred = null;
    this.rejectAttachmentTransfers(
      "channel_node_connection_replaced",
    );
    if (previous) {
      previous.terminate();
    }
    return this.openSocket();
  }

  async sendInbound(
    frameInput: RunnerInboundFrame,
  ): Promise<void> {
    const frame = parseRunnerInboundFrame(frameInput);
    this.assertConfiguredFrame(frame);
    if (
      this.registered
      && !this.boundConnectionIds.has(frame.connectionId)
    ) {
      throw new Error("node_connection_not_bound");
    }
    await this.input.outbox.append(frame);
    if (
      this.registered
      && this.registrationReady
      && this.boundConnectionIds.has(frame.connectionId)
    ) {
      this.trySendDurableInbound(frame);
    }
  }

  async enqueueInbound(
    draft: RunnerInboundDraft,
  ): Promise<RunnerInboundFrame> {
    this.assertConfiguredFrame(draft);
    if (
      this.registered
      && !this.boundConnectionIds.has(draft.connectionId)
    ) {
      throw new Error("node_connection_not_bound");
    }
    const frame = await this.input.outbox.appendNext(
      (sequence) => ({
        type: "inbound",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        nodeId: this.input.config.nodeId,
        sequence,
        sentAt: this.now().toISOString(),
        ...draft,
      }),
    );
    if (
      this.registered
      && this.registrationReady
      && this.boundConnectionIds.has(frame.connectionId)
    ) {
      this.trySendDurableInbound(frame);
    }
    return frame;
  }

  async transferAttachment(input: Readonly<{
    connectionId: string;
    externalEventId: string;
    externalAttachmentId: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }>): Promise<Readonly<{ transferId: string }>> {
    this.assertConfiguredFrame(input);
    if (
      !this.registered
      || !this.boundConnectionIds.has(input.connectionId)
    ) {
      throw new Error("node_connection_not_bound");
    }
    if (
      input.bytes.byteLength < 1
      || input.bytes.byteLength > 10 * 1024 * 1024
    ) {
      throw new Error("node_attachment_size_invalid");
    }
    const contentSha256 = sha256(input.bytes);
    const transferId = sha256([
      this.input.config.nodeId,
      input.connectionId,
      input.externalEventId,
      input.externalAttachmentId,
      contentSha256,
    ].join("\u0000"));
    if (this.attachmentTransfers.has(transferId)) {
      throw new Error("node_attachment_transfer_in_progress");
    }
    const deferred = createDeferred<void>();
    const timer = setTimeout(() => {
      const pending = this.attachmentTransfers.get(transferId);
      if (pending !== transfer) return;
      this.attachmentTransfers.delete(transferId);
      deferred.reject(
        new Error("node_attachment_ack_timeout"),
      );
    }, ATTACHMENT_ACK_TIMEOUT_MS);
    timer.unref();
    const transfer = {
      ...deferred,
      timer,
      connectionId: input.connectionId,
    };
    this.attachmentTransfers.set(transferId, transfer);
    try {
      await this.sendRunnerFrame({
        type: "attachment_start",
        connectionId: input.connectionId,
        transferId,
        externalEventId: input.externalEventId,
        externalAttachmentId: input.externalAttachmentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        sha256: contentSha256,
      });
      let chunkCount = 0;
      for (
        let offset = 0;
        offset < input.bytes.byteLength;
        offset += ATTACHMENT_CHUNK_BYTES
      ) {
        await this.sendRunnerFrame({
          type: "attachment_chunk",
          connectionId: input.connectionId,
          transferId,
          chunkIndex: chunkCount,
          dataBase64: input.bytes
            .subarray(
              offset,
              Math.min(
                input.bytes.byteLength,
                offset + ATTACHMENT_CHUNK_BYTES,
              ),
            )
            .toString("base64"),
        });
        chunkCount += 1;
      }
      await this.sendRunnerFrame({
        type: "attachment_commit",
        connectionId: input.connectionId,
        transferId,
        chunkCount,
      });
      await deferred.promise;
      return { transferId };
    } catch (error) {
      const pending = this.attachmentTransfers.get(transferId);
      if (pending === transfer) {
        clearTimeout(timer);
        this.attachmentTransfers.delete(transferId);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelReconnect();
    this.clearHeartbeat();
    this.registered = false;
    this.registrationReady = false;
    this.boundConnectionIds.clear();
    this.socketGeneration += 1;
    this.connectionDeferred?.reject(
      new Error("channel_node_client_stopped"),
    );
    this.connectionDeferred = null;
    this.rejectAttachmentTransfers(
      "channel_node_client_stopped",
    );
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, "channel_node_stopped");
    await this.receiveQueue.catch(() => undefined);
    await this.sendQueue.catch(() => undefined);
    this.health.setState("stopped");
  }

  getHealth() {
    return this.health.getSnapshot();
  }

  private openSocket(): Promise<void> {
    this.health.setState("connecting");
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    const deferred = createDeferred<void>();
    this.connectionDeferred = deferred;
    let socket: ChannelNodeSocket;
    try {
      socket = this.socketFactory(
        this.input.config.serverUrl,
        {
          ca: this.input.tls.ca,
          cert: this.input.tls.certificate,
          key: this.input.tls.key,
          rejectUnauthorized: true,
          perMessageDeflate: false,
          maxPayload: RUNNER_MAX_FRAME_BYTES,
          handshakeTimeout: 30_000,
        },
      );
    } catch (error) {
      this.connectionDeferred = null;
      this.rejectAttachmentTransfers(
        "channel_node_connection_closed",
      );
      const stableCode = stableErrorCode(error);
      this.health.recordError(stableCode);
      this.health.setState("disconnected");
      deferred.reject(
        error instanceof Error
          ? error
          : new Error(stableCode),
      );
      if (this.autoReconnect) this.scheduleReconnect();
      return deferred.promise;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.sendRegister();
    });
    socket.on("message", (data, isBinary) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      if (isBinary) {
        this.failSocket(
          socket,
          generation,
          "channel_node_binary_frame_rejected",
        );
        return;
      }
      const raw = rawDataToBuffer(data);
      this.receiveQueue = this.receiveQueue
        .catch(() => undefined)
        .then(() => this.receive(socket, generation, raw))
        .catch((error) => {
          this.failSocket(
            socket,
            generation,
            stableErrorCode(error),
          );
        });
    });
    socket.on("error", (error) => {
      if (this.isCurrentSocket(socket, generation)) {
        this.health.recordError(stableErrorCode(error));
      }
    });
    socket.on("close", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.socketGeneration += 1;
      this.socket = null;
      this.registered = false;
      this.registrationReady = false;
      this.boundConnectionIds.clear();
      this.clearHeartbeat();
      this.health.setState("disconnected");
      if (this.connectionDeferred === deferred) {
        this.connectionDeferred = null;
        deferred.reject(
          new Error("channel_node_connection_closed"),
        );
      }
      if (!this.stopped && this.autoReconnect) {
        this.scheduleReconnect();
      }
    });
    return deferred.promise;
  }

  private async receive(
    socket: ChannelNodeSocket,
    generation: number,
    raw: Buffer,
  ): Promise<void> {
    if (!this.isCurrentSocket(socket, generation)) return;
    const frame = parseRunnerServerFrame(raw);
    if (frame.nodeId !== this.input.config.nodeId) {
      throw new Error("channel_node_identity_mismatch");
    }
    const correlatedOutOfOrderFrame =
      this.registered
      && (
        frame.type === "send"
        || frame.type === "inbound_ack"
        || frame.type === "attachment_ack"
      )
      && frame.sequence <= this.lastServerSequence;
    if (
      frame.sequence <= this.lastServerSequence
      && !correlatedOutOfOrderFrame
    ) {
      throw new Error("channel_node_server_sequence_replayed");
    }
    this.lastServerSequence = Math.max(
      this.lastServerSequence,
      frame.sequence,
    );
    this.health.recordMessage();
    if (!this.registered) {
      if (frame.type !== "registered") {
        throw new Error("channel_node_registration_required");
      }
      await this.acceptRegistration(
        socket,
        generation,
        frame,
      );
      return;
    }
    if (frame.type === "registered") {
      throw new Error("channel_node_already_registered");
    }
    this.assertConfiguredFrame(frame);
    if (!this.boundConnectionIds.has(frame.connectionId)) {
      throw new Error("node_connection_not_bound");
    }
    if (frame.type === "inbound_ack") {
      const acknowledged =
        await this.input.outbox.acknowledge({
        connectionId: frame.connectionId,
        externalEventId: frame.externalEventId,
      });
      if (!acknowledged) return;
      await this.input.onInboundAcknowledged?.(frame);
      return;
    }
    if (frame.type === "attachment_ack") {
      const transfer = this.attachmentTransfers.get(
        frame.transferId,
      );
      if (
        !transfer
        || transfer.connectionId !== frame.connectionId
      ) {
        throw new Error("node_attachment_ack_unexpected");
      }
      clearTimeout(transfer.timer);
      this.attachmentTransfers.delete(frame.transferId);
      if (frame.status === "ready") {
        transfer.resolve();
      } else {
        transfer.reject(
          new Error(
            frame.errorCode
              ?? "node_attachment_rejected",
          ),
        );
      }
      return;
    }
    this.queueSend(socket, generation, frame);
  }

  private async acceptRegistration(
    socket: ChannelNodeSocket,
    generation: number,
    frame: RunnerRegisteredFrame,
  ): Promise<void> {
    if (!this.isCurrentSocket(socket, generation)) return;
    const configured = new Set(
      this.input.config.connectionIds,
    );
    for (const connectionId of frame.boundConnectionIds) {
      if (!configured.has(connectionId)) {
        throw new Error("node_connection_not_configured");
      }
    }
    this.boundConnectionIds = new Set(
      frame.boundConnectionIds,
    );
    this.registered = true;
    this.registrationReady = false;
    this.reconnectAttempt = 0;
    this.health.setState("registered");
    void this.finishRegistration(
      socket,
      generation,
      frame,
    ).catch((error) => {
      this.failSocket(
        socket,
        generation,
        stableErrorCode(error),
      );
    });
  }

  private async finishRegistration(
    socket: ChannelNodeSocket,
    generation: number,
    frame: RunnerRegisteredFrame,
  ): Promise<void> {
    await this.ensureLocalChannelsStarted(frame);
    if (!this.isCurrentSocket(socket, generation)) return;
    await this.input.onBeforeInboundReplay?.(frame);
    if (!this.isCurrentSocket(socket, generation)) return;
    this.registrationReady = true;
    const pendingFrames = await this.input.outbox.list();
    if (!this.isCurrentSocket(socket, generation)) return;
    for (const pending of pendingFrames) {
      if (this.boundConnectionIds.has(pending.connectionId)) {
        this.sendTo(socket, generation, pending);
      }
    }
    this.startHeartbeat(
      frame.heartbeatIntervalMs,
      socket,
      generation,
    );
    if (
      this.isCurrentSocket(socket, generation)
      && this.connectionDeferred
    ) {
      const deferred = this.connectionDeferred;
      this.connectionDeferred = null;
      deferred.resolve();
    }
  }

  private queueSend(
    socket: ChannelNodeSocket,
    generation: number,
    frame: RunnerSendFrame,
  ): void {
    const task = this.sendQueue
      .catch(() => undefined)
      .then(async () => {
        await this.localChannelsReconciliation;
        if (!this.isCurrentSocket(socket, generation)) return;
        await this.handleSend(socket, generation, frame);
      });
    this.sendQueue = task.then(
      () => undefined,
      () => undefined,
    );
    void task.catch((error) => {
      this.failSocket(
        socket,
        generation,
        stableErrorCode(error),
      );
    });
  }

  private async handleSend(
    socket: ChannelNodeSocket,
    generation: number,
    frame: RunnerSendFrame,
  ): Promise<void> {
    if (new Date(frame.expiresAt).getTime() <= this.now().getTime()) {
      await this.sendOutcome(socket, generation, frame, {
        status: "failed",
        errorCode: "delivery_expired",
      });
      return;
    }
    if (!this.input.onSend) {
      await this.sendOutcome(socket, generation, frame, {
        status: "failed",
        errorCode: "channel_handler_unavailable",
      });
      return;
    }
    const claim = await this.deliveryStore.claim(
      frame,
      this.now(),
    );
    if (claim.status === "replay") {
      await this.sendOutcome(
        socket,
        generation,
        frame,
        claim.outcome,
      );
      return;
    }
    if (claim.status === "outcome_unknown") {
      await this.sendOutcome(socket, generation, frame, {
        status: "failed",
        errorCode: "delivery_outcome_unknown",
      });
      return;
    }
    let outcome: ChannelNodeSendOutcome;
    let result: unknown;
    try {
      result = await this.input.onSend(frame);
    } catch {
      outcome = {
        status: "failed",
        errorCode: "channel_send_failed",
      };
      await this.deliveryStore.complete(frame, outcome);
      await this.sendOutcome(
        socket,
        generation,
        frame,
        outcome,
      );
      return;
    }
    try {
      outcome = parseRunnerSendOutcome(result);
    } catch {
      outcome = {
        status: "failed",
        errorCode: "channel_send_result_invalid",
      };
    }
    await this.deliveryStore.complete(frame, outcome);
    await this.sendOutcome(
      socket,
      generation,
      frame,
      outcome,
    );
  }

  private async sendOutcome(
    socket: ChannelNodeSocket,
    generation: number,
    source: RunnerSendFrame,
    outcome: ChannelNodeSendOutcome,
  ): Promise<void> {
    const sequence =
      await this.input.outbox.reserveSequence();
    if (!this.isCurrentSocket(socket, generation)) return;
    this.sendTo(socket, generation, {
      type: "send_result",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      nodeId: this.input.config.nodeId,
      sequence,
      sentAt: this.now().toISOString(),
      connectionId: source.connectionId,
      deliveryId: source.deliveryId,
      requestSequence: source.sequence,
      ...outcome,
    });
  }

  private sendRegister(): void {
    this.send({
      type: "register",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      nodeId: this.input.config.nodeId,
      sequence: 1,
      sentAt: this.now().toISOString(),
      certificateFingerprint:
        this.input.tls.certificateFingerprint,
      supportedChannelTypes: [
        ...this.input.supportedChannelTypes,
      ],
      clientVersion: this.input.clientVersion,
    });
  }

  private send(frame: RunnerFrame): void {
    const socket = this.socket;
    const generation = this.socketGeneration;
    if (!socket) {
      throw new Error("channel_node_socket_not_open");
    }
    this.sendTo(socket, generation, frame);
  }

  private trySendDurableInbound(
    frame: RunnerInboundFrame,
  ): void {
    try {
      this.send(frame);
    } catch (error) {
      const socket = this.socket;
      if (socket) {
        this.failSocket(
          socket,
          this.socketGeneration,
          stableErrorCode(error),
        );
      }
    }
  }

  private async sendRunnerFrame(
    draft: RunnerAttachmentDraft,
  ): Promise<void> {
    const sequence = await this.input.outbox.reserveSequence();
    this.send({
      ...draft,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      nodeId: this.input.config.nodeId,
      sequence,
      sentAt: this.now().toISOString(),
    } as RunnerFrame);
  }

  private sendTo(
    socket: ChannelNodeSocket,
    generation: number,
    frame: RunnerFrame,
  ): void {
    if (
      !this.isCurrentSocket(socket, generation)
      || socket.readyState !== OPEN_READY_STATE
    ) {
      throw new Error("channel_node_socket_not_open");
    }
    socket.send(serializeRunnerFrame(frame));
  }

  private assertConfiguredFrame(input: {
    connectionId: string;
  }): void {
    if (
      !this.input.config.connectionIds.includes(
        input.connectionId,
      )
    ) {
      throw new Error("node_connection_not_configured");
    }
  }

  private async ensureLocalChannelsStarted(
    frame: RunnerRegisteredFrame,
  ): Promise<void> {
    const reconciliation = this.localChannelsReconciliation
      .catch(() => undefined)
      .then(() => this.input.onRegistered?.(frame));
    this.localChannelsReconciliation = reconciliation;
    await reconciliation;
  }

  private startHeartbeat(
    intervalMs: number,
    socket: ChannelNodeSocket,
    generation: number,
  ): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.input.outbox.reserveSequence()
        .then((sequence) => {
          if (
            !this.registered
            || !this.isCurrentSocket(socket, generation)
          ) {
            return;
          }
          this.sendTo(socket, generation, {
            type: "heartbeat",
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            nodeId: this.input.config.nodeId,
            sequence,
            sentAt: this.now().toISOString(),
          });
        })
        .catch((error) => {
          if (this.isCurrentSocket(socket, generation)) {
            this.failSocket(
              socket,
              generation,
              stableErrorCode(error),
            );
          }
        });
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = computeReconnectDelayMs(
      this.reconnectAttempt,
      this.random,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private failSocket(
    socket: ChannelNodeSocket,
    generation: number,
    code: string,
  ): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.health.recordError(code);
    this.socketGeneration += 1;
    this.socket = null;
    this.registered = false;
    this.registrationReady = false;
    this.boundConnectionIds.clear();
    this.clearHeartbeat();
    this.health.setState("disconnected");
    this.connectionDeferred?.reject(new Error(code));
    this.connectionDeferred = null;
    this.rejectAttachmentTransfers(code);
    socket.close(1008, boundedCloseReason(code));
    if (!this.stopped && this.autoReconnect) {
      this.scheduleReconnect();
    }
  }

  private rejectAttachmentTransfers(code: string): void {
    for (const transfer of this.attachmentTransfers.values()) {
      clearTimeout(transfer.timer);
      transfer.reject(new Error(code));
    }
    this.attachmentTransfers.clear();
  }

  private isCurrentSocket(
    socket: ChannelNodeSocket,
    generation: number,
  ): boolean {
    return !this.stopped
      && this.socket === socket
      && this.socketGeneration === generation;
  }
}

export function computeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const normalizedAttempt = Number.isSafeInteger(attempt)
    && attempt >= 0
    ? attempt
    : 0;
  const base = RECONNECT_DELAYS_MS[
    Math.min(
      normalizedAttempt,
      RECONNECT_DELAYS_MS.length - 1,
    )
  ];
  const unit = Math.max(0, Math.min(1, random()));
  return Math.round(base * (0.8 + unit * 0.4));
}

function createDeliveryRequestDigest(
  frame: RunnerSendFrame,
): string {
  return sha256(JSON.stringify({
    protocolVersion: frame.protocolVersion,
    nodeId: frame.nodeId,
    connectionId: frame.connectionId,
    deliveryId: frame.deliveryId,
    payload: frame.payload,
  }));
}

function deliveryReceiptExpiresAt(
  frame: RunnerSendFrame,
  now: Date,
): string {
  return new Date(
    Math.max(
      new Date(frame.expiresAt).getTime(),
      now.getTime() + DELIVERY_RECEIPT_TTL_MS,
    ),
  ).toISOString();
}

function createDeliveryRecord(
  content: Omit<DeliveryRecord, "sha256">,
): DeliveryRecord {
  return {
    ...content,
    sha256: sha256(JSON.stringify(content)),
  };
}

function deliveryRecordContent(
  record: DeliveryRecord,
): Omit<DeliveryRecord, "sha256"> {
  const {
    deliveryId,
    requestSequence,
    requestDigest,
    expiresAt,
    state,
    outcome,
  } = record;
  return {
    deliveryId,
    requestSequence,
    requestDigest,
    expiresAt,
    state,
    ...(outcome ? { outcome } : {}),
  };
}

function isDeliveryRecord(
  value: unknown,
): value is DeliveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.deliveryId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(record.deliveryId)
    || !Number.isSafeInteger(record.requestSequence)
    || Number(record.requestSequence) < 1
    || typeof record.requestDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(record.requestDigest)
    || typeof record.expiresAt !== "string"
    || !Number.isFinite(
      new Date(record.expiresAt).getTime(),
    )
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || (
      record.state !== "processing"
      && record.state !== "completed"
    )
  ) {
    return false;
  }
  if (record.state === "processing") {
    return record.outcome === undefined;
  }
  return isRunnerSendOutcome(record.outcome);
}

function isOutboxRecord(value: unknown): value is OutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.sequence)
    && (record.sequence as number) > 0
    && typeof record.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(record.sha256)
    && Boolean(record.frame)
    && typeof record.frame === "object";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertPrivateFileIfPresent(
  filePath: string,
): Promise<void> {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile()
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("channel_node_private_file_mode_invalid");
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function boundedCloseReason(reason: string): string {
  return reason.slice(0, 123);
}

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 123)
      || "channel_node_protocol_error";
  }
  return "channel_node_protocol_error";
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
