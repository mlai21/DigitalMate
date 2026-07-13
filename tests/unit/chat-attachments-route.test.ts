import { beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import type { DbMessageAttachment } from "@/server/db/repositories";
import { POST as uploadAttachment } from "@/app/api/chat/attachments/route";
import { DELETE as deleteAttachmentDraft } from "@/app/api/chat/attachments/[attachmentId]/route";
import { GET as downloadAttachment } from "@/app/api/chat/attachments/[attachmentId]/download/route";

const mocks = vi.hoisted(() => {
  const draft: DbMessageAttachment = {
    id: "30000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000001",
    messageId: null,
    kind: "document" as const,
    fileName: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    storageKey: "40000000-0000-4000-8000-000000000001",
    extractedText: "hello world",
    textTruncated: false,
    status: "pending",
    errorCode: null,
    deletionClaimToken: null,
    createdAt: new Date("2026-07-14T00:00:00Z"),
    updatedAt: new Date("2026-07-14T00:00:00Z"),
  };

  return {
    draft,
    requireCurrentUser: vi.fn(async () => ({ id: draft.userId })),
    createDraft: vi.fn<() => Promise<DbMessageAttachment>>(async () => draft),
    markReady: vi.fn<() => Promise<DbMessageAttachment | null>>(
      async () => ({ ...draft, status: "ready" }),
    ),
    markFailed: vi.fn(async () => undefined),
    claimDraftForDeletion: vi.fn<() => Promise<DbMessageAttachment | null>>(
      async () => ({
        ...draft,
        status: "deleting",
        deletionClaimToken: "50000000-0000-4000-8000-000000000001",
      }),
    ),
    deleteDraft: vi.fn(async () => true),
    getForUser: vi.fn<() => Promise<DbMessageAttachment | null>>(
      async () => ({ ...draft, messageId: "message-1", status: "bound" }),
    ),
    releaseDeletionClaim: vi.fn(async () => undefined),
    saveAttachment: vi.fn(async () => undefined),
    deleteStoredAttachment: vi.fn(async () => undefined),
    readAttachment: vi.fn(async () => Buffer.from("hello world\n")),
  };
});

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
}));

vi.mock("@/server/config/env", () => ({
  readEnv: vi.fn(() => ({ attachmentStorageDir: "/private/attachments" })),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    messageAttachments: {
      createDraft: mocks.createDraft,
      markReady: mocks.markReady,
      markFailed: mocks.markFailed,
      claimDraftForDeletion: mocks.claimDraftForDeletion,
      deleteDraft: mocks.deleteDraft,
      getForUser: mocks.getForUser,
      releaseDeletionClaim: mocks.releaseDeletionClaim,
    },
  })),
}));

vi.mock("@/server/attachments/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attachments/storage")>();
  return {
    ...actual,
    createAttachmentStorageKey: vi.fn(() => mocks.draft.storageKey),
    saveAttachment: mocks.saveAttachment,
    deleteAttachment: mocks.deleteStoredAttachment,
    readAttachment: mocks.readAttachment,
  };
});

type MultipartFile = {
  name: string;
  type: string;
  content: string | Uint8Array;
  fieldName?: string;
};

function encode(value: string) {
  return new TextEncoder().encode(value);
}

