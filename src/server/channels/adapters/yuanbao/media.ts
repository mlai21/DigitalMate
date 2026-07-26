import {
  createHash,
  createHmac,
  randomUUID,
} from "node:crypto";
import path from "node:path";

import type { AgentScope } from "@/server/agents/types";
import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";
import type {
  InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";

import type {
  YuanbaoTokenManager,
} from "./auth";

const DOWNLOAD_INFO_PATH =
  "/api/resource/v1/download";
const UPLOAD_INFO_PATH =
  "/api/resource/genUploadInfo";
const MAX_API_RESPONSE_BYTES = 128 * 1024;

export type YuanbaoAttachmentFetcher =
  InboundAttachmentFetcher
  & Readonly<{
    release(
      descriptor: InboundAttachmentDescriptor,
    ): void;
  }>;

type YuanbaoAttachmentLocatorWriter = Readonly<{
  persist(
    scope: AgentScope,
    eventId: string,
    connectionId: string,
    descriptor: InboundAttachmentDescriptor,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
}>;

export type YuanbaoCosUploadInfo = Readonly<{
  bucketName: string;
  region: string;
  location: string;
  secretId: string;
  secretKey: string;
  securityToken: string;
  startTime: number;
  expiredTime: number;
  resourceUrl: string;
  resourceId: string;
}>;

export function createYuanbaoAttachmentFetcher(
  input: Readonly<{
    apiDomain: string;
    tokenManager: YuanbaoTokenManager;
    fetchImpl?: typeof fetch;
  }>,
): YuanbaoAttachmentFetcher {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cache = new Map<string, Promise<Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }>>>();

  return {
    async inspect(descriptor, signal) {
      const loaded = await load(descriptor, signal);
      return {
        fileName: loaded.fileName,
        mimeType: loaded.mimeType,
        sizeBytes: loaded.bytes.byteLength,
      };
    },

    async download(descriptor, signal) {
      const loaded = await load(descriptor, signal);
      return (async function* () {
        try {
          yield loaded.bytes;
        } finally {
          release(descriptor);
        }
      })();
    },

    release,
  };

  function load(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    const resourceUrl = safeYuanbaoMediaUrl(
      descriptor.source.resourceUrl,
    );
    if (!resourceUrl) {
      return Promise.reject(
        new Error("yuanbao_attachment_url_invalid"),
      );
    }
    const existing = cache.get(resourceUrl);
    if (existing) return existing;
    if (cache.size >= ATTACHMENT_LIMITS.maxCount) {
      return Promise.reject(
        new Error("yuanbao_attachment_cache_full"),
      );
    }
    const pending = fetchAttachment(
      resourceUrl,
      descriptor,
      signal,
    ).catch((error: unknown) => {
      cache.delete(resourceUrl);
      throw error;
    });
    cache.set(resourceUrl, pending);
    return pending;
  }

  function release(
    descriptor: InboundAttachmentDescriptor,
  ): void {
    const resourceUrl = safeYuanbaoMediaUrl(
      descriptor.source.resourceUrl,
    );
    if (resourceUrl) cache.delete(resourceUrl);
  }

  async function fetchAttachment(
    resourceUrl: string,
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const url = await resolveYuanbaoDownloadUrl({
      resourceUrl,
      apiDomain: input.apiDomain,
      tokenManager: input.tokenManager,
      fetchImpl,
      signal,
    });
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept:
          "image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown,application/json,text/csv",
      },
    });
    if (!response.ok || response.redirected) {
      throw new Error("yuanbao_attachment_download_failed");
    }
    const declaredLength = safeContentLength(
      response.headers.get("content-length"),
    );
    if (
      declaredLength !== null
      && declaredLength > ATTACHMENT_LIMITS.maxFileBytes
    ) {
      throw new Error("attachment_file_too_large");
    }
    const bytes = await readBoundedResponse(
      response,
      ATTACHMENT_LIMITS.maxFileBytes,
    );
    return {
      bytes,
      fileName:
        descriptor.fileName
        ?? fileNameFromUrl(resourceUrl),
      mimeType:
        descriptor.mimeType
        ?? response.headers.get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
        ?? "application/octet-stream",
    };
  }
}

export async function prepareYuanbaoAttachmentBatch(
  input: Readonly<{
    scope: AgentScope;
    eventId: string;
    connectionId: string;
    descriptors: readonly InboundAttachmentDescriptor[];
    expiresAt: Date;
    receivedAt: Date;
    locators: YuanbaoAttachmentLocatorWriter;
    fetcher: YuanbaoAttachmentFetcher;
    signal?: AbortSignal;
  }>,
): Promise<readonly InboundAttachmentDescriptor[]> {
  const pending: InboundAttachmentDescriptor[] = [];
  for (const descriptor of input.descriptors) {
    input.signal?.throwIfAborted();
    if (await input.locators.persist(
      input.scope,
      input.eventId,
      input.connectionId,
      descriptor,
      input.expiresAt,
      input.receivedAt,
    )) {
      pending.push(descriptor);
    }
  }
  if (pending.length === 0) return pending;
  await inspectYuanbaoAttachmentBatch(
    input.fetcher,
    pending,
    input.signal,
  );
  return pending;
}

