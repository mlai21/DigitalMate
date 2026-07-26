import {
  createHash,
} from "node:crypto";

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

import {
  decryptWechatMedia,
} from "./crypto";

const WECHAT_CDN_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c/download";

export type WechatAttachmentFetcher =
  InboundAttachmentFetcher
  & Readonly<{
    release(
      descriptor: InboundAttachmentDescriptor,
    ): void;
  }>;

type LocatorWriter = Readonly<{
  persist(
    scope: AgentScope,
    eventId: string,
    connectionId: string,
    descriptor: InboundAttachmentDescriptor,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
}>;

export function createWechatAttachmentFetcher(
  input: Readonly<{
    fetchImpl?: typeof fetch;
  }> = {},
): WechatAttachmentFetcher {
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

  function cacheKey(
    descriptor: InboundAttachmentDescriptor,
  ): string {
    return createHash("sha256")
      .update(
        `${descriptor.source.encryptedQueryParam ?? ""}\0${
          descriptor.source.aesKey ?? ""
        }`,
      )
      .digest("hex");
  }

  function load(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    const key = cacheKey(descriptor);
    const existing = cache.get(key);
    if (existing) return existing;
    if (cache.size >= ATTACHMENT_LIMITS.maxCount) {
      return Promise.reject(
        new Error("wechat_attachment_cache_full"),
      );
    }
    const pending = fetchAttachment(
      descriptor,
      signal,
    ).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }

  function release(
    descriptor: InboundAttachmentDescriptor,
  ): void {
    cache.delete(cacheKey(descriptor));
  }

  async function fetchAttachment(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    const encryptedQueryParam =
      descriptor.source.encryptedQueryParam;
    const aesKey = descriptor.source.aesKey;
    if (!encryptedQueryParam || !aesKey) {
      throw new Error("wechat_attachment_locator_invalid");
    }
    const url = new URL(WECHAT_CDN_URL);
    url.searchParams.set(
      "encrypted_query_param",
      encryptedQueryParam,
    );
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) {
      throw new Error("wechat_attachment_download_failed");
    }
    const encrypted = await readBounded(
      response,
      ATTACHMENT_LIMITS.maxFileBytes + 16,
    );
    const bytes = decryptWechatMedia(encrypted, aesKey);
    if (
      bytes.byteLength === 0
      || bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes
    ) {
      throw new Error("attachment_file_too_large");
    }
    return {
      bytes,
      fileName:
        descriptor.fileName ?? "attachment.bin",
      mimeType:
        descriptor.mimeType
        ?? "application/octet-stream",
    };
  }
}

export async function prepareWechatAttachmentBatch(
  input: Readonly<{
    scope: AgentScope;
    eventId: string;
    connectionId: string;
    descriptors: readonly InboundAttachmentDescriptor[];
    expiresAt: Date;
    receivedAt: Date;
    locators: LocatorWriter;
    fetcher: WechatAttachmentFetcher;
    signal?: AbortSignal;
  }>,
): Promise<readonly InboundAttachmentDescriptor[]> {
  if (
    input.descriptors.length
    > ATTACHMENT_LIMITS.maxCount
  ) {
    throw new Error("attachment_count_exceeded");
  }
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
  let totalBytes = 0;
  try {
    for (const descriptor of pending) {
      const metadata = await input.fetcher.inspect(
        descriptor,
        input.signal,
      );
      totalBytes += metadata.sizeBytes;
      if (
        metadata.sizeBytes <= 0
        || metadata.sizeBytes
          > ATTACHMENT_LIMITS.maxFileBytes
        || totalBytes
          > ATTACHMENT_LIMITS.maxMessageBytes
      ) {
        throw new Error("attachment_message_too_large");
      }
    }
    return pending;
  } catch (error) {
    for (const descriptor of pending) {
      input.fetcher.release(descriptor);
    }
    throw error;
  }
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new Error("wechat_attachment_body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new Error("attachment_file_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
