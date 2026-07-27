import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { AgentScope } from "@/server/agents/types";
import {
  inspectEncryptedBackupArchive,
  writeEncryptedBackupArchive,
} from "@/server/admin/backups/archive";
import type {
  BackupRepository,
  BackupRestorePreview,
} from "@/server/admin/backups/repository";
import {
  type BackupArchiveContents,
  type BackupEncryptionKey,
  type BackupErrorCode,
  type BackupJob,
} from "@/server/admin/backups/types";
import type {
  AdminBackupDetail,
  AdminBackupMeta,
  AdminBackupsService,
} from "@/server/admin/compat/handlers/backups";
import { readAttachment } from "@/server/attachments/storage";
import { validateAttachmentFile } from "@/server/attachments/validation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class BackupServiceError extends Error {
  readonly code: BackupErrorCode | string;

  constructor(code: BackupErrorCode | string) {
    super(code);
    this.name = "BackupServiceError";
    this.code = code;
  }
}

export type BackupService = AdminBackupsService &
  Readonly<{
    preview(
      scope: AgentScope,
      backupId: string,
      signal?: AbortSignal,
    ): Promise<BackupRestorePreview>;
  }>;

export function createAdminBackupService(input: Readonly<{
  repository: BackupRepository;
  encryptionKey: BackupEncryptionKey;
  channelSecretKeyFingerprint: string | null;
  backupStorageRoot: string;
  attachmentStorageRoot: string;
  matrixStorageRoot: string;
  retentionDays: number;
  stopConnections: (
    scope: AgentScope,
  ) => Promise<() => void>;
}>): BackupService {
  const inspectJob = async (
    scope: AgentScope,
    backupId: string,
  ) => {
    const job = await requireReadyJob(
      input.repository,
      scope,
      backupId,
    );
    const bytes = await readArchiveBytes(
      input.backupStorageRoot,
      job,
    );
    const inspected = inspectForScope(
      bytes,
      input.encryptionKey,
      scope,
      input.channelSecretKeyFingerprint,
    );
    return { job, bytes, inspected };
  };

  return {
    async list(scope) {
      const jobs = await input.repository.listJobs(scope);
      return jobs
        .filter((job) => job.status === "ready")
        .map(toBackupMeta);
    },
    async get(scope, backupId) {
      const { job, inspected } = await inspectJob(
        scope,
        backupId,
      );
      return toBackupDetail(job, inspected.contents);
    },
    async create(scope, createInput, signal) {
      const expiresAt = new Date(
        Date.now()
        + input.retentionDays * 86_400_000,
      );
      const job = await input.repository.createJob({
        scope,
        name: createInput.name,
        description: createInput.description,
        kind: "disaster_recovery",
        expiresAt,
      });
      await input.repository.setJobRunning(scope, job.id);
      try {
        signal?.throwIfAborted();
        const snapshot = await input.repository.snapshot(
          scope,
          signal,
        );
        const attachments: Record<string, Buffer> = {};
        for (const file of snapshot.attachmentFiles) {
          signal?.throwIfAborted();
          attachments[file.storageKey] = await readAttachment(
            input.attachmentStorageRoot,
            file.storageKey,
          );
        }
        const matrixStores: Record<string, Buffer> = {};
        for (const connectionId of snapshot.matrixConnectionIds) {
          signal?.throwIfAborted();
          const storePath = matrixStorePath(
            input.matrixStorageRoot,
            connectionId,
          );
          try {
            matrixStores[connectionId] = await readFile(storePath);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        const contents: BackupArchiveContents = {
          manifest: {
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            source: scope,
            channelSecretKeyFingerprint:
              input.channelSecretKeyFingerprint,
            tables: Object.fromEntries(
              Object.entries(snapshot.tables).map(
                ([table, rows]) => [
                  table,
                  { rows: rows.length, sha256: "pending" },
                ],
              ),
            ),
            attachments: snapshot.attachmentFiles.map(
              (file) => ({
                storageKey: file.storageKey,
                mimeType: file.mimeType,
                size: attachments[file.storageKey]!.length,
                sha256: "pending",
              }),
            ),
            matrixStores: Object.entries(matrixStores).map(
              ([connectionId, bytes]) => ({
                connectionId,
                size: bytes.length,
                sha256: "pending",
              }),
            ),
          },
          tables: snapshot.tables,
          attachments,
          matrixStores,
        };
        const stored = await writeEncryptedBackupArchive({
          rootDirectory: input.backupStorageRoot,
          storageKey: job.id,
          contents,
          encryptionKey: input.encryptionKey,
        });
        const completed = await input.repository.completeJob(
          scope,
          job.id,
          stored,
        );
        return toBackupMeta(completed);
      } catch (error) {
        await removeArchive(
          input.backupStorageRoot,
          job.id,
        ).catch(() => undefined);
        await input.repository.failJob(
          scope,
          job.id,
          errorCode(error),
        ).catch(() => undefined);
        throw error;
      }
    },
    async preview(scope, backupId, signal) {
      signal?.throwIfAborted();
      const { inspected } = await inspectJob(
        scope,
        backupId,
      );
      return input.repository.previewRestore(
        scope,
        inspected.contents.tables,
        signal,
      );
    },
    async restore(scope, backupId, restoreInput, signal) {
      if (
        !restoreInput.confirmed
        || restoreInput.agentIds.length !== 1
        || restoreInput.agentIds[0] !== scope.agentId
      ) {
        throw new BackupServiceError(
          "backup_restore_confirmation_required",
        );
      }
      signal?.throwIfAborted();
      const { inspected } = await inspectJob(
        scope,
        backupId,
      );
      validateRestoredAttachments(inspected.contents);
      await input.repository.previewRestore(
        scope,
        inspected.contents.tables,
        signal,
      );
      const releaseConnections =
        await input.stopConnections(scope);
      try {
        await input.repository.restore(
          scope,
          inspected.contents.tables,
          backupId,
          () =>
            publishFilesAtomically({
              contents: inspected.contents,
              attachmentStorageRoot:
                input.attachmentStorageRoot,
              matrixStorageRoot: input.matrixStorageRoot,
            }),
          signal,
        );
      } finally {
        releaseConnections();
      }
      return {
        ok: true,
        preserved_local_keys: [],
      };
    },
    async delete(scope, ids) {
      const deleted: string[] = [];
      const failed: { id: string; reason: string }[] = [];
      for (const id of ids) {
        const job = await input.repository.getJob(scope, id);
        if (!job) {
          failed.push({ id, reason: "backup_not_found" });
          continue;
        }
        try {
          if (job.storageKey) {
            await removeArchive(
              input.backupStorageRoot,
              job.storageKey,
            );
          }
          const rows = await input.repository.deleteJobs(
            scope,
            [id],
          );
          if (rows.length !== 1) {
            throw new BackupServiceError(
              "backup_not_found",
            );
          }
          deleted.push(id);
        } catch (error) {
          failed.push({ id, reason: errorCode(error) });
        }
      }
      return { deleted, failed };
    },
    async export(scope, backupId) {
      const { job, bytes } = await inspectJob(
        scope,
        backupId,
      );
      return {
        bytes,
        fileName: `${safeBaseName(job.name)}.dmbackup`,
      };
    },
    async import(scope, file, signal) {
      signal?.throwIfAborted();
      if (
        file.size <= 0
        || file.size > 512 * 1024 * 1024
      ) {
        throw new BackupServiceError(
          "backup_archive_invalid",
        );
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      inspectForScope(
        bytes,
        input.encryptionKey,
        scope,
        input.channelSecretKeyFingerprint,
      );
      const expiresAt = new Date(
        Date.now()
        + input.retentionDays * 86_400_000,
      );
      const job = await input.repository.createJob({
        scope,
        name: safeBaseName(
          file.name.replace(/\.dmbackup$/iu, ""),
        ),
        description: "导入的 DigitalMate 灾难恢复包",
        kind: "imported",
        expiresAt,
      });
      await input.repository.setJobRunning(scope, job.id);
      try {
        const stored = await writeImportedArchive({
          rootDirectory: input.backupStorageRoot,
          storageKey: job.id,
          bytes,
        });
        return toBackupMeta(
          await input.repository.completeJob(
            scope,
            job.id,
            stored,
          ),
        );
      } catch (error) {
        await removeArchive(
          input.backupStorageRoot,
          job.id,
        ).catch(() => undefined);
        await input.repository.failJob(
          scope,
          job.id,
          errorCode(error),
        ).catch(() => undefined);
        throw error;
      }
    },
  };
}

async function requireReadyJob(
  repository: BackupRepository,
  scope: AgentScope,
  id: string,
): Promise<BackupJob> {
  const job = await repository.getJob(scope, id);
  if (!job) throw new BackupServiceError("backup_not_found");
  if (
    job.status !== "ready"
    || !job.storageKey
    || !job.checksum
    || job.sizeBytes === null
  ) {
    throw new BackupServiceError("backup_not_ready");
  }
  return job;
}

async function readArchiveBytes(
  rootDirectory: string,
  job: BackupJob,
): Promise<Buffer> {
  const storageKey = job.storageKey!;
  assertUuid(storageKey);
  const root = path.resolve(rootDirectory);
  const filePath = path.resolve(root, storageKey);
  assertContained(root, filePath);
  const bytes = await readFile(filePath);
  if (
    bytes.length !== job.sizeBytes
    || sha256(bytes) !== job.checksum
  ) {
    throw new BackupServiceError(
      "backup_checksum_mismatch",
    );
  }
  return bytes;
}

function toBackupMeta(job: BackupJob): AdminBackupMeta {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    created_at: job.createdAt.toISOString(),
    scope: {
      include_agents: true,
      include_global_config: true,
      include_secrets: true,
      include_skill_pool: true,
    },
    agent_count: 1,
    signature: job.checksum,
    accepted_via_trust: null,
  };
}

function toBackupDetail(
  job: BackupJob,
  contents: BackupArchiveContents,
): AdminBackupDetail {
  const files =
    Object.keys(contents.attachments).length
    + Object.keys(contents.matrixStores).length;
  const size =
    Object.values(contents.attachments)
      .reduce((total, bytes) => total + bytes.length, 0)
    + Object.values(contents.matrixStores)
      .reduce((total, bytes) => total + bytes.length, 0);
  const agent = contents.tables.digital_agents?.[0];
  return {
    ...toBackupMeta(job),
    workspace_stats: {
      [contents.manifest.source.agentId]: {
        files,
        size,
        name:
          typeof agent?.display_name === "string"
            ? agent.display_name
            : "DigitalMate",
      },
    },
  };
}

function validateRestoredAttachments(
  contents: BackupArchiveContents,
): void {
  const rows = contents.tables.message_attachments ?? [];
  const rowsByStorageKey = new Map(
    rows.map((row) => [row.storage_key, row]),
  );
  for (const descriptor of contents.manifest.attachments) {
    const row = rowsByStorageKey.get(descriptor.storageKey);
    const bytes = contents.attachments[descriptor.storageKey];
    if (
      !row
      || !bytes
      || typeof row.file_name !== "string"
      || typeof row.mime_type !== "string"
      || row.mime_type !== descriptor.mimeType
    ) {
      throw new BackupServiceError(
        "backup_attachment_invalid",
      );
    }
    try {
      validateAttachmentFile({
        fileName: row.file_name,
        declaredMime: row.mime_type,
        bytes,
      });
    } catch {
      throw new BackupServiceError(
        "backup_attachment_invalid",
      );
    }
  }
}

async function publishFilesAtomically(input: Readonly<{
  contents: BackupArchiveContents;
  attachmentStorageRoot: string;
  matrixStorageRoot: string;
}>): Promise<Readonly<{
  rollback(): Promise<void>;
  commit(): Promise<void>;
}>> {
  const operationId = randomUUID();
  const publications: Array<{
    target: string;
    staged: string;
    previous: string;
    hadPrevious: boolean;
  }> = [];
  const published: typeof publications = [];
  try {
    for (
      const [storageKey, bytes]
        of Object.entries(input.contents.attachments)
    ) {
      assertUuid(storageKey);
      const root = path.resolve(input.attachmentStorageRoot);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      publications.push({
        target: path.join(root, storageKey),
        staged: path.join(root, `.${storageKey}.${operationId}.restore`),
        previous: path.join(root, `.${storageKey}.${operationId}.previous`),
        hadPrevious: false,
      });
      await writePrivateFile(
        publications.at(-1)!.staged,
        bytes,
      );
    }
    for (
      const [connectionId, bytes]
        of Object.entries(input.contents.matrixStores)
    ) {
      const target = matrixStorePath(
        input.matrixStorageRoot,
        connectionId,
      );
      const directory = path.dirname(target);
      await mkdir(directory, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(directory, 0o700);
      publications.push({
        target,
        staged: `${target}.${operationId}.restore`,
        previous: `${target}.${operationId}.previous`,
        hadPrevious: false,
      });
      await writePrivateFile(
        publications.at(-1)!.staged,
        bytes,
      );
    }
    for (const publication of publications) {
      publication.hadPrevious = await exists(
        publication.target,
      );
      if (publication.hadPrevious) {
        await rename(
          publication.target,
          publication.previous,
        );
      }
      published.push(publication);
      await rename(publication.staged, publication.target);
    }
  } catch (error) {
    await rollbackPublications(published);
    await cleanupPublications(publications);
    throw error;
  }
  return {
    async rollback() {
      await rollbackPublications(published);
      await cleanupPublications(publications);
    },
    async commit() {
      await cleanupPublications(publications);
    },
  };
}

async function rollbackPublications(
  publications: readonly {
    target: string;
    previous: string;
    hadPrevious: boolean;
  }[],
): Promise<void> {
  for (const publication of [...publications].reverse()) {
    await unlink(publication.target).catch(() => undefined);
    if (publication.hadPrevious) {
      await rename(
        publication.previous,
        publication.target,
      ).catch(() => undefined);
    }
  }
}

async function cleanupPublications(
  publications: readonly {
    staged: string;
    previous: string;
  }[],
): Promise<void> {
  await Promise.all(
    publications.flatMap((publication) => [
      unlink(publication.staged).catch(() => undefined),
      unlink(publication.previous).catch(() => undefined),
    ]),
  );
}

async function writePrivateFile(
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImportedArchive(input: Readonly<{
  rootDirectory: string;
  storageKey: string;
  bytes: Buffer;
}>): Promise<Readonly<{
  storageKey: string;
  checksum: string;
  sizeBytes: number;
}>> {
  assertUuid(input.storageKey);
  const root = path.resolve(input.rootDirectory);
  const target = path.resolve(root, input.storageKey);
  assertContained(root, target);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writePrivateFile(target, input.bytes);
  return {
    storageKey: input.storageKey,
    checksum: sha256(input.bytes),
    sizeBytes: input.bytes.length,
  };
}

async function removeArchive(
  rootDirectory: string,
  storageKey: string,
): Promise<void> {
  assertUuid(storageKey);
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, storageKey);
  assertContained(root, target);
  await unlink(target).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

function matrixStorePath(
  rootDirectory: string,
  connectionId: string,
): string {
  assertUuid(connectionId);
  const root = path.resolve(rootDirectory);
  const target = path.resolve(
    root,
    connectionId,
    "crypto-store.bin",
  );
  assertContained(root, target);
  return target;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BackupServiceError(
      "backup_archive_invalid",
    );
  }
}

function assertContained(root: string, target: string): void {
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new BackupServiceError(
      "backup_archive_invalid",
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeBaseName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return safe.length > 0 ? safe.slice(0, 120) : "backup";
}

function errorCode(error: unknown): string {
  return error instanceof Error
    ? (
        "code" in error
        && typeof error.code === "string"
          ? error.code
          : error.message
      ).slice(0, 120)
    : "backup_failed";
}

function inspectForScope(
  bytes: Buffer,
  encryptionKey: BackupEncryptionKey,
  scope: AgentScope,
  channelSecretKeyFingerprint: string | null,
) {
  try {
    return inspectEncryptedBackupArchive(
      bytes,
      encryptionKey,
      {
        expectedScope: scope,
        expectedChannelSecretKeyFingerprint:
          channelSecretKeyFingerprint,
      },
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && typeof error.code === "string"
    ) {
      throw new BackupServiceError(error.code);
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && error.code === "ENOENT"
  );
}
