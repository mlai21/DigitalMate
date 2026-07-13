"use client";

import { FileText, Image as ImageIcon, Plus, RotateCcw, X } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { ATTACHMENT_LIMITS, type AttachmentKind } from "@/server/attachments/types";

export const IMAGE_ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
export const DOCUMENT_ATTACHMENT_ACCEPT = ".pdf,.txt,.md,.json,.csv,application/pdf,text/plain,text/markdown,application/json,text/csv";

type UploadStatus = "uploading" | "ready" | "failed";

export type UploadingAttachment = {
  localId: string;
  id?: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: UploadStatus;
  error?: string;
  file: File;
  previewUrl?: string;
};

type AttachmentPickerProps = {
  attachments: UploadingAttachment[];
  disabled?: boolean;
  onChange: (attachments: UploadingAttachment[]) => void;
};

type UploadResponse = {
  attachment?: {
    id: string;
    kind: AttachmentKind;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: "ready";
  };
  error?: string;
};

const ALLOWED_FILES: Readonly<Record<string, { kind: AttachmentKind; mimeType: string }>> = {
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  png: { kind: "image", mimeType: "image/png" },
  webp: { kind: "image", mimeType: "image/webp" },
  pdf: { kind: "document", mimeType: "application/pdf" },
  txt: { kind: "document", mimeType: "text/plain" },
  md: { kind: "document", mimeType: "text/markdown" },
  json: { kind: "document", mimeType: "application/json" },
  csv: { kind: "document", mimeType: "text/csv" },
};

