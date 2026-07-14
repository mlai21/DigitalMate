import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_CLEANUP_INTERVAL_MS,
  cleanupStaleAttachments,
  startAttachmentCleanupScheduler,
} from "@/server/attachments/cleanup";
import type { DbMessageAttachment } from "@/server/db/repositories";

const roots: string[] = [];

function claimedAttachment(
  id: string,
  deletionClaimToken: string,
): DbMessageAttachment {
  const timestamp = new Date("2026-07-13T00:00:00.000Z");
  return {
    id,
    userId: "00000000-0000-4000-8000-000000000001",
    messageId: null,
    kind: "document",
    fileName: "private.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    storageKey: "30000000-0000-4000-8000-000000000001",
    extractedText: "private document contents",
    textTruncated: false,
    status: "deleting",
    errorCode: null,
    deletionClaimToken,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createRepositories(attachments: DbMessageAttachment[]) {
  return {
    messageAttachments: {
      claimExpiredDrafts: vi.fn(async () => attachments),
      deleteDraft: vi.fn(async () => true),
      releaseDeletionClaim: vi.fn(async () => true),
      listExistingStorageKeys: vi.fn(async (storageKeys: string[]) => storageKeys),
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stale attachment cleanup", () => {
  it("deletes every claimed file and row with the same deletion token", async () => {
    const first = claimedAttachment(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
    );
    const second = {
      ...claimedAttachment(
        "10000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000002",
      ),
      storageKey: "30000000-0000-4000-8000-000000000002",
    };
    const repositories = createRepositories([first, second]);
    const deleteFile = vi.fn(async () => undefined);

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: "/private/attachments",
      deleteFile,
    });

    expect(repositories.messageAttachments.claimExpiredDrafts).toHaveBeenCalledWith(24, 100);
    expect(deleteFile).toHaveBeenNthCalledWith(1, "/private/attachments", first.storageKey);
    expect(deleteFile).toHaveBeenNthCalledWith(2, "/private/attachments", second.storageKey);
    expect(repositories.messageAttachments.deleteDraft).toHaveBeenNthCalledWith(
      1,
      first.userId,
      first.id,
      first.deletionClaimToken,
    );
    expect(repositories.messageAttachments.deleteDraft).toHaveBeenNthCalledWith(
      2,
      second.userId,
      second.id,
      second.deletionClaimToken,
    );
    expect(repositories.messageAttachments.releaseDeletionClaim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 2, deleted: 2, failed: 0 });
  });

  it("releases a failed item with its token and continues without logging private contents", async () => {
    const first = claimedAttachment(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
    );
    const second = {
      ...claimedAttachment(
        "10000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000002",
      ),
      storageKey: "30000000-0000-4000-8000-000000000002",
    };
    const repositories = createRepositories([first, second]);
    const deleteFile = vi
      .fn<(root: string, storageKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("private document contents"))
      .mockResolvedValueOnce(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: "/private/attachments",
      deleteFile,
      logger,
    });

    expect(repositories.messageAttachments.releaseDeletionClaim).toHaveBeenCalledExactlyOnceWith(
      first.userId,
      first.id,
      first.deletionClaimToken,
      "attachment_cleanup_failed",
    );
    expect(repositories.messageAttachments.deleteDraft).toHaveBeenCalledExactlyOnceWith(
      second.userId,
      second.id,
      second.deletionClaimToken,
    );
    expect(result).toMatchObject({ claimed: 2, deleted: 1, failed: 1 });
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.error.mock.calls])).not.toContain(
      "private document contents",
    );
  });

  it("does not release a newer claim when an old token loses the final delete fence", async () => {
    const attachment = claimedAttachment(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
    );
    const repositories = createRepositories([attachment]);
    repositories.messageAttachments.deleteDraft.mockResolvedValue(false);

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: "/private/attachments",
      deleteFile: vi.fn(async () => undefined),
    });

    expect(repositories.messageAttachments.deleteDraft).toHaveBeenCalledWith(
      attachment.userId,
      attachment.id,
      attachment.deletionClaimToken,
    );
    expect(repositories.messageAttachments.releaseDeletionClaim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, deleted: 0, staleClaims: 1 });
  });

  it("treats an already missing private file as an idempotent deletion", async () => {
    const root = await createTemporaryRoot();
    const attachment = claimedAttachment(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
    );
    const repositories = createRepositories([attachment]);

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: root,
    });

    expect(repositories.messageAttachments.deleteDraft).toHaveBeenCalledWith(
      attachment.userId,
      attachment.id,
      attachment.deletionClaimToken,
    );
    expect(repositories.messageAttachments.releaseDeletionClaim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, deleted: 1, failed: 0 });
  });

  it("removes only atomic temporary files older than the safe lease", async () => {
    const root = await createTemporaryRoot();
    const oldTemp = ".30000000-0000-4000-8000-000000000001.40000000-0000-4000-8000-000000000001.tmp";
    const freshTemp = ".30000000-0000-4000-8000-000000000002.40000000-0000-4000-8000-000000000002.tmp";
    const unrelatedTemp = "upload.tmp";
    const finalFile = "30000000-0000-4000-8000-000000000003";
    await Promise.all([
      writeFile(path.join(root, oldTemp), "old"),
      writeFile(path.join(root, freshTemp), "fresh"),
      writeFile(path.join(root, unrelatedTemp), "unrelated"),
      writeFile(path.join(root, finalFile), "final"),
    ]);
    await utimes(path.join(root, oldTemp), new Date("2026-07-14T00:00:00.000Z"), new Date("2026-07-14T00:00:00.000Z"));
    await utimes(path.join(root, freshTemp), new Date("2026-07-14T00:29:00.000Z"), new Date("2026-07-14T00:29:00.000Z"));
    const repositories = createRepositories([]);

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: root,
      now: () => new Date("2026-07-14T00:30:00.000Z"),
    });

    expect((await readdir(root)).sort()).toEqual([finalFile, freshTemp, unrelatedTemp].sort());
    expect(result.temporaryFiles).toMatchObject({ deleted: 1, failed: 0 });
  });

  it("deletes only old final files that no database attachment references", async () => {
    const root = await createTemporaryRoot();
    const orphan = "30000000-0000-4000-8000-000000000010";
    const referenced = "30000000-0000-4000-8000-000000000011";
    const fresh = "30000000-0000-4000-8000-000000000012";
    await Promise.all([
      writeFile(path.join(root, orphan), "orphan"),
      writeFile(path.join(root, referenced), "referenced"),
      writeFile(path.join(root, fresh), "fresh"),
    ]);
    const old = new Date("2026-07-12T00:00:00.000Z");
    await Promise.all([
      utimes(path.join(root, orphan), old, old),
      utimes(path.join(root, referenced), old, old),
    ]);
    const repositories = createRepositories([]);
    repositories.messageAttachments.listExistingStorageKeys.mockResolvedValue([referenced]);

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: root,
      now: () => new Date("2026-07-14T00:30:00.000Z"),
    });

    expect(repositories.messageAttachments.listExistingStorageKeys).toHaveBeenCalledWith([
      orphan,
      referenced,
    ]);
    expect((await readdir(root)).sort()).toEqual([fresh, referenced].sort());
    expect(result.orphanedFiles).toEqual({ deleted: 1, failed: 0 });
  });

  it("does not starve an orphan behind one hundred safely aged referenced files", async () => {
    const root = await createTemporaryRoot();
    const referenced = Array.from({ length: 100 }, (_, index) =>
      `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );
    const orphan = "30000000-0000-4000-8000-000000000100";
    await Promise.all([...referenced, orphan].map((storageKey) =>
      writeFile(path.join(root, storageKey), storageKey),
    ));
    const old = new Date("2026-07-12T00:00:00.000Z");
    await Promise.all([...referenced, orphan].map((storageKey) =>
      utimes(path.join(root, storageKey), old, old),
    ));
    const repositories = createRepositories([]);
    repositories.messageAttachments.listExistingStorageKeys.mockImplementation(async (storageKeys) =>
      storageKeys.filter((storageKey) => referenced.includes(storageKey)),
    );

    const result = await cleanupStaleAttachments({
      repositories,
      storageDirectory: root,
      now: () => new Date("2026-07-14T00:30:00.000Z"),
    });

    expect(repositories.messageAttachments.listExistingStorageKeys).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual(expect.arrayContaining(referenced));
    expect(await readdir(root)).not.toContain(orphan);
    expect(result.orphanedFiles).toEqual({ deleted: 1, failed: 0 });
  });
});

describe("attachment cleanup scheduler", () => {
  it("runs on startup, repeats hourly without overlap, and stops its timer", async () => {
    vi.useFakeTimers();
    let finishCurrentRun: (() => void) | undefined;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishCurrentRun = resolve;
      });
    });

    const scheduler = startAttachmentCleanupScheduler({ run });
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_CLEANUP_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);

    finishCurrentRun?.();
    await scheduler.initialRun;
    await vi.advanceTimersByTimeAsync(ATTACHMENT_CLEANUP_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);

    finishCurrentRun?.();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(ATTACHMENT_CLEANUP_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("contains a failed run and keeps the hourly schedule alive", async () => {
    vi.useFakeTimers();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    const logger = { error: vi.fn() };

    const scheduler = startAttachmentCleanupScheduler({ run, logger });
    await scheduler.initialRun;
    expect(logger.error).toHaveBeenCalledWith("Attachment cleanup job failed.");

    await vi.advanceTimersByTimeAsync(ATTACHMENT_CLEANUP_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

async function createTemporaryRoot() {
  const root = path.join(os.tmpdir(), `digitalmate-cleanup-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}