export async function inspectYuanbaoAttachmentBatch(
  fetcher: YuanbaoAttachmentFetcher,
  descriptors: readonly InboundAttachmentDescriptor[],
  signal?: AbortSignal,
): Promise<void> {
  if (descriptors.length > ATTACHMENT_LIMITS.maxCount) {
    throw new Error("attachment_count_exceeded");
  }
  let totalBytes = 0;
  try {
    for (const descriptor of descriptors) {
      signal?.throwIfAborted();
      const metadata = await fetcher.inspect(
        descriptor,
        signal,
      );
      if (
        !Number.isSafeInteger(metadata.sizeBytes)
        || metadata.sizeBytes <= 0
      ) {
        throw new Error("attachment_metadata_invalid");
      }
      if (
        metadata.sizeBytes > ATTACHMENT_LIMITS.maxFileBytes
      ) {
        throw new Error("attachment_file_too_large");
      }
      totalBytes += metadata.sizeBytes;
      if (
        totalBytes > ATTACHMENT_LIMITS.maxMessageBytes
      ) {
        throw new Error("attachment_message_too_large");
      }
    }
  } catch (error) {
    for (const descriptor of descriptors) {
      fetcher.release(descriptor);
    }
    throw error;
  }
}

export async function resolveYuanbaoDownloadUrl(
  input: Readonly<{
    resourceUrl: string;
    apiDomain: string;
    tokenManager: YuanbaoTokenManager;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<string> {
  const source = safeYuanbaoMediaUrl(
    input.resourceUrl,
  );
  if (!source) {
    throw new Error("yuanbao_attachment_url_invalid");
  }
  const parsed = new URL(source);
  const resourceId = parsed.searchParams.get("resourceId");
  if (!resourceId) return source;
  if (
    resourceId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(resourceId)
  ) {
    throw new Error("yuanbao_resource_id_invalid");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = new URL(
    `https://${normalizeApiDomain(input.apiDomain)}${DOWNLOAD_INFO_PATH}`,
  );
  endpoint.searchParams.set("resourceId", resourceId);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    redirect: "error",
    signal: input.signal,
    headers: {
      accept: "application/json",
      ...await input.tokenManager.getAuthHeaders(),
    },
  });
  if (!response.ok || response.redirected) {
    throw new Error("yuanbao_download_info_failed");
  }
  const payload = unwrapData(
    await readBoundedJson(response),
  );
  const resolved = safeYuanbaoMediaUrl(
    string(payload.url) || string(payload.realUrl),
  );
  if (!resolved) {
    throw new Error("yuanbao_download_info_invalid");
  }
  return resolved;
}

export async function requestYuanbaoUploadInfo(
  input: Readonly<{
    fileName: string;
    apiDomain: string;
    tokenManager: YuanbaoTokenManager;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    fileId?: string;
  }>,
): Promise<YuanbaoCosUploadInfo> {
  const fileName = safeFileName(input.fileName);
  if (!fileName) {
    throw new Error("yuanbao_upload_filename_invalid");
  }
  const response = await (input.fetchImpl ?? fetch)(
    `https://${normalizeApiDomain(input.apiDomain)}${UPLOAD_INFO_PATH}`,
    {
      method: "POST",
      redirect: "error",
      signal: input.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...await input.tokenManager.getAuthHeaders(),
      },
      body: JSON.stringify({
        fileName,
        fileId: input.fileId ?? randomUUID().replaceAll("-", ""),
        docFrom: "localDoc",
        docOpenId: "",
      }),
    },
  );
  if (!response.ok || response.redirected) {
    throw new Error("yuanbao_upload_info_failed");
  }
  const data = unwrapData(
    await readBoundedJson(response),
  );
  const result = {
    bucketName: string(data.bucketName),
    region: string(data.region),
    location: string(data.location),
    secretId: string(data.encryptTmpSecretId),
    secretKey: string(data.encryptTmpSecretKey),
    securityToken: string(data.encryptToken),
    startTime: integer(data.startTime),
    expiredTime: integer(data.expiredTime),
    resourceUrl: string(data.resourceUrl),
    resourceId: string(data.resourceID),
  };
  if (
    !result.bucketName
    || !result.region
    || !result.location
    || !result.secretId
    || !result.secretKey
    || !safeYuanbaoMediaUrl(result.resourceUrl)
    || result.expiredTime <= result.startTime
  ) {
    throw new Error("yuanbao_upload_info_invalid");
  }
  return result;
}

