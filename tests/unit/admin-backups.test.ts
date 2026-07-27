import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  BackupArchiveError,
  createEncryptedBackupArchive,
  inspectEncryptedBackupArchive,
  writeEncryptedBackupArchive,
} from "@/server/admin/backups/archive";
import {
  BackupEncryptionKey,
  type BackupArchiveContents,
} from "@/server/admin/backups/types";
import {
  createAdminBackupService,
} from "@/server/admin/backups/service";
import type {
  BackupRepository,
} from "@/server/admin/backups/repository";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

function contents(): BackupArchiveContents {
  return {
    manifest: {
      formatVersion: 1,
      createdAt: "2026-07-27T00:00:00.000Z",
      source: scope,
      channelSecretKeyFingerprint: "sha256:channel-key",
      tables: {
        channel_connections: {
          rows: 1,
          sha256: "pending",
        },
        channel_secrets: {
          rows: 1,
          sha256: "pending",
        },
      },
      attachments: [
        {
          storageKey: "20000000-0000-4000-8000-000000000001",
          mimeType: "application/pdf",
          size: 7,
          sha256: "pending",
        },
      ],
      matrixStores: [
        {
          connectionId: "30000000-0000-4000-8000-000000000001",
          size: 6,
          sha256: "pending",
        },
      ],
    },
    tables: {
      channel_connections: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          user_id: scope.userId,
          agent_id: scope.agentId,
          enabled: false,
          config: {},
        },
      ],
      channel_secrets: [
        {
          connection_id:
            "30000000-0000-4000-8000-000000000001",
          field_name: "access_token",
          ciphertext: "c2FmZS1jaXBoZXJ0ZXh0",
          nonce: "bm9uY2Utb25seQ==",
          auth_tag: "YXV0aC10YWctb25seQ==",
          key_version: 1,
        },
      ],
    },
    attachments: {
      "20000000-0000-4000-8000-000000000001":
        Buffer.from("%PDF-ok"),
    },
    matrixStores: {
      "30000000-0000-4000-8000-000000000001":
        Buffer.from("matrix"),
    },
  };
}