function multipartRequest(input: {
  file?: MultipartFile;
  kind?: string;
  extraFiles?: MultipartFile[];
  extraFields?: Array<[string, string]>;
  contentLength?: number;
  chunkSize?: number;
  onCancel?: () => void;
}) {
  const boundary = "digitalmate-test-boundary";
  const chunks: Uint8Array[] = [];
  const pushField = (name: string, value: string) => {
    chunks.push(encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const pushFile = (file: MultipartFile) => {
    chunks.push(
      encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName ?? "file"}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    const bytes = typeof file.content === "string" ? encode(file.content) : file.content;
    const chunkSize = input.chunkSize ?? 64 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    }
    chunks.push(encode("\r\n"));
  };

  if (input.kind !== undefined) pushField("kind", input.kind);
  for (const field of input.extraFields ?? []) pushField(field[0], field[1]);
  if (input.file) pushFile(input.file);
  for (const file of input.extraFiles ?? []) pushFile(file);
  chunks.push(encode(`--${boundary}--\r\n`));

  let nextChunk = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[nextChunk];
      nextChunk += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      input.onCancel?.();
    },
  });
  const headers = new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` });
  if (input.contentLength !== undefined) {
    headers.set("content-length", String(input.contentLength));
  }

  return new Request("http://localhost/api/chat/attachments", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function attachmentContext(attachmentId = mocks.draft.id) {
  return { params: Promise.resolve({ attachmentId }) };
}

describe("chat attachment upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockReset();
    mocks.createDraft.mockReset();
    mocks.markReady.mockReset();
    mocks.markFailed.mockReset();
    mocks.saveAttachment.mockReset();
    mocks.deleteStoredAttachment.mockReset();
    mocks.requireCurrentUser.mockResolvedValue({ id: mocks.draft.userId });
    mocks.createDraft.mockResolvedValue({ ...mocks.draft, status: "pending" });
    mocks.markReady.mockResolvedValue({ ...mocks.draft, status: "ready" });
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.saveAttachment.mockResolvedValue(undefined);
    mocks.deleteStoredAttachment.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated uploads before reading the request body", async () => {
    mocks.requireCurrentUser.mockRejectedValueOnce(new Error("Unauthorized"));
    const getReader = vi.fn();

    const response = await uploadAttachment({
      headers: new Headers({ "content-type": "multipart/form-data; boundary=x" }),
      body: { getReader },
    } as unknown as Request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("rejects a request without a file", async () => {
    const response = await uploadAttachment(multipartRequest({ kind: "document" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_required" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("rejects an empty file without creating a database draft", async () => {
    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "empty.txt", type: "text/plain", content: "" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_empty" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("quickly rejects an oversized declared request without reading the body", async () => {
    const getReader = vi.fn();
    const response = await uploadAttachment({
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(11 * 1024 * 1024 + 1),
      }),
      body: { getReader },
    } as unknown as Request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "attachment_request_too_large" });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("hard-limits a real chunked multipart file without calling request.formData", async () => {
    const onCancel = vi.fn();
    const request = multipartRequest({
      kind: "document",
      file: {
        name: "large.txt",
        type: "text/plain",
        content: new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1).fill(0x61),
      },
      chunkSize: 32 * 1024,
      onCancel,
    });
    const formData = vi.spyOn(request, "formData");

    const response = await uploadAttachment(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_too_large" });
    expect(formData).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("accepts an image exactly at the ten MiB file boundary", async () => {
    const png = new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mocks.markReady.mockResolvedValueOnce({
      ...mocks.draft,
      kind: "image",
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      status: "ready",
    });

    const response = await uploadAttachment(
      multipartRequest({
        kind: "image",
        file: { name: "photo.png", type: "image/png", content: png },
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", sizeBytes: ATTACHMENT_LIMITS.maxFileBytes }),
    );
  });

  it("rejects a second file part with a stable 413", async () => {
    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "first.txt", type: "text/plain", content: "first" },
        extraFiles: [{ name: "second.txt", type: "text/plain", content: "second" }],
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "attachment_multipart_limit_exceeded" });
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("rejects multipart part-count overflow with a stable 413", async () => {
    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        extraFields: [["unexpected", "value"]],
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "attachment_multipart_limit_exceeded" });
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["script.svg", "image/svg+xml", "image", "<svg></svg>"],
    ["photo.png", "image/png", "image", "not a png"],
  ])("rejects unsupported or signature-mismatched uploads", async (name, type, kind, content) => {
    const response = await uploadAttachment(
      multipartRequest({ kind, file: { name, type, content } }),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/^attachment_/) });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("rejects a declared kind that disagrees with the validated file", async () => {
    const response = await uploadAttachment(
      multipartRequest({
        kind: "image",
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "attachment_kind_mismatch" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("streams a real multipart upload through pending, private storage, then ready", async () => {
    const request = multipartRequest({
      kind: "document",
      file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      chunkSize: 3,
    });
    const formData = vi.spyOn(request, "formData");
    const response = await uploadAttachment(request);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      attachment: {
        id: mocks.draft.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "ready",
      },
    });
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(JSON.stringify(body)).not.toContain("extractedText");
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.createDraft).toHaveBeenCalledBefore(mocks.saveAttachment);
    expect(mocks.saveAttachment).toHaveBeenCalledBefore(mocks.markReady);
    expect(mocks.saveAttachment).toHaveBeenCalledWith(
      "/private/attachments",
      mocks.draft.storageKey,
      Buffer.from("hello world\n"),
    );
    expect(mocks.createDraft).toHaveBeenCalledWith({
      userId: mocks.draft.userId,
      kind: "document",
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
      storageKey: mocks.draft.storageKey,
      extractedText: "hello world\n",
      textTruncated: false,
    });
    expect(mocks.markReady).toHaveBeenCalledWith(mocks.draft.userId, mocks.draft.id);
  });

  it("does not publish storage when pending draft persistence fails", async () => {
    mocks.createDraft.mockRejectedValueOnce(new Error("database_down"));

    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_upload_failed" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteStoredAttachment).not.toHaveBeenCalled();
  });

  it("marks the pending draft failed and compensates storage when publication fails", async () => {
    mocks.saveAttachment.mockRejectedValueOnce(new Error("storage_unavailable"));

    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_upload_failed" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      "attachment_upload_failed",
    );
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledWith(
      "/private/attachments",
      mocks.draft.storageKey,
    );
  });

  it("marks a collision failed without deleting the pre-existing final file", async () => {
    mocks.saveAttachment.mockRejectedValueOnce(
      Object.assign(new Error("target exists"), { code: "EEXIST" }),
    );

    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      "attachment_upload_failed",
    );
    expect(mocks.deleteStoredAttachment).not.toHaveBeenCalled();
  });

  it("keeps a failed database record when ready transition fails even if cleanup also fails", async () => {
    mocks.markReady.mockRejectedValueOnce(new Error("database_down"));
    mocks.deleteStoredAttachment.mockRejectedValueOnce(new Error("cleanup_down"));

    const response = await uploadAttachment(
      multipartRequest({
        kind: "document",
        file: { name: "notes.md", type: "text/markdown", content: "hello world\n" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_upload_failed" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      "attachment_upload_failed",
    );
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledOnce();
  });
});

describe("chat attachment delete route", () => {
  const firstClaimToken = "50000000-0000-4000-8000-000000000001";
  const retryClaimToken = "50000000-0000-4000-8000-000000000002";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockReset();
    mocks.claimDraftForDeletion.mockReset();
    mocks.deleteDraft.mockReset();
    mocks.deleteStoredAttachment.mockReset();
    mocks.releaseDeletionClaim.mockReset();
    mocks.requireCurrentUser.mockResolvedValue({ id: mocks.draft.userId });
    mocks.claimDraftForDeletion.mockResolvedValue({
      ...mocks.draft,
      status: "deleting",
      deletionClaimToken: firstClaimToken,
    });
    mocks.deleteDraft.mockResolvedValue(true);
    mocks.deleteStoredAttachment.mockResolvedValue(undefined);
    mocks.releaseDeletionClaim.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.requireCurrentUser.mockRejectedValueOnce(new Error("Unauthorized"));

    const response = await deleteAttachmentDraft(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(401);
    expect(mocks.claimDraftForDeletion).not.toHaveBeenCalled();
  });

  it("treats another user's, bound, missing, or already deleted attachment as an idempotent success", async () => {
    mocks.claimDraftForDeletion.mockResolvedValueOnce(null);

    const response = await deleteAttachmentDraft(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.deleteStoredAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it("returns 204 for an invalid attachment id without querying or revealing existence", async () => {
    const response = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext("not-an-attachment-id"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.claimDraftForDeletion).not.toHaveBeenCalled();
    expect(mocks.deleteStoredAttachment).not.toHaveBeenCalled();
  });

  it("returns success for consecutive deletes while removing storage and record only once", async () => {
    mocks.claimDraftForDeletion
      .mockResolvedValueOnce({
        ...mocks.draft,
        status: "deleting",
        deletionClaimToken: firstClaimToken,
      })
      .mockResolvedValueOnce(null);

    const firstResponse = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext(),
    );
    const secondResponse = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext(),
    );

    expect(firstResponse.status).toBe(204);
    expect(secondResponse.status).toBe(204);
    expect(mocks.claimDraftForDeletion).toHaveBeenCalledTimes(2);
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledOnce();
    expect(mocks.deleteDraft).toHaveBeenCalledOnce();
    expect(mocks.deleteDraft).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      firstClaimToken,
    );
  });

  it("claims the draft before removing its private file and database record", async () => {
    const order: string[] = [];
    mocks.claimDraftForDeletion.mockImplementationOnce(async () => {
      order.push("claim");
      return {
        ...mocks.draft,
        status: "deleting" as const,
        deletionClaimToken: firstClaimToken,
      };
    });
    mocks.deleteStoredAttachment.mockImplementationOnce(async () => {
      order.push("file");
    });
    mocks.deleteDraft.mockImplementationOnce(async () => {
      order.push("record");
      return true;
    });

    const response = await deleteAttachmentDraft(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(204);
    expect(order).toEqual(["claim", "file", "record"]);
    expect(await response.text()).toBe("");
  });

  it("releases the deletion claim when removing the private file fails", async () => {
    mocks.deleteStoredAttachment.mockRejectedValueOnce(new Error("storage_unavailable"));

    const response = await deleteAttachmentDraft(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_delete_failed" });
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
    expect(mocks.releaseDeletionClaim).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      firstClaimToken,
      "attachment_delete_failed",
    );
  });

  it("releases a fenced claim when database deletion fails, then retries with a new token", async () => {
    mocks.claimDraftForDeletion
      .mockResolvedValueOnce({
        ...mocks.draft,
        status: "deleting",
        deletionClaimToken: firstClaimToken,
      })
      .mockResolvedValueOnce({
        ...mocks.draft,
        status: "deleting",
        deletionClaimToken: retryClaimToken,
      });
    mocks.deleteDraft
      .mockRejectedValueOnce(new Error("database_down"))
      .mockResolvedValueOnce(true);

    const firstResponse = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext(),
    );
    const retryResponse = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext(),
    );

    expect(firstResponse.status).toBe(500);
    expect(retryResponse.status).toBe(204);
    expect(mocks.releaseDeletionClaim).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      firstClaimToken,
      "attachment_delete_failed",
    );
    expect(mocks.deleteDraft).toHaveBeenNthCalledWith(
      2,
      mocks.draft.userId,
      mocks.draft.id,
      retryClaimToken,
    );
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledTimes(2);
  });

  it("returns stable 500 when release fails and lets the next request take over the lease", async () => {
    mocks.claimDraftForDeletion
      .mockResolvedValueOnce({
        ...mocks.draft,
        status: "deleting",
        deletionClaimToken: firstClaimToken,
      })
      .mockResolvedValueOnce({
        ...mocks.draft,
        status: "deleting",
        deletionClaimToken: retryClaimToken,
      });
    mocks.deleteDraft.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.releaseDeletionClaim.mockRejectedValueOnce(new Error("release_down"));

    const response = await deleteAttachmentDraft(new Request("http://localhost"), attachmentContext());
    const retryResponse = await deleteAttachmentDraft(
      new Request("http://localhost"),
      attachmentContext(),
    );

    expect(response.status).toBe(500);
    expect(retryResponse.status).toBe(204);
    await expect(response.json()).resolves.toEqual({ error: "attachment_delete_failed" });
    expect(mocks.releaseDeletionClaim).toHaveBeenCalledWith(
      mocks.draft.userId,
      mocks.draft.id,
      firstClaimToken,
      "attachment_delete_failed",
    );
    expect(mocks.deleteDraft).toHaveBeenNthCalledWith(
      2,
      mocks.draft.userId,
      mocks.draft.id,
      retryClaimToken,
    );
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledTimes(2);
  });
});

describe("chat attachment download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockReset();
    mocks.getForUser.mockReset();
    mocks.readAttachment.mockReset();
    mocks.requireCurrentUser.mockResolvedValue({ id: mocks.draft.userId });
    mocks.getForUser.mockResolvedValue({ ...mocks.draft, messageId: "message-1", status: "bound" });
    mocks.readAttachment.mockResolvedValue(Buffer.from("hello world\n"));
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.requireCurrentUser.mockRejectedValueOnce(new Error("Unauthorized"));

    const response = await downloadAttachment(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(401);
    expect(mocks.getForUser).not.toHaveBeenCalled();
  });

  it("returns 404 without revealing a cross-user or missing attachment", async () => {
    mocks.getForUser.mockResolvedValueOnce(null);

    const response = await downloadAttachment(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "attachment_not_found" });
    expect(mocks.readAttachment).not.toHaveBeenCalled();
  });

  it("does not expose an attachment while its draft is being deleted", async () => {
    mocks.getForUser.mockResolvedValueOnce({
      ...mocks.draft,
      status: "deleting",
    });

    const response = await downloadAttachment(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "attachment_not_found" });
    expect(mocks.readAttachment).not.toHaveBeenCalled();
  });

  it("returns 404 when the private file is missing", async () => {
    mocks.readAttachment.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const response = await downloadAttachment(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "attachment_not_found" });
  });

  it("downloads with private headers and an RFC 5987 encoded safe filename", async () => {
    mocks.getForUser.mockResolvedValueOnce({
      ...mocks.draft,
      fileName: "季度 报告's.md",
      messageId: "message-1",
      status: "bound",
    });

    const response = await downloadAttachment(new Request("http://localhost"), attachmentContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown");
    expect(response.headers.get("content-length")).toBe("12");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A%27s.md",
    );
    await expect(response.text()).resolves.toBe("hello world\n");
  });
});