export function generateYuanbaoCosAuthorization(
  input: Readonly<{
    secretId: string;
    secretKey: string;
    method: string;
    pathname: string;
    headers: Readonly<Record<string, string>>;
    startTime: number;
    expiredTime: number;
  }>,
): string {
  const keyTime = `${input.startTime};${input.expiredTime}`;
  const signKey = hmacSha1(input.secretKey, keyTime);
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [
      name.toLowerCase(),
      value,
    ] as const)
    .sort(([left], [right]) =>
      left.localeCompare(right)
    );
  const headerList = entries
    .map(([name]) => name)
    .join(";");
  const httpHeaders = entries
    .map(([name, value]) =>
      `${name}=${encodeURIComponent(value)}`
    )
    .join("&");
  const httpString =
    `${input.method.toLowerCase()}\n`
    + `${input.pathname}\n\n${httpHeaders}\n`;
  const stringToSign =
    `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${input.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

export async function uploadYuanbaoMedia(
  input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    apiDomain: string;
    tokenManager: YuanbaoTokenManager;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{
  resourceUrl: string;
  resourceId: string;
  digest: string;
  sizeBytes: number;
}>> {
  if (
    input.bytes.byteLength <= 0
    || input.bytes.byteLength
      > ATTACHMENT_LIMITS.maxMessageBytes
  ) {
    throw new Error("yuanbao_upload_size_invalid");
  }
  const upload = await requestYuanbaoUploadInfo({
    fileName: input.fileName,
    apiDomain: input.apiDomain,
    tokenManager: input.tokenManager,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const pathname = upload.location.startsWith("/")
    ? upload.location
    : `/${upload.location}`;
  const host =
    `${upload.bucketName}.cos.${upload.region}.myqcloud.com`;
  if (!safeYuanbaoHost(host)) {
    throw new Error("yuanbao_cos_host_invalid");
  }
  const signedHeaders: Record<string, string> = {
    host,
    "content-length": String(input.bytes.byteLength),
    ...(upload.securityToken
      ? { "x-cos-security-token": upload.securityToken }
      : {}),
  };
  const response = await (input.fetchImpl ?? fetch)(
    `https://${host}${pathname}`,
    {
      method: "PUT",
      redirect: "error",
      signal: input.signal,
      headers: {
        "content-type": input.mimeType,
        ...(upload.securityToken
          ? {
              "x-cos-security-token":
                upload.securityToken,
            }
          : {}),
        authorization: generateYuanbaoCosAuthorization({
          secretId: upload.secretId,
          secretKey: upload.secretKey,
          method: "PUT",
          pathname,
          headers: signedHeaders,
          startTime: upload.startTime,
          expiredTime: upload.expiredTime,
        }),
      },
      body: Buffer.from(input.bytes),
    },
  );
  if (
    ![200, 204].includes(response.status)
    || response.redirected
  ) {
    throw new Error("yuanbao_cos_upload_failed");
  }
  return {
    resourceUrl: upload.resourceUrl,
    resourceId: upload.resourceId,
    digest: createHash("md5")
      .update(input.bytes)
      .digest("hex"),
    sizeBytes: input.bytes.byteLength,
  };
}

export function safeYuanbaoMediaUrl(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || !safeYuanbaoHost(parsed.hostname)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeYuanbaoHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return [
    "qq.com",
    "qcloud.com",
    "myqcloud.com",
    "tencent.com",
  ].some((suffix) =>
    normalized === suffix
    || normalized.endsWith(`.${suffix}`)
  );
}

function normalizeApiDomain(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (
    !normalized
    || normalized.includes("/")
    || normalized.includes("@")
  ) {
    throw new Error("yuanbao_api_domain_invalid");
  }
  return normalized;
}

async function readBoundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedResponse(
    response,
    MAX_API_RESPONSE_BYTES,
  );
  try {
    return asRecord(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
  } catch {
    throw new Error("yuanbao_api_response_invalid");
  }
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(
      await response.arrayBuffer(),
    );
    if (bytes.byteLength > limit) {
      throw new Error("yuanbao_response_too_large");
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("yuanbao_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safeContentLength(
  value: string | null,
): number | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function fileNameFromUrl(value: string): string {
  try {
    return safeFileName(
      decodeURIComponent(
        path.basename(new URL(value).pathname),
      ),
    ) ?? "attachment";
  } catch {
    return "attachment";
  }
}

function safeFileName(value: string): string | null {
  const normalized = path
    .basename(value.replaceAll("\\", "/"))
    .trim();
  return normalized
    && normalized.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function unwrapData(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const nested = asRecord(value.data);
  return Object.keys(nested).length > 0
    ? nested
    : value;
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : 0;
}

function hmacSha1(key: string, value: string): string {
  return createHmac("sha1", key)
    .update(value, "utf8")
    .digest("hex");
}

function sha1(value: string): string {
  return createHash("sha1")
    .update(value, "utf8")
    .digest("hex");
}