describe("admin disaster-recovery archives", () => {
  it("外层加密并保留可恢复的渠道密文、附件与 Matrix 状态", () => {
    const key = BackupEncryptionKey.fromBase64(
      Buffer.alloc(32, 7).toString("base64"),
    );
    const wrongKey = BackupEncryptionKey.fromBase64(
      Buffer.alloc(32, 8).toString("base64"),
    );
    const archive = createEncryptedBackupArchive(
      contents(),
      key,
    );
    const rawText = archive.toString("utf8");

    expect(rawText).not.toMatch(
      /manifest\.json|super-secret|context_token|temporary_url|channel_connections/iu,
    );
    const inspected = inspectEncryptedBackupArchive(
      archive,
      key,
    );
    expect(inspected.entries).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "database/channel_secrets.json",
        "attachments/20000000-0000-4000-8000-000000000001",
        "matrix/connections/30000000-0000-4000-8000-000000000001/crypto-store.bin",
      ]),
    );
    expect(inspected.contents.tables.channel_secrets).toHaveLength(
      1,
    );
    expect(JSON.stringify(inspected.contents)).not.toContain(
      "super-secret",
    );
    expect(() =>
      inspectEncryptedBackupArchive(archive, wrongKey)
    ).toThrowError(
      expect.objectContaining<Partial<BackupArchiveError>>({
        code: "backup_authentication_failed",
      }),
    );
  });

  it("私有目录和 archive 使用 0700/0600，并且只返回 opaque storage key", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-backup-test-"),
    );
    try {
      const stored = await writeEncryptedBackupArchive({
        rootDirectory: root,
        storageKey:
          "40000000-0000-4000-8000-000000000001",
        contents: contents(),
        encryptionKey: BackupEncryptionKey.fromBase64(
          Buffer.alloc(32, 9).toString("base64"),
        ),
      });

      expect(stored).toMatchObject({
        storageKey:
          "40000000-0000-4000-8000-000000000001",
        sizeBytes: expect.any(Number),
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(stored).not.toHaveProperty("path");
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(root, stored.storageKey))).mode
          & 0o777,
      ).toBe(0o600);
      expect(
        (await readFile(path.join(root, stored.storageKey)))
          .toString("utf8"),
      ).not.toContain("manifest.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("拒绝跨 agent archive，显式重绑定也必须由恢复层单独处理", () => {
    const key = BackupEncryptionKey.fromBase64(
      Buffer.alloc(32, 3).toString("base64"),
    );
    const archive = createEncryptedBackupArchive(
      contents(),
      key,
    );

    expect(() =>
      inspectEncryptedBackupArchive(archive, key, {
        expectedScope: {
          ...scope,
          agentId:
            "10000000-0000-4000-8000-000000000099",
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<BackupArchiveError>>({
        code: "backup_agent_mismatch",
      }),
    );
  });

  it("数据库提交失败时恢复旧附件索引，并释放连接排空门", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-restore-test-"),
    );
    const backupRoot = path.join(root, "backups");
    const attachmentRoot = path.join(root, "attachments");
    const matrixRoot = path.join(root, "matrix");
    const backupId =
      "40000000-0000-4000-8000-000000000001";
    const storageKey =
      "20000000-0000-4000-8000-000000000001";
    const key = BackupEncryptionKey.fromBase64(
      Buffer.alloc(32, 6).toString("base64"),
    );
    const base = contents();
    const recoverable: BackupArchiveContents = {
      ...base,
      manifest: {
        ...base.manifest,
        attachments: [
          {
            storageKey,
            mimeType: "application/pdf",
            size: 8,
            sha256: "pending",
          },
        ],
      },
      tables: {
        ...base.tables,
        message_attachments: [
          {
            id: "50000000-0000-4000-8000-000000000001",
            user_id: scope.userId,
            agent_id: scope.agentId,
            message_id: null,
            kind: "document",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            size_bytes: 8,
            storage_key: storageKey,
            extracted_text: null,
            text_truncated: false,
            status: "ready",
            error_code: null,
            deletion_claim_token: null,
            created_at: "2026-07-27T00:00:00.000Z",
            updated_at: "2026-07-27T00:00:00.000Z",
          },
        ],
      },
      attachments: {
        [storageKey]: Buffer.from("%PDF-new"),
      },
    };
    try {
      await mkdir(attachmentRoot, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        path.join(attachmentRoot, storageKey),
        Buffer.from("old-private-file"),
        { mode: 0o600 },
      );
      const stored = await writeEncryptedBackupArchive({
        rootDirectory: backupRoot,
        storageKey: backupId,
        contents: recoverable,
        encryptionKey: key,
      });
      const previewRestore = vi.fn().mockResolvedValue({
        tables: {},
        attachments: 1,
        matrixStores: 1,
      });
      const restore = vi.fn(
        async (
          _scope,
          _tables,
          _backupId,
          publishFiles,
        ) => {
          const publication = await publishFiles();
          await publication.rollback();
          throw new Error("simulated_database_commit_failure");
        },
      );
      const repository = {
        getJob: vi.fn().mockResolvedValue({
          id: backupId,
          userId: scope.userId,
          agentId: scope.agentId,
          name: "daily",
          description: "",
          status: "ready",
          kind: "disaster_recovery",
          storageKey: backupId,
          checksum: stored.checksum,
          sizeBytes: stored.sizeBytes,
          errorCode: null,
          createdAt: new Date("2026-07-27T00:00:00.000Z"),
          expiresAt: new Date("2026-08-27T00:00:00.000Z"),
        }),
        previewRestore,
        restore,
      } as unknown as BackupRepository;
      const release = vi.fn();
      const service = createAdminBackupService({
        repository,
        encryptionKey: key,
        channelSecretKeyFingerprint: "sha256:channel-key",
        backupStorageRoot: backupRoot,
        attachmentStorageRoot: attachmentRoot,
        matrixStorageRoot: matrixRoot,
        retentionDays: 30,
        stopConnections: vi.fn().mockResolvedValue(release),
      });

      await expect(
        service.restore(
          scope,
          backupId,
          {
            agentIds: [scope.agentId],
            includeGlobalConfig: true,
            includeSecrets: true,
            includeSkillPool: true,
            confirmed: true,
          },
        ),
      ).rejects.toThrow("simulated_database_commit_failure");
      expect(previewRestore).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(
        await readFile(path.join(attachmentRoot, storageKey)),
      ).toEqual(Buffer.from("old-private-file"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
