import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { deleteAttachment } from "@/server/attachments/storage";
import type { DbMessageAttachment } from "@/server/db/repositories";

export const ATTACHMENT_DRAFT_MAX_AGE_HOURS = 24;
export const ATTACHMENT_CLEANUP_BATCH_SIZE = 100;
export const ATTACHMENT_TEMPORARY_FILE_LEASE_MS = 15 * 60 * 1000;
export const ATTACHMENT_ORPHAN_FILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const UUID_V4_FRAGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ATOMIC_TEMPORARY_FILE_PATTERN = new RegExp(
  `^\\.${UUID_V4_FRAGMENT}\\.${UUID_V4_FRAGMENT}\\.tmp$`,
  "i",
);
const FINAL_ATTACHMENT_FILE_PATTERN = new RegExp(`^${UUID_V4_FRAGMENT}$`, "i");

type AttachmentCleanupRepositories = {
  messageAttachments: {
    claimExpiredDrafts(hours: number, limit?: number): Promise<DbMessageAttachment[]>;
    deleteDraft(userId: string, attachmentId: string, deletionClaimToken: string): Promise<boolean>;
    releaseDeletionClaim(
      userId: string,
      attachmentId: string,
      deletionClaimToken: string,
      errorCode: string,
    ): Promise<boolean>;
    listExistingStorageKeys(storageKeys: string[]): Promise<string[]>;
  };
};

type CleanupLogger = Pick<Console, "info" | "error">;

export type AttachmentCleanupResult = {
  claimed: number;
  deleted: number;
  failed: number;
  staleClaims: number;
  temporaryFiles: {
    deleted: number;
    failed: number;
  };
  orphanedFiles: {
    deleted: number;
    failed: number;
  };
};

export async function cleanupStaleAttachments(options: {
  repositories: AttachmentCleanupRepositories;
  storageDirectory: string;
  deleteFile?: typeof deleteAttachment;
  now?: () => Date;
  logger?: CleanupLogger;
}): Promise<AttachmentCleanupResult> {
  const deleteFile = options.deleteFile ?? deleteAttachment;
  const logger = options.logger ?? console;
  const result: AttachmentCleanupResult = {
    claimed: 0,
    deleted: 0,
    failed: 0,
    staleClaims: 0,
    temporaryFiles: { deleted: 0, failed: 0 },
    orphanedFiles: { deleted: 0, failed: 0 },
  };

  let claimed: DbMessageAttachment[] = [];
  try {
    claimed = await options.repositories.messageAttachments.claimExpiredDrafts(
      ATTACHMENT_DRAFT_MAX_AGE_HOURS,
      ATTACHMENT_CLEANUP_BATCH_SIZE,
    );
    result.claimed = claimed.length;
  } catch {
    result.failed += 1;
  }

  for (const attachment of claimed) {
    const token = attachment.deletionClaimToken;
    if (!token) {
      result.failed += 1;
      logger.error(`Attachment cleanup item ${attachment.id}: stage=claim code=attachment_claim_token_missing.`);
      continue;
    }

    try {
      await deleteFile(options.storageDirectory, attachment.storageKey);
      const deleted = await options.repositories.messageAttachments.deleteDraft(
        attachment.userId,
        attachment.id,
        token,
      );
      if (deleted) {
        result.deleted += 1;
      } else {
        result.staleClaims += 1;
      }
    } catch {
      result.failed += 1;
      logger.error(`Attachment cleanup item ${attachment.id}: stage=delete code=attachment_cleanup_failed.`);
      try {
        const released = await options.repositories.messageAttachments.releaseDeletionClaim(
          attachment.userId,
          attachment.id,
          token,
          "attachment_cleanup_failed",
        );
        if (!released) {
          logger.error(`Attachment cleanup item ${attachment.id}: stage=release code=attachment_claim_not_owned.`);
        }
      } catch {
        logger.error(`Attachment cleanup item ${attachment.id}: stage=release code=attachment_claim_release_failed.`);
      }
    }
  }

  const now = options.now?.() ?? new Date();
  result.temporaryFiles = await cleanupStaleTemporaryFiles(options.storageDirectory, now);
  result.orphanedFiles = await cleanupOrphanedFinalFiles(
    options.repositories,
    options.storageDirectory,
    now,
  );

  if (result.failed > 0 || result.temporaryFiles.failed > 0 || result.orphanedFiles.failed > 0) {
    logger.error(
      `Attachment cleanup: claimed ${result.claimed}, deleted ${result.deleted}, stale ${result.staleClaims}, failed ${result.failed}; temporary deleted ${result.temporaryFiles.deleted}, failed ${result.temporaryFiles.failed}; orphaned deleted ${result.orphanedFiles.deleted}, failed ${result.orphanedFiles.failed}.`,
    );
  } else if (result.deleted > 0 || result.temporaryFiles.deleted > 0 || result.orphanedFiles.deleted > 0) {
    logger.info(
      `Attachment cleanup: deleted ${result.deleted} draft(s), ${result.temporaryFiles.deleted} temporary file(s), and ${result.orphanedFiles.deleted} orphaned file(s).`,
    );
  }

  return result;
}

