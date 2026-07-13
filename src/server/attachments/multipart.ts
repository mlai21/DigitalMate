import { once } from "node:events";
import busboy from "busboy";
import { ATTACHMENT_LIMITS, type AttachmentKind } from "./types";

export const ATTACHMENT_MULTIPART_MAX_BYTES = 11 * 1024 * 1024;

export type ParsedAttachmentUpload = {
  fileName: string;
  declaredMime: string;
  declaredKind: AttachmentKind;
  bytes: Buffer;
};

export class AttachmentMultipartError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function limitError(code: string) {
  return new AttachmentMultipartError(code);
}

function parseContentLength(value: string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw limitError("invalid_request");
  }
  return parsed;
}

export async function parseAttachmentMultipart(request: Request): Promise<ParsedAttachmentUpload> {
  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > ATTACHMENT_MULTIPART_MAX_BYTES) {
    throw limitError("attachment_request_too_large");
  }
  if (!request.body) {
    throw limitError("invalid_request");
  }

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      limits: {
        // Busboy emits `limit` when the configured size is reached, so allow
        // one sentinel byte to distinguish an exact 10 MiB file from overflow.
        fileSize: ATTACHMENT_LIMITS.maxFileBytes + 1,
        files: 1,
        fields: 1,
        // Busboy emits partsLimit when the count reaches the configured value,
        // so three rejects the third part while allowing exactly kind + file.
        parts: 3,
        fieldNameSize: 32,
        fieldSize: 16,
        headerPairs: 16,
      },
    });
  } catch {
    throw limitError("invalid_request");
  }

  let declaredKind: AttachmentKind | null = null;
  let fileName: string | null = null;
  let declaredMime: string | null = null;
  let fileSeen = false;
  const fileChunks: Buffer[] = [];
  let fatalError: AttachmentMultipartError | null = null;
  let parserClosed = false;
  const closed = new Promise<void>((resolve) => {
    parser.once("close", () => {
      parserClosed = true;
      resolve();
    });
  });
  const fail = (code: string) => {
    fatalError ??= limitError(code);
  };

  parser.on("file", (fieldName, stream, info) => {
    if (fieldName !== "file" || fileSeen) {
      fail("attachment_multipart_limit_exceeded");
      stream.resume();
      return;
    }
    fileSeen = true;
    fileName = info.filename;
    declaredMime = info.mimeType;
    stream.on("limit", () => fail("attachment_file_too_large"));
    stream.on("data", (chunk: Buffer) => {
      if (!fatalError) fileChunks.push(Buffer.from(chunk));
    });
    stream.on("error", () => fail("invalid_request"));
  });
  parser.on("field", (fieldName, value, info) => {
    if (fieldName !== "kind" || info.valueTruncated || declaredKind !== null) {
      fail("attachment_multipart_limit_exceeded");
      return;
    }
    if (value === "image" || value === "document") {
      declaredKind = value;
    } else {
      fail("attachment_kind_required");
    }
  });
  parser.on("filesLimit", () => fail("attachment_multipart_limit_exceeded"));
  parser.on("fieldsLimit", () => fail("attachment_multipart_limit_exceeded"));
  parser.on("partsLimit", () => fail("attachment_multipart_limit_exceeded"));
  parser.on("error", () => fail("invalid_request"));

  const reader = request.body.getReader();
  let receivedBytes = 0;
  try {
    while (!fatalError) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > ATTACHMENT_MULTIPART_MAX_BYTES) {
        fail("attachment_request_too_large");
        break;
      }
      if (!parser.write(Buffer.from(value)) && !fatalError) {
        await once(parser, "drain");
      }
    }

    if (fatalError) {
      await reader.cancel().catch(() => undefined);
      parser.destroy();
    } else {
      parser.end();
    }
    if (!parserClosed) await closed;
  } catch {
    await reader.cancel().catch(() => undefined);
    parser.destroy();
    if (!parserClosed) await closed;
    if (fatalError) throw fatalError;
    throw new AttachmentMultipartError("invalid_request");
  }

  if (fatalError) throw fatalError;
  if (!fileSeen || fileName === null || declaredMime === null) {
    throw limitError("attachment_file_required");
  }
  if (!declaredKind) {
    throw limitError("attachment_kind_required");
  }
  const bytes = Buffer.concat(fileChunks);
  if (bytes.length === 0) {
    throw limitError("attachment_file_empty");
  }
  if (bytes.length > ATTACHMENT_LIMITS.maxFileBytes) {
    throw limitError("attachment_file_too_large");
  }

  return { fileName, declaredMime, declaredKind, bytes };
}
