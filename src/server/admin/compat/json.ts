import { AdminCompatError } from "@/server/admin/compat/types";

export const adminCompatJsonBodyLimitBytes = 16 * 1024;

export async function readAdminCompatJson(
  request: Request,
): Promise<unknown> {
  if (declaredBodyExceedsLimit(request.headers.get("content-length"))) {
    throw payloadTooLarge();
  }

  try {
    const bytes = await readLimitedBody(request);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
    );
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AdminCompatError) throw error;
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_json",
    );
  }
}

function declaredBodyExceedsLimit(value: string | null): boolean {
  if (value === null || !/^\d+$/u.test(value)) return false;
  try {
    return (
      BigInt(value) > BigInt(adminCompatJsonBodyLimitBytes)
    );
  } catch {
    return false;
  }
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > adminCompatJsonBodyLimitBytes) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function payloadTooLarge(): AdminCompatError {
  return new AdminCompatError(
    413,
    "payload_too_large",
    "payload_too_large",
  );
}
