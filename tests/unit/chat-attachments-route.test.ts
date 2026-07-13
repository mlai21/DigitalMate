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
    status: "ready",
    errorCode: null,
    createdAt: new Date("2026-07-14T00:00:00Z"),
    updatedAt: new Date("2026-07-14T00:00:00Z"),
  };

  return {
    draft,
    requireCurrentUser: vi.fn(async () => ({ id: draft.userId })),
    createDraft: vi.fn<() => Promise<DbMessageAttachment>>(async () => draft),
    claimDraftForDeletion: vi.fn<() => Promise<DbMessageAttachment | null>>(
      async () => ({ ...draft, status: "deleting" }),
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

function uploadRequest(file?: File, kind = "document") {
  const form = new FormData();
  if (file) form.set("file", file);
  form.set("kind", kind);
  return { formData: async () => form } as unknown as Request;
}

function attachmentContext(attachmentId = mocks.draft.id) {
  return { params: Promise.resolve({ attachmentId }) };
}

describe("chat attachment upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockResolvedValue({ id: mocks.draft.userId });
    mocks.createDraft.mockResolvedValue(mocks.draft);
    mocks.saveAttachment.mockResolvedValue(undefined);
    mocks.deleteStoredAttachment.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated uploads before reading the form", async () => {
    mocks.requireCurrentUser.mockRejectedValueOnce(new Error("Unauthorized"));
    const formData = vi.fn(async () => new FormData());

    const response = await uploadAttachment({ formData } as unknown as Request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(formData).not.toHaveBeenCalled();
  });

  it("rejects a request without a file", async () => {
    const response = await uploadAttachment(uploadRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_required" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("rejects an empty file without creating a database draft", async () => {
    const response = await uploadAttachment(
      uploadRequest(new File([], "empty.txt", { type: "text/plain" })),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_empty" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("rejects a file above the single-file limit before reading its bytes", async () => {
    const file = {
      name: "large.txt",
      type: "text/plain",
      size: ATTACHMENT_LIMITS.maxFileBytes + 1,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    } as unknown as File;
    const formData = vi.fn(async () => {
      const result = new FormData();
      result.set("kind", "document");
      Object.defineProperty(result, "get", {
        value: (key: string) => (key === "file" ? file : key === "kind" ? "document" : null),
      });
      return result;
    });

    const response = await uploadAttachment({ formData } as unknown as Request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "attachment_file_too_large" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ["script.svg", "image/svg+xml", "image", "<svg></svg>"],
    ["photo.png", "image/png", "image", "not a png"],
  ])("rejects unsupported or signature-mismatched uploads", async (name, type, kind, content) => {
    const response = await uploadAttachment(uploadRequest(new File([content], name, { type }), kind));

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/^attachment_/) });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("rejects a declared kind that disagrees with the validated file", async () => {
    const response = await uploadAttachment(
      uploadRequest(new File(["hello world\n"], "notes.md", { type: "text/markdown" }), "image"),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "attachment_kind_mismatch" });
    expect(mocks.saveAttachment).not.toHaveBeenCalled();
  });

  it("validates, extracts, privately stores, then creates a ready draft and returns safe fields only", async () => {
    const response = await uploadAttachment(
      uploadRequest(new File(["hello world\n"], "notes.md", { type: "text/markdown" })),
    );

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
  });

  it("removes the private file if draft persistence fails", async () => {
    mocks.createDraft.mockRejectedValueOnce(new Error("database_down"));

    const response = await uploadAttachment(
      uploadRequest(new File(["hello world\n"], "notes.md", { type: "text/markdown" })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_upload_failed" });
    expect(mocks.deleteStoredAttachment).toHaveBeenCalledWith(
      "/private/attachments",
      mocks.draft.storageKey,
    );
  });

  it("does not delete a pre-existing file when atomic publication rejects a key collision", async () => {
    mocks.saveAttachment.mockRejectedValueOnce(
      Object.assign(new Error("target exists"), { code: "EEXIST" }),
    );

    const response = await uploadAttachment(
      uploadRequest(new File(["hello world\n"], "notes.md", { type: "text/markdown" })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "attachment_upload_failed" });
    expect(mocks.deleteStoredAttachment).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});

describe("chat attachment delete route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockResolvedValue({ id: mocks.draft.userId });
    mocks.claimDraftForDeletion.mockResolvedValue({ ...mocks.draft, status: "deleting" });
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
      .mockResolvedValueOnce({ ...mocks.draft, status: "deleting" })
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
  });

  it("claims the draft before removing its private file and database record", async () => {
    const order: string[] = [];
    mocks.claimDraftForDeletion.mockImplementationOnce(async () => {
      order.push("claim");
      return { ...mocks.draft, status: "deleting" };
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
      "attachment_delete_failed",
    );
  });
});

describe("chat attachment download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
