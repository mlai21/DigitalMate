import type {
  InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";
import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";

import type { WeComClientPort } from "./transport";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function createWeComAttachmentFetcher(
  client: WeComClientPort,
): InboundAttachmentFetcher {
  const downloaded = new Map<
    string,
    Readonly<{
      bytes: Buffer;
      fileName: string;
      mimeType: string;
    }>
  >();

  return {
    async inspect(descriptor) {
      const media = await load(descriptor);
      return {
        fileName: media.fileName,
        mimeType: media.mimeType,
        sizeBytes: media.bytes.byteLength,
      };
    },

    async download(descriptor, signal) {
      signal?.throwIfAborted();
      const media = await load(descriptor);
      signal?.throwIfAborted();
      return (async function* () {
        const chunkSize = 64 * 1024;
        for (
          let offset = 0;
          offset < media.bytes.byteLength;
          offset += chunkSize
        ) {
          signal?.throwIfAborted();
          yield media.bytes.subarray(
            offset,
            offset + chunkSize,
          );
        }
      })();
    },
  };

  async function load(
    descriptor: InboundAttachmentDescriptor,
  ) {
    const source = sourceFields(descriptor);
    const cacheKey =
      `${descriptor.externalAttachmentId}\u0000${source.url}`;
    const cached = downloaded.get(cacheKey);
    if (cached) return cached;
    const result = await client.downloadFile(source);
    const bytes = Buffer.from(result.bytes);
    if (
      bytes.byteLength <= 0
      || bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes
    ) {
      throw new Error("wecom_attachment_size_invalid");
    }
    const declaredMime = safeMimeType(descriptor.mimeType);
    const returnedName = safeFileName(
      result.fileName ?? null,
    );
    const declaredName = safeFileName(descriptor.fileName);
    const returnedMime = inferMimeType(returnedName);
    const fileName =
      returnedName
      && returnedMime
      && (!declaredMime || returnedMime === declaredMime)
        ? returnedName
        : declaredName ?? returnedName;
    const mimeType = declaredMime ?? inferMimeType(fileName);
    if (!fileName || !mimeType) {
      throw new Error("wecom_attachment_metadata_incomplete");
    }
    const media = { bytes, fileName, mimeType };
    downloaded.set(cacheKey, media);
    return media;
  }
}

export async function uploadWeComMedia(
  client: WeComClientPort,
  input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mediaType: "file" | "image" | "video" | "voice";
  }>,
): Promise<Readonly<{ mediaId: string }>> {
  if (
    input.bytes.byteLength <= 0
    || input.bytes.byteLength > MAX_UPLOAD_BYTES
  ) {
    throw new Error("wecom_media_size_invalid");
  }
  if (!safeFileName(input.fileName)) {
    throw new Error("wecom_media_filename_invalid");
  }
  return client.uploadMedia(input);
}

function sourceFields(
  descriptor: InboundAttachmentDescriptor,
) {
  const url = descriptor.source.url;
  const aesKey = descriptor.source.aesKey;
  if (!safeDownloadUrl(url) || !aesKey || aesKey.length > 12_000) {
    throw new Error("wecom_attachment_locator_invalid");
  }
  return { url, aesKey };
}

function safeDownloadUrl(value: string | undefined): boolean {
  if (!value || value.length > 16_384) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (
        host === "work.weixin.qq.com"
        || host.endsWith(".work.weixin.qq.com")
        || host === "wecom.qq.com"
        || host.endsWith(".wecom.qq.com")
        || host === "wework.qpic.cn"
        || host.endsWith(".wework.qpic.cn")
      );
  } catch {
    return false;
  }
}

function safeFileName(value: string | null): string | null {
  if (
    !value
    || value.length > 512
    || value.includes("/")
    || value.includes("\\")
    || value === "."
    || value === ".."
  ) {
    return null;
  }
  return value;
}

function safeMimeType(value: string | null): string | null {
  return value
    && value.length <= 512
    && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(value)
    ? value
    : null;
}

function inferMimeType(fileName: string | null): string | null {
  const extension = fileName
    ?.slice(fileName.lastIndexOf(".") + 1)
    .toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    default:
      return null;
  }
}
