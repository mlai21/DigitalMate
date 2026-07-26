import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  RunnerInboundDraft,
  ChannelNodeSendOutcome,
} from "../client.js";
import type {
  RunnerInboundFrame,
  RunnerSendFrame,
} from "../protocol.js";
import type {
  IMessageRunnerConfig,
} from "./config.js";
import type {
  IMessageDatabase,
  IMessageExecute,
} from "./database.js";
import {
  pollMessages,
  type IMessageAttachment,
} from "./normalize.js";

const execFileAsync = promisify(execFile);
const SQLITE_PATH = "/usr/bin/sqlite3";
const MAX_MESSAGE_ATTACHMENTS = 4;
const MAX_FILE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

type IntervalHandle = unknown;

type IMessagePrerequisiteDependencies = Readonly<{
  platform?: string;
  assertExecutable?: (filePath: string) => Promise<void>;
  assertDatabaseReadable?: (filePath: string) => Promise<void>;
  findExecutable?: (name: string) => Promise<string | null>;
}>;

export async function assertIMessagePrerequisites(
  config: IMessageRunnerConfig,
  dependencies: IMessagePrerequisiteDependencies = {},
): Promise<string> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("imessage_macos_required");
  }
  const assertExecutable = dependencies.assertExecutable
    ?? defaultAssertExecutable;
  const assertDatabaseReadable =
    dependencies.assertDatabaseReadable
    ?? defaultAssertDatabaseReadable;
  const findExecutable = dependencies.findExecutable
    ?? defaultFindExecutable;
  try {
    await assertExecutable(SQLITE_PATH);
  } catch {
    throw new Error("imessage_sqlite3_required");
  }
  try {
    await assertDatabaseReadable(config.dbPath);
  } catch {
    throw new Error("imessage_full_disk_access_required");
  }
  const imsgPath = await findExecutable("imsg");
  if (!imsgPath || !path.isAbsolute(imsgPath)) {
    throw new Error("imessage_imsg_required");
  }
  try {
    await assertExecutable(imsgPath);
  } catch {
    throw new Error("imessage_imsg_required");
  }
  return imsgPath;
}