async function cleanupOrphanedFinalFiles(
  repositories: AttachmentCleanupRepositories,
  storageDirectory: string,
  now: Date,
): Promise<{ deleted: number; failed: number }> {
  let entries;
  try {
    entries = await readdir(storageDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return { deleted: 0, failed: 0 };
    return { deleted: 0, failed: 1 };
  }

  const candidates: string[] = [];
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !FINAL_ATTACHMENT_FILE_PATTERN.test(entry.name)) continue;
    try {
      const metadata = await lstat(path.join(storageDirectory, entry.name));
      if (now.getTime() - metadata.mtimeMs >= ATTACHMENT_ORPHAN_FILE_MIN_AGE_MS) {
        candidates.push(entry.name);
      }
    } catch (error) {
      if (!isMissingFile(error)) failed += 1;
    }
  }
  if (candidates.length === 0) return { deleted: 0, failed };

  const referenced = new Set<string>();
  try {
    for (let offset = 0; offset < candidates.length; offset += ATTACHMENT_CLEANUP_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + ATTACHMENT_CLEANUP_BATCH_SIZE);
      const existing = await repositories.messageAttachments.listExistingStorageKeys(batch);
      existing.forEach((storageKey) => referenced.add(storageKey));
    }
  } catch {
    return { deleted: 0, failed: failed + 1 };
  }

  let deleted = 0;
  for (const storageKey of candidates) {
    if (deleted >= ATTACHMENT_CLEANUP_BATCH_SIZE) break;
    if (referenced.has(storageKey)) continue;
    try {
      await unlink(path.join(storageDirectory, storageKey));
      deleted += 1;
    } catch (error) {
      if (!isMissingFile(error)) failed += 1;
    }
  }
  return { deleted, failed };
}

async function cleanupStaleTemporaryFiles(
  storageDirectory: string,
  now: Date,
): Promise<{ deleted: number; failed: number }> {
  let entries;
  try {
    entries = await readdir(storageDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return { deleted: 0, failed: 0 };
    return { deleted: 0, failed: 1 };
  }

  let deleted = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !ATOMIC_TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
    const temporaryPath = path.join(storageDirectory, entry.name);
    try {
      const metadata = await lstat(temporaryPath);
      if (now.getTime() - metadata.mtimeMs < ATTACHMENT_TEMPORARY_FILE_LEASE_MS) continue;
      await unlink(temporaryPath);
      deleted += 1;
    } catch (error) {
      if (isMissingFile(error)) continue;
      failed += 1;
    }
  }
  return { deleted, failed };
}

export function startAttachmentCleanupScheduler(options: {
  run: () => Promise<unknown>;
  intervalMs?: number;
  logger?: Pick<Console, "error">;
}): {
  initialRun: Promise<void>;
  stop: () => Promise<void>;
} {
  const intervalMs = options.intervalMs ?? ATTACHMENT_CLEANUP_INTERVAL_MS;
  const logger = options.logger ?? console;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(execute, intervalMs);
    timer.unref?.();
  };
  const execute = () => {
    running = options.run()
      .catch(() => {
        logger.error("Attachment cleanup job failed.");
      })
      .then(schedule);
    return running;
  };

  const initialRun = execute();
  return {
    initialRun,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
