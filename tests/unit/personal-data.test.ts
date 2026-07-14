import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPersonalDataExport } from "@/server/admin/personal-data";
import { createRepositories } from "@/server/db/repositories";
import { deleteArtifactTree, writeArtifactFile } from "@/server/tasks/artifacts";

const roots: string[] = [];

describe("personal data helpers", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await deleteArtifactTree(root, "user-1");
    }
  });

  it("wraps exported tables with ownership and timestamp metadata", () => {
    const exportedAt = new Date("2026-07-05T10:00:00+08:00");

    expect(
      buildPersonalDataExport({
        userId: "user-1",
        exportedAt,
        tables: {
          conversations: [{ id: "c1", user_id: "user-1" }],
          messages: [{ id: "m1", user_id: "user-1" }],
        },
      }),
    ).toEqual({
      userId: "user-1",
      exportedAt: exportedAt.toISOString(),
      tables: {
        conversations: [{ id: "c1", user_id: "user-1" }],
        messages: [{ id: "m1", user_id: "user-1" }],
      },
    });
  });

  it("deletes stored task artifacts for one user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-artifacts-"));
    roots.push(root);
    const artifact = await writeArtifactFile({
      root,
      userId: "user-1",
      taskRunId: "task-1",
      fileName: "report.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ok"),
    });

    await deleteArtifactTree(root, "user-1");

    await expect(stat(path.join(root, artifact.storagePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports only safe attachment fields owned by the requested user and includes derived text", async () => {
    const attachment = {
      id: "attachment-1",
      user_id: "user-1",
      message_id: "message-1",
      kind: "document",
      file_name: "notes.md",
      mime_type: "text/markdown",
      size_bytes: 12,
      extracted_text: "这是从用户文件提取的正文",
      text_truncated: false,
      status: "bound",
      error_code: null,
      created_at: new Date("2026-07-14T00:00:00Z"),
      updated_at: new Date("2026-07-14T00:00:00Z"),
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      return { rows: sql.includes("FROM message_attachments") ? [attachment] : [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    const exported = await repositories.personalData.export("user-1");

    expect(exported.tables.message_attachments).toEqual([attachment]);
    const attachmentCall = query.mock.calls.find(([sql]) => String(sql).includes("FROM message_attachments"));
    expect(attachmentCall?.[1]).toEqual(["user-1"]);
    expect(String(attachmentCall?.[0])).toContain("WHERE user_id = $1");
    expect(String(attachmentCall?.[0])).toContain("extracted_text");
    expect(String(attachmentCall?.[0])).not.toContain("storage_key");
    expect(String(attachmentCall?.[0])).not.toContain("deletion_claim_token");
  });

  it("lists only the requested user's attachment storage keys before clearing rows", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [{ storage_key: "owned-key" }] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(repositories.personalData.listAttachmentStorageKeys("user-1")).resolves.toEqual(["owned-key"]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("FROM message_attachments");
    expect(sql).toContain("WHERE user_id = $1");
    expect(params).toEqual(["user-1"]);
  });

  it("clears unbound attachment rows as well as message-bound attachments", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.personalData.clear("user-1");

    const attachmentDelete = query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM message_attachments"),
    );
    expect(attachmentDelete?.[1]).toEqual(["user-1"]);
  });
});