export function createIMessageTransport(input: Readonly<{
  config: IMessageRunnerConfig;
  database: IMessageDatabase;
  enqueueInbound(
    draft: RunnerInboundDraft,
  ): Promise<unknown>;
  execute?: IMessageExecute;
  resolvePrerequisites?: () => Promise<string>;
  setInterval?: (
    task: () => void,
    milliseconds: number,
  ) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
  now?: () => Date;
  attachmentRoot?: string;
  onRowRejected?: (
    rowId: number,
    errorCode: string,
  ) => void | Promise<void>;
  transferAttachment?: (input: Readonly<{
    connectionId: string;
    externalEventId: string;
    externalAttachmentId: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }>) => Promise<Readonly<{ transferId: string }>>;
  listPendingInboundEventIds?: () => Promise<
    ReadonlySet<string>
  >;
}>) {
  const execute = input.execute ?? executeCommand;
  const resolvePrerequisites =
    input.resolvePrerequisites
    ?? (() => assertIMessagePrerequisites(input.config));
  const schedule = input.setInterval
    ?? ((task, milliseconds) =>
      setInterval(task, milliseconds)
    );
  const cancelSchedule = input.clearInterval
    ?? ((handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>)
    );
  const now = input.now ?? (() => new Date());
  let cursor: number | null = null;
  let imsgPath: string | null = null;
  let timer: IntervalHandle | null = null;
  let polling: Promise<void> | null = null;
  let stopped = false;
  const pendingAttachmentFiles = new Map<string, string[]>();

  const pollOnce = async (): Promise<void> => {
    if (cursor === null || stopped) {
      throw new Error("imessage_transport_not_started");
    }
    if (polling) return polling;
    polling = runPoll().finally(() => {
      polling = null;
    });
    return polling;
  };

  const runPoll = async (): Promise<void> => {
    const rows = await input.database.readAfter(cursor!);
    const ordered = [...rows].sort(
      (left, right) =>
        numericRowId(left.rowid) - numericRowId(right.rowid),
    );
    for (const row of ordered) {
      const rowId = numericRowId(row.rowid);
      if (rowId <= cursor!) continue;
      let copiedPaths: string[] = [];
      let pendingEventId: string | null = null;
      try {
        const events = pollMessages({
          connectionId: input.config.connectionId,
          lastRowId: cursor!,
          rows: [row],
          botPrefix: input.config.botPrefix,
          receivedAt: now(),
        });
        const event = events[0];
        if (event) {
          const attachments =
            await materializeIMessageAttachments({
              eventId: event.externalEventId,
              attachments: event.attachments,
              attachmentRoot:
                input.attachmentRoot
                ?? path.join(
                  homedir(),
                  "Library",
                  "Messages",
                  "Attachments",
                ),
              mediaDirectory: input.config.mediaDirectory,
              maxDecodedSize: input.config.maxDecodedSize,
            });
          copiedPaths = attachments.flatMap((attachment) => {
            const localPath = attachment.source.localPath;
            return localPath ? [localPath] : [];
          });
          const transferableAttachments = input.transferAttachment
            ? await Promise.all(
                attachments.map(async (attachment) => {
                  const localPath = attachment.source.localPath;
                  if (
                    !localPath
                    || !attachment.fileName
                    || !attachment.mimeType
                  ) {
                    throw new Error(
                      "imessage_attachment_transfer_invalid",
                    );
                  }
                  const transferred =
                    await input.transferAttachment!({
                      connectionId: input.config.connectionId,
                      externalEventId: event.externalEventId,
                      externalAttachmentId:
                        attachment.externalAttachmentId,
                      fileName: attachment.fileName,
                      mimeType: attachment.mimeType,
                      bytes: await readFile(localPath),
                    });
                  return {
                    ...attachment,
                    source: {
                      kind: "node_transfer",
                      transferId: transferred.transferId,
                    },
                  };
                }),
              )
            : attachments;
          if (copiedPaths.length > 0) {
            pendingEventId = event.externalEventId;
            await persistPendingIMessageAttachments({
              directory: input.config.mediaDirectory,
              externalEventId: pendingEventId,
              files: copiedPaths,
            });
            pendingAttachmentFiles.set(
              pendingEventId,
              copiedPaths,
            );
          }
          await input.enqueueInbound({
            connectionId: input.config.connectionId,
            payload: {
              externalEventId: event.externalEventId,
              externalConversationId:
                event.externalConversationId,
              externalSenderId: event.externalSenderId,
              chatType: "direct",
              mentioned: false,
              text: event.text,
              thread: {},
              attachments: transferableAttachments,
              occurredAt: event.occurredAt,
              rawSummary: event.rawSummary,
              replyHandle: {
                publicFields: {
                  handle: event.externalSenderId,
                },
                secretFields: {},
                expiresAt: null,
              },
            },
          });
        }
      } catch (error) {
        await Promise.allSettled(
          copiedPaths.map((filePath) => unlink(filePath)),
        );
        if (pendingEventId) {
          pendingAttachmentFiles.delete(pendingEventId);
          await removeIfPresent(
            pendingManifestPath(
              input.config.mediaDirectory,
              pendingEventId,
            ),
          );
        }
        const errorCode = stableIMessageErrorCode(error);
        if (isTransientIMessageRowError(errorCode)) {
          throw error;
        }
        await input.onRowRejected?.(
          rowId,
          errorCode,
        );
      }
      cursor = rowId;
    }
  };

  return {
    async start(): Promise<void> {
      if (timer !== null) return;
      stopped = false;
      imsgPath = await resolvePrerequisites();
      try {
        if (input.transferAttachment) {
          const restored =
            await restorePendingIMessageAttachments(
              input.config.mediaDirectory,
            );
          const pendingEventIds =
            await input.listPendingInboundEventIds?.();
          if (pendingEventIds) {
            for (const [externalEventId, files] of restored) {
              if (pendingEventIds.has(externalEventId)) continue;
              await Promise.allSettled(
                files.map((filePath) => unlink(filePath)),
              );
              await removeIfPresent(
                pendingManifestPath(
                  input.config.mediaDirectory,
                  externalEventId,
                ),
              );
              restored.delete(externalEventId);
            }
          }
          pendingAttachmentFiles.clear();
          for (const [externalEventId, files] of restored) {
            pendingAttachmentFiles.set(externalEventId, files);
          }
          await cleanupIMessageMediaDirectory(
            input.config.mediaDirectory,
            new Set([...restored.values()].flat()),
          );
        }
        cursor = await input.database.readStartupCursor();
      } catch {
        imsgPath = null;
        throw new Error("imessage_full_disk_access_required");
      }
      timer = schedule(() => {
        void pollOnce().catch(() => undefined);
      }, input.config.pollMilliseconds);
    },

    pollOnce,

    async acknowledgeInbound(
      externalEventId: string,
    ): Promise<void> {
      const files = pendingAttachmentFiles.get(externalEventId);
      if (!files) return;
      await Promise.allSettled(
        files.map((filePath) => unlink(filePath)),
      );
      pendingAttachmentFiles.delete(externalEventId);
      await removeIfPresent(
        pendingManifestPath(
          input.config.mediaDirectory,
          externalEventId,
        ),
      );
      await syncDirectory(input.config.mediaDirectory);
    },

    async preparePendingInbound(
      frame: RunnerInboundFrame,
    ): Promise<void> {
      if (
        frame.connectionId !== input.config.connectionId
        || frame.payload.attachments.length === 0
      ) {
        return;
      }
      if (!input.transferAttachment) {
        throw new Error(
          "imessage_attachment_transfer_unavailable",
        );
      }
      const files = pendingAttachmentFiles.get(
        frame.payload.externalEventId,
      );
      if (
        !files
        || files.length !== frame.payload.attachments.length
      ) {
        throw new Error(
          "imessage_pending_attachment_missing",
        );
      }
      for (
        let index = 0;
        index < frame.payload.attachments.length;
        index += 1
      ) {
        const descriptor = frame.payload.attachments[index];
        const filePath = files[index];
        if (
          !descriptor
          || !filePath
          || !descriptor.fileName
          || !descriptor.mimeType
          || descriptor.source.kind !== "node_transfer"
          || !descriptor.source.transferId
        ) {
          throw new Error(
            "imessage_pending_attachment_invalid",
          );
        }
        const transferred = await input.transferAttachment({
          connectionId: input.config.connectionId,
          externalEventId:
            frame.payload.externalEventId,
          externalAttachmentId:
            descriptor.externalAttachmentId,
          fileName: descriptor.fileName,
          mimeType: descriptor.mimeType,
          bytes: await readFile(filePath),
        });
        if (
          transferred.transferId
            !== descriptor.source.transferId
        ) {
          throw new Error(
            "imessage_pending_attachment_mismatch",
          );
        }
      }
    },

    async send(
      frame: RunnerSendFrame,
    ): Promise<ChannelNodeSendOutcome> {
      if (
        stopped
        || !imsgPath
        || frame.connectionId !== input.config.connectionId
      ) {
        return {
          status: "failed",
          errorCode: "imessage_transport_unavailable",
        };
      }
      const handle = frame.payload.recipient.externalUserId;
      if (
        frame.payload.recipient.chatType !== "direct"
        || !handle
      ) {
        return {
          status: "failed",
          errorCode: "imessage_group_unsupported",
        };
      }
      if (!isSafeHandle(handle)) {
        return {
          status: "failed",
          errorCode: "imessage_recipient_invalid",
        };
      }
      try {
        const result = await execute(
          imsgPath,
          [
            "send",
            "--to",
            handle,
            "--text",
            `${input.config.botPrefix}${frame.payload.body}`,
          ],
        );
        return {
          status: "sent",
          externalMessageId:
            parseExternalMessageId(result.stdout)
            ?? `imessage:delivery:${frame.deliveryId}`,
          platformSentAt: now().toISOString(),
          rawSummary: { transport: "imsg" },
        };
      } catch {
        return {
          status: "failed",
          errorCode: "imessage_send_outcome_unknown",
        };
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      await polling?.catch(() => undefined);
      cursor = null;
      imsgPath = null;
    },
  };
}

export async function materializeIMessageAttachments(
  input: Readonly<{
    eventId: string;
    attachments: readonly IMessageAttachment[];
    attachmentRoot: string;
    homeDirectory?: string;
    mediaDirectory: string;
    maxDecodedSize: number;
  }>,
): Promise<RunnerInboundDraft["payload"]["attachments"]> {
  if (input.attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error("imessage_attachment_count_invalid");
  }
  if (input.attachments.length === 0) return [];
  const root = await realpath(input.attachmentRoot);
  await mkdir(input.mediaDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(input.mediaDirectory, 0o700);
  const mediaDirectory = await realpath(input.mediaDirectory);
  const descriptors:
    RunnerInboundDraft["payload"]["attachments"][number][] = [];
  const createdPaths: string[] = [];
  let totalBytes = 0;
  try {
    for (const attachment of input.attachments) {
    const sourcePath = attachment.path.startsWith("~/")
      ? path.join(
          input.homeDirectory ?? homedir(),
          attachment.path.slice(2),
        )
      : attachment.path;
    const source = await realpath(sourcePath);
    if (!isWithin(source, root)) {
      throw new Error("imessage_attachment_path_invalid");
    }
    const fileName = safeFileName(
      attachment.fileName ?? path.basename(source),
    );
    const extension = path.extname(fileName).toLowerCase();
    const expectedMime = MIME_BY_EXTENSION[extension];
    if (
      !expectedMime
      || (
        attachment.mimeType
        && attachment.mimeType.toLowerCase() !== expectedMime
      )
    ) {
      throw new Error("imessage_attachment_type_blocked");
    }
    const handle = await open(
      source,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("imessage_attachment_file_invalid");
      }
      if (
        metadata.size <= 0
        || metadata.size > input.maxDecodedSize
        || metadata.size > MAX_FILE_ATTACHMENT_BYTES
      ) {
        throw new Error("imessage_attachment_too_large");
      }
      if (
        attachment.sizeBytes !== null
        && attachment.sizeBytes !== metadata.size
      ) {
        throw new Error("imessage_attachment_size_mismatch");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new Error("imessage_attachment_message_too_large");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.byteLength > input.maxDecodedSize) {
      throw new Error("imessage_attachment_too_large");
    }
    const destination = path.join(
      mediaDirectory,
      `${randomUUID()}${extension}`,
    );
    if (!isWithin(destination, mediaDirectory)) {
      throw new Error("imessage_attachment_path_invalid");
    }
    const output = await open(
      destination,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    createdPaths.push(destination);
    try {
      await output.writeFile(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    await syncDirectory(mediaDirectory);
    descriptors.push({
      externalAttachmentId:
        `imessage:attachment:${attachment.guid}`,
      fileName,
      mimeType: expectedMime,
      sizeBytes: bytes.byteLength,
      source: {
        kind: "file",
        localPath: destination,
        eventId: input.eventId,
      },
    });
    }
  } catch (error) {
    await Promise.allSettled(
      createdPaths.map((filePath) => unlink(filePath)),
    );
    throw error;
  }
  return descriptors;
}

function stableIMessageErrorCode(error: unknown): string {
  return error instanceof Error
    && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : "imessage_row_rejected";
}

function isTransientIMessageRowError(
  errorCode: string,
): boolean {
  return errorCode === "imessage_transport_not_started"
    || errorCode === "node_connection_not_bound"
    || errorCode.startsWith("channel_node_")
    || errorCode.startsWith("node_attachment_");
}

async function cleanupIMessageMediaDirectory(
  directory: string,
  retainedFiles: ReadonlySet<string>,
): Promise<void> {
  await mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(directory, 0o700);
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const resolvedDirectory = await realpath(directory);
  await syncDirectory(path.dirname(resolvedDirectory));
  await Promise.allSettled(
    entries
      .filter((entry) =>
        entry.isFile()
        && (
          (
            /^[0-9a-f-]{36}\.(?:jpe?g|png|webp|pdf|txt|md|json|csv)$/iu
              .test(entry.name)
            && !retainedFiles.has(
              path.join(resolvedDirectory, entry.name),
            )
          )
          || /^\.pending-[a-f0-9]{64}\.json\..+\.tmp$/u
            .test(entry.name)
        )
      )
      .map((entry) =>
        unlink(path.join(directory, entry.name))
      ),
  );
  await syncDirectory(resolvedDirectory);
}

type PendingAttachmentManifest = Readonly<{
  version: 1;
  externalEventId: string;
  files: readonly string[];
}>;

async function persistPendingIMessageAttachments(
  input: Readonly<{
    directory: string;
    externalEventId: string;
    files: readonly string[];
  }>,
): Promise<void> {
  await mkdir(input.directory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(input.directory, 0o700);
  const directory = await realpath(input.directory);
  const fileNames = input.files.map((file) => {
    if (
      path.dirname(file) !== directory
      || !isIMessageMediaFileName(path.basename(file))
    ) {
      throw new Error("imessage_pending_attachment_invalid");
    }
    return path.basename(file);
  });
  if (fileNames.length < 1 || fileNames.length > 4) {
    throw new Error("imessage_pending_attachment_invalid");
  }
  const manifest: PendingAttachmentManifest = {
    version: 1,
    externalEventId: input.externalEventId,
    files: fileNames,
  };
  const target = pendingManifestPath(
    directory,
    input.externalEventId,
  );
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(directory);
}

async function restorePendingIMessageAttachments(
  directoryInput: string,
): Promise<Map<string, string[]>> {
  await mkdir(directoryInput, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(directoryInput, 0o700);
  const directory = await realpath(directoryInput);
  const restored = new Map<string, string[]>();
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (
      !entry.isFile()
      || !/^\.pending-[a-f0-9]{64}\.json$/u.test(entry.name)
    ) {
      continue;
    }
    const manifestPath = path.join(directory, entry.name);
    const metadata = await lstat(manifestPath);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > 64 * 1024
    ) {
      throw new Error("imessage_pending_attachment_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new Error("imessage_pending_attachment_invalid");
    }
    const manifest = parsePendingAttachmentManifest(parsed);
    if (
      pendingManifestPath(
        directory,
        manifest.externalEventId,
      ) !== manifestPath
    ) {
      throw new Error("imessage_pending_attachment_invalid");
    }
    restored.set(
      manifest.externalEventId,
      manifest.files.map((fileName) =>
        path.join(directory, fileName)
      ),
    );
  }
  return restored;
}

function parsePendingAttachmentManifest(
  value: unknown,
): PendingAttachmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("imessage_pending_attachment_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.externalEventId !== "string"
    || record.externalEventId.length < 1
    || record.externalEventId.length > 1_024
    || !Array.isArray(record.files)
    || record.files.length < 1
    || record.files.length > 4
    || record.files.some((file) =>
      typeof file !== "string"
      || !isIMessageMediaFileName(file)
    )
  ) {
    throw new Error("imessage_pending_attachment_invalid");
  }
  return record as PendingAttachmentManifest;
}

function pendingManifestPath(
  directory: string,
  externalEventId: string,
): string {
  if (
    externalEventId.length < 1
    || externalEventId.length > 1_024
  ) {
    throw new Error("imessage_pending_attachment_invalid");
  }
  const digest = createHash("sha256")
    .update(externalEventId, "utf8")
    .digest("hex");
  return path.join(directory, `.pending-${digest}.json`);
}

function isIMessageMediaFileName(value: string): boolean {
  return /^[0-9a-f-]{36}\.(?:jpe?g|png|webp|pdf|txt|md|json|csv)$/iu
    .test(value);
}

async function removeIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
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

async function defaultAssertExecutable(
  filePath: string,
): Promise<void> {
  await access(filePath, constants.X_OK);
}

async function defaultAssertDatabaseReadable(
  filePath: string,
): Promise<void> {
  await access(filePath, constants.R_OK);
}

async function defaultFindExecutable(
  name: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/which",
      [name],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const resolved = String(stdout).trim();
    return path.isAbsolute(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function executeCommand(
  file: string,
  args: readonly string[],
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

function numericRowId(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("imessage_rowid_invalid");
  }
  return parsed;
}

function isSafeHandle(value: string): boolean {
  return value.length > 0
    && value.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseExternalMessageId(stdout: string): string | null {
  if (stdout.length > 16_384) return null;
  let guid: unknown;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    guid = parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).guid
      : null;
  } catch {
    guid = null;
  }
  return typeof guid === "string"
    && /^[A-Za-z0-9_.:-]{1,512}$/u.test(guid)
    ? `imessage:guid:${guid}`
    : null;
}

function safeFileName(value: string): string {
  const base = path.basename(value);
  if (
    base.length === 0
    || base.length > 255
    || base === "."
    || base === ".."
    || /[\u0000-\u001f\u007f]/u.test(base)
  ) {
    throw new Error("imessage_attachment_name_invalid");
  }
  return base;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative);
}