export function AttachmentPicker({ attachments, disabled, onChange }: AttachmentPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const localIdCounterRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  const renderedAttachmentsRef = useRef(attachments);
  const mountedRef = useRef(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const currentPreviewUrls = new Set(
      attachments.map((attachment) => attachment.previewUrl).filter((url): url is string => Boolean(url)),
    );
    renderedAttachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl && !currentPreviewUrls.has(attachment.previewUrl)) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
    renderedAttachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      renderedAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    const closeForSkillPicker = () => setMenuOpen(false);
    document.addEventListener("chat-skill-picker-open", closeForSkillPicker);
    return () => document.removeEventListener("chat-skill-picker-open", closeForSkillPicker);
  }, []);

  function commit(next: UploadingAttachment[]) {
    attachmentsRef.current = next;
    onChange(next);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const next = [...attachmentsRef.current];
    const accepted: UploadingAttachment[] = [];
    let nextError: string | null = null;

    for (const originalFile of files) {
      if (next.length >= ATTACHMENT_LIMITS.maxCount) {
        nextError = `每条消息最多 ${ATTACHMENT_LIMITS.maxCount} 个附件。`;
        break;
      }
      const allowed = classifyClientFile(originalFile);
      if (!allowed) {
        nextError = "仅支持 JPEG、PNG、WebP、PDF、TXT、MD、JSON、CSV。";
        continue;
      }
      if (originalFile.size > ATTACHMENT_LIMITS.maxFileBytes) {
        nextError = "单个附件不能超过 10 MB。";
        continue;
      }
      const totalBytes = next.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
      if (totalBytes + originalFile.size > ATTACHMENT_LIMITS.maxMessageBytes) {
        nextError = "附件总大小不能超过 20 MB。";
        continue;
      }

      const file = originalFile.type === allowed.mimeType
        ? originalFile
        : new File([originalFile], originalFile.name, {
            type: allowed.mimeType,
            lastModified: originalFile.lastModified,
          });
      const attachment: UploadingAttachment = {
        localId: `attachment-${localIdCounterRef.current++}`,
        kind: allowed.kind,
        fileName: file.name,
        mimeType: allowed.mimeType,
        sizeBytes: file.size,
        status: "uploading",
        file,
        ...(allowed.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
      next.push(attachment);
      accepted.push(attachment);
    }

    setValidationError(nextError);
    if (accepted.length === 0) return;
    commit(next);
    await Promise.all(accepted.map((attachment) => uploadAttachment(attachment)));
  }

  async function uploadAttachment(attachment: UploadingAttachment) {
    updateAttachment(attachment.localId, { status: "uploading", error: undefined, id: undefined });
    const form = new FormData();
    form.set("kind", attachment.kind);
    form.set("file", attachment.file);

    try {
      const response = await fetch("/api/chat/attachments", { method: "POST", body: form });
      const data = await readUploadResponse(response);
      if (!response.ok || !data.attachment) {
        throw new Error(readableUploadError(data.error));
      }

      if (!mountedRef.current || !attachmentsRef.current.some((item) => item.localId === attachment.localId)) {
        void deleteDraft(data.attachment.id);
        return;
      }
      updateAttachment(attachment.localId, {
        id: data.attachment.id,
        kind: data.attachment.kind,
        fileName: data.attachment.fileName,
        mimeType: data.attachment.mimeType,
        sizeBytes: data.attachment.sizeBytes,
        status: "ready",
        error: undefined,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      updateAttachment(attachment.localId, {
        status: "failed",
        error: error instanceof Error ? error.message : "上传失败，请重试。",
      });
    }
  }

  function updateAttachment(localId: string, patch: Partial<UploadingAttachment>) {
    const current = attachmentsRef.current;
    if (!current.some((attachment) => attachment.localId === localId)) return;
    commit(current.map((attachment) => (attachment.localId === localId ? { ...attachment, ...patch } : attachment)));
  }

  function removeAttachment(attachment: UploadingAttachment) {
    if (disabled) return;
    commit(attachmentsRef.current.filter((item) => item.localId !== attachment.localId));
    if (attachment.id) void deleteDraft(attachment.id);
  }

  function retryAttachment(attachment: UploadingAttachment) {
    if (disabled) return;
    void uploadAttachment(attachment);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setMenuOpen(false);
    void addFiles(files);
  }

  useEffect(() => {
    const isComposerTarget = (event: DragEvent) =>
      event.target instanceof Element && Boolean(event.target.closest(".chat-input-shell"));
    const handleDragOver = (event: DragEvent) => {
      if (!disabled && isComposerTarget(event)) event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      if (disabled || !isComposerTarget(event)) return;
      event.preventDefault();
      setMenuOpen(false);
      void addFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  });

  return (
    <div ref={rootRef} className="attachment-picker">
      <input
        ref={imageInputRef}
        className="attachment-file-input"
        type="file"
        aria-label="选择图片"
        accept={IMAGE_ATTACHMENT_ACCEPT}
        multiple
        disabled={disabled}
        onChange={handleInputChange}
      />
      <input
        ref={documentInputRef}
        className="attachment-file-input"
        type="file"
        aria-label="选择文件"
        accept={DOCUMENT_ATTACHMENT_ACCEPT}
        multiple
        disabled={disabled}
        onChange={handleInputChange}
      />

      {attachments.length > 0 ? (
        <div className="attachment-preview-list" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <div key={attachment.localId} className={`attachment-preview-card attachment-${attachment.status}`}>
              {attachment.kind === "image" && attachment.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="attachment-preview-image" src={attachment.previewUrl} alt="" />
              ) : (
                <span className="attachment-preview-icon" aria-hidden="true">
                  <FileText size={22} />
                </span>
              )}
              <div className="attachment-preview-copy">
                <span className="attachment-file-name">{attachment.fileName}</span>
                <span className="attachment-file-meta">
                  {formatFileSize(attachment.sizeBytes)}
                  {attachment.status === "uploading" ? " · 上传中" : ""}
                </span>
                {attachment.status === "failed" ? (
                  <span className="attachment-error">{attachment.error}</span>
                ) : null}
              </div>
              <div className="attachment-preview-actions">
                {attachment.status === "failed" ? (
                  <button
                    type="button"
                    className="attachment-card-button"
                    aria-label={`重试 ${attachment.fileName}`}
                    disabled={disabled}
                    onClick={() => retryAttachment(attachment)}
                  >
                    <RotateCcw size={16} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="attachment-card-button"
                  aria-label={`移除 ${attachment.fileName}`}
                  disabled={disabled}
                  onClick={() => removeAttachment(attachment)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {validationError ? (
        <div className="attachment-validation-error" role="alert">
          {validationError}
        </div>
      ) : null}

      {attachments.some((attachment) => attachment.status === "failed") ? (
        <div className="attachment-validation-error" role="alert">
          请先重试或移除上传失败的附件。
        </div>
      ) : null}

      <button
        type="button"
        className={`attachment-trigger${menuOpen ? " active" : ""}`}
        aria-label="添加附件"
        aria-expanded={menuOpen}
        disabled={disabled}
        data-attachment-picker-trigger
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Plus size={22} aria-hidden="true" />
      </button>

      {menuOpen ? (
        <div className="attachment-menu" role="menu" aria-label="添加附件菜单">
          <button type="button" role="menuitem" onClick={() => documentInputRef.current?.click()}>
            <FileText size={19} aria-hidden="true" />
            上传文件
          </button>
          <button type="button" role="menuitem" onClick={() => imageInputRef.current?.click()}>
            <ImageIcon size={19} aria-hidden="true" />
            上传图片
          </button>
        </div>
      ) : null}
    </div>
  );
}

function classifyClientFile(file: File): { kind: AttachmentKind; mimeType: string } | null {
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  const allowed = ALLOWED_FILES[extension];
  if (!allowed) return null;
  if (file.type && file.type.toLowerCase() !== allowed.mimeType) return null;
  return allowed;
}

async function readUploadResponse(response: Response): Promise<UploadResponse> {
  try {
    return (await response.json()) as UploadResponse;
  } catch {
    return {};
  }
}

function readableUploadError(code?: string): string {
  if (code === "attachment_file_too_large" || code === "attachment_request_too_large") {
    return "单个附件不能超过 10 MB。";
  }
  if (code === "attachment_no_extractable_text" || code?.startsWith("attachment_text_")) {
    return "无法读取此文件，请重试或移除。";
  }
  if (code === "attachment_type_not_allowed" || code === "attachment_signature_mismatch") {
    return "不支持此文件类型。";
  }
  return "上传失败，请重试。";
}

async function deleteDraft(id: string) {
  try {
    await fetch(`/api/chat/attachments/${id}`, { method: "DELETE" });
  } catch {
    // Draft cleanup is best-effort; the server also expires unbound uploads.
  }
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.ceil(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
