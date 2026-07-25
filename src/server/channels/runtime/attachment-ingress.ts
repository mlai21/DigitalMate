import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import { extractAttachmentText } from "@/server/attachments/extraction";
import {
  createAttachmentStorageKey,
  deleteAttachment,
  saveAttachment,
} from "@/server/attachments/storage";
import { ATTACHMENT_LIMITS, type AttachmentKind } from "@/server/attachments/types";
import {
  validateAttachmentFile,
  validateAttachmentMetadata,
} from "@/server/attachments/validation";
import {
  encryptedSecretFromStorage,
  type ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

import type { InboundAttachmentDescriptor } from "./types";

export type InboundAttachmentMetadata = Readonly<{
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}>;

export type InboundAttachmentFetcher = Readonly<{
  inspect(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ): Promise<InboundAttachmentMetadata>;
  download(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
}>;

type AttachmentDraftRepository = Readonly<{
  createDraft(
    scope: AgentScope,
    input: {
      kind: AttachmentKind;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      extractedText: string | null;
      textTruncated: boolean;
    },
  ): Promise<{ id: string }>;
  markReady(
    scope: AgentScope,
    attachmentId: string,
  ): Promise<unknown>;
  markFailed(
    scope: AgentScope,
    attachmentId: string,
    errorCode: string,
  ): Promise<void>;
}>;

export type DownloadInboundAttachmentInput = Readonly<{
  scope: AgentScope;
  descriptor: InboundAttachmentDescriptor;
  fetcher: InboundAttachmentFetcher;
  storageRoot: string;
  repository: AttachmentDraftRepository;
  bindPrivateAttachment: (attachmentId: string) => Promise<void>;
  signal?: AbortSignal;
}>;

export type DownloadedInboundAttachment = Readonly<{
  attachmentId: string;
  storageKey: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}>;

type StoredAttachmentLocatorRow = {
  id: string;
  connection_id: string;
  source_locator_ciphertext: Buffer | null;
  source_locator_nonce: Buffer | null;
  source_locator_auth_tag: Buffer | null;
  source_locator_key_version: number | null;
};

const MAX_LOCATOR_BYTES = 64 * 1024;
const MAX_LOCATOR_LEASE_MS = 24 * 60 * 60 * 1_000;

export function createChannelAttachmentLocatorRepository(
  pool: Pool,
  key: ChannelSecretsKey,
) {
  return {
    async persist(
      scope: AgentScope,
      eventId: string,
      connectionId: string,
      descriptor: InboundAttachmentDescriptor,
      expiresAt: Date,
      now = new Date(),
    ): Promise<boolean> {
      validateLocatorExpiry(expiresAt, now);
      const plaintext = serializeLocator(descriptor.source);
      const encrypted = key.encrypt(plaintext, {
        userId: scope.userId,
        agentId: scope.agentId,
        connectionId,
        fieldName: locatorFieldName(
          eventId,
          descriptor.externalAttachmentId,
        ),
      }).toStorageRecord();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO channel_event_attachments (
           user_id, agent_id, event_id, connection_id,
           external_attachment_id, file_name, declared_mime_type,
           declared_size_bytes, source_locator_ciphertext,
           source_locator_nonce, source_locator_auth_tag,
           source_locator_key_version, locator_expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13
         )
         ON CONFLICT (event_id, external_attachment_id) DO UPDATE
         SET source_locator_ciphertext =
               EXCLUDED.source_locator_ciphertext,
             source_locator_nonce = EXCLUDED.source_locator_nonce,
             source_locator_auth_tag =
               EXCLUDED.source_locator_auth_tag,
             source_locator_key_version =
               EXCLUDED.source_locator_key_version,
             locator_expires_at = EXCLUDED.locator_expires_at,
             file_name = EXCLUDED.file_name,
             declared_mime_type = EXCLUDED.declared_mime_type,
             declared_size_bytes = EXCLUDED.declared_size_bytes
         WHERE channel_event_attachments.private_attachment_id IS NULL
           AND channel_event_attachments.locator_cleared_at IS NULL
         RETURNING id`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          connectionId,
          descriptor.externalAttachmentId,
          descriptor.fileName,
          descriptor.mimeType,
          descriptor.sizeBytes,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          expiresAt,
        ],
      );
      return result.rowCount === 1;
    },

    async loadSource(
      scope: AgentScope,
      eventId: string,
      externalAttachmentId: string,
      now = new Date(),
    ): Promise<Readonly<Record<string, string>> | null> {
      const result = await pool.query<StoredAttachmentLocatorRow>(
        `SELECT id, connection_id, source_locator_ciphertext,
                source_locator_nonce, source_locator_auth_tag,
                source_locator_key_version
         FROM channel_event_attachments
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3
           AND external_attachment_id = $4
           AND locator_cleared_at IS NULL
           AND locator_expires_at > $5`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          externalAttachmentId,
          now,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (
        row.source_locator_ciphertext === null
        || row.source_locator_nonce === null
        || row.source_locator_auth_tag === null
        || row.source_locator_key_version === null
      ) {
        throw stableError("attachment_locator_invalid");
      }
      const plaintext = key.decrypt(
        encryptedSecretFromStorage({
          ciphertext: row.source_locator_ciphertext,
          nonce: row.source_locator_nonce,
          authTag: row.source_locator_auth_tag,
          keyVersion: row.source_locator_key_version,
        }),
        {
          userId: scope.userId,
          agentId: scope.agentId,
          connectionId: row.connection_id,
          fieldName: locatorFieldName(
            eventId,
            externalAttachmentId,
          ),
        },
      );
      return parseLocator(plaintext);
    },

    async bindPrivateAttachment(
      scope: AgentScope,
      eventId: string,
      externalAttachmentId: string,
      attachmentId: string,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_event_attachments
         SET private_attachment_id = $5,
             source_locator_ciphertext = NULL,
             source_locator_nonce = NULL,
             source_locator_auth_tag = NULL,
             source_locator_key_version = NULL,
             locator_cleared_at = $6
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3
           AND external_attachment_id = $4
           AND private_attachment_id IS NULL
           AND locator_cleared_at IS NULL`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          externalAttachmentId,
          attachmentId,
          now,
        ],
      );
      return result.rowCount === 1;
    },

    async clearExpired(now = new Date()): Promise<number> {
      const result = await pool.query(
        `UPDATE channel_event_attachments
         SET source_locator_ciphertext = NULL,
             source_locator_nonce = NULL,
             source_locator_auth_tag = NULL,
             source_locator_key_version = NULL,
             locator_cleared_at = $1
         WHERE locator_cleared_at IS NULL
           AND locator_expires_at <= $1`,
        [now],
      );
      return result.rowCount ?? 0;
    },
  };
}

export async function downloadInboundAttachment(
  input: DownloadInboundAttachmentInput,
): Promise<DownloadedInboundAttachment> {
  const metadata = await inspectAttachment(input);
  input.signal?.throwIfAborted();
  if (metadata.sizeBytes === 0) {
    throw stableError("attachment_file_empty");
  }
  assertDeclaredMetadata(input.descriptor, metadata);
  const validatedMetadata = validateAttachmentMetadata({
    fileName: metadata.fileName,
    declaredMime: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
  });

  const storageRoot = path.resolve(input.storageRoot);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await chmod(storageRoot, 0o700);
  const temporaryPath = path.resolve(
    storageRoot,
    `.inbound.${randomUUID()}.tmp`,
  );
  if (!temporaryPath.startsWith(`${storageRoot}${path.sep}`)) {
    throw stableError("attachment_invalid_storage_key");
  }

  let draftId: string | null = null;
  let storageKey: string | null = null;
  try {
    const stream = await openAttachmentStream(input);
    await writePrivateStream(
      temporaryPath,
      stream,
      metadata.sizeBytes,
      input.signal,
    );
    const bytes = await readFile(temporaryPath);
    input.signal?.throwIfAborted();
    const validated = validateAttachmentFile({
      fileName: validatedMetadata.fileName,
      declaredMime: validatedMetadata.mimeType,
      bytes,
    });
    const extracted = validated.kind === "document"
      ? await extractAttachmentText({
          mimeType: validated.mimeType,
          bytes,
        })
      : null;
    input.signal?.throwIfAborted();

    storageKey = createAttachmentStorageKey();
    const draft = await input.repository.createDraft(input.scope, {
      kind: validated.kind,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      storageKey,
      extractedText: extracted?.text ?? null,
      textTruncated: extracted?.truncated ?? false,
    });
    draftId = draft.id;
    await saveAttachment(storageRoot, storageKey, bytes);
    input.signal?.throwIfAborted();
    const ready = await input.repository.markReady(input.scope, draft.id);
    if (ready === null) {
      throw stableError("attachment_ready_transition_failed");
    }
    await input.bindPrivateAttachment(draft.id);

    return {
      attachmentId: draft.id,
      storageKey,
      kind: validated.kind,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
    };
  } catch (error) {
    const safeError = toSafeAttachmentError(error);
    if (draftId !== null) {
      await input.repository.markFailed(
        input.scope,
        draftId,
        safeError.message,
      ).catch(() => undefined);
    }
    if (storageKey !== null) {
      await deleteAttachment(storageRoot, storageKey)
        .catch(() => undefined);
    }
    throw safeError;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function buildChannelTurnSecurityContext(input: {
  currentAttachmentCount: number;
  historicalAttachmentCount: number;
  explicitSkillIds: readonly string[];
}): Readonly<{
  attachmentToolGuard: boolean;
  explicitSkillIds: string[];
  webSearchEnabled: false;
}> {
  const attachmentToolGuard =
    input.currentAttachmentCount > 0
    || input.historicalAttachmentCount > 0;
  return {
    attachmentToolGuard,
    explicitSkillIds: attachmentToolGuard
      ? []
      : [...input.explicitSkillIds],
    webSearchEnabled: false,
  };
}

async function inspectAttachment(
  input: DownloadInboundAttachmentInput,
): Promise<InboundAttachmentMetadata> {
  try {
    return await input.fetcher.inspect(
      input.descriptor,
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) {
      throw stableError("attachment_download_aborted");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw stableError("attachment_download_aborted");
    }
    throw stableError("attachment_metadata_unavailable");
  }
}

async function openAttachmentStream(
  input: DownloadInboundAttachmentInput,
): Promise<AsyncIterable<Uint8Array>> {
  try {
    return await input.fetcher.download(
      input.descriptor,
      input.signal,
    );
  } catch {
    throw stableError("attachment_download_failed");
  }
}

async function writePrivateStream(
  temporaryPath: string,
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(temporaryPath, "wx", 0o600);
  let totalBytes = 0;
  let primaryError: unknown;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > ATTACHMENT_LIMITS.maxFileBytes) {
        throw stableError("attachment_file_too_large");
      }
      if (totalBytes > expectedBytes) {
        throw stableError("attachment_size_mismatch");
      }
      await handle.write(bytes);
    }
    if (totalBytes !== expectedBytes) {
      throw stableError("attachment_size_mismatch");
    }
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (primaryError === undefined) {
        throw error;
      }
    }
  }
}

function assertDeclaredMetadata(
  descriptor: InboundAttachmentDescriptor,
  inspected: InboundAttachmentMetadata,
): void {
  if (
    (descriptor.fileName !== null
      && descriptor.fileName !== inspected.fileName)
    || (descriptor.mimeType !== null
      && descriptor.mimeType.toLowerCase()
        !== inspected.mimeType.toLowerCase())
    || (descriptor.sizeBytes !== null
      && descriptor.sizeBytes !== inspected.sizeBytes)
  ) {
    throw stableError("attachment_metadata_mismatch");
  }
}

function stableError(code: string): Error {
  return new Error(code);
}

function toSafeAttachmentError(error: unknown): Error {
  if (
    error instanceof Error
    && error.message.startsWith("attachment_")
  ) {
    return stableError(error.message);
  }
  if (
    error instanceof Error
    && error.name === "AbortError"
  ) {
    return stableError("attachment_download_aborted");
  }
  return stableError("attachment_download_failed");
}

function serializeLocator(
  source: Readonly<Record<string, string>>,
): string {
  const entries = validatedLocatorEntries(source);
  const normalized = Object.fromEntries(entries);
  const serialized = JSON.stringify(normalized);
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_LOCATOR_BYTES
  ) {
    throw stableError("attachment_locator_invalid");
  }
  return serialized;
}

function parseLocator(
  plaintext: string,
): Readonly<Record<string, string>> {
  if (Buffer.byteLength(plaintext, "utf8") > MAX_LOCATOR_BYTES) {
    throw stableError("attachment_locator_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw stableError("attachment_locator_invalid");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    throw stableError("attachment_locator_invalid");
  }
  return Object.fromEntries(
    validatedLocatorEntries(parsed as Record<string, string>),
  );
}

function validatedLocatorEntries(
  source: Readonly<Record<string, string>>,
): Array<[string, string]> {
  const entries = Object.entries(source);
  if (
    entries.length === 0
    || entries.length > 32
    || entries.some(([name, value]) =>
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(name)
      || name === "__proto__"
      || name === "constructor"
      || name === "prototype"
      || typeof value !== "string"
      || Buffer.byteLength(value, "utf8") > 12_000
    )
  ) {
    throw stableError("attachment_locator_invalid");
  }
  return entries;
}

function locatorFieldName(
  eventId: string,
  externalAttachmentId: string,
): string {
  const digest = createHash("sha256")
    .update(`${eventId}\0${externalAttachmentId}`)
    .digest("hex")
    .slice(0, 32);
  return `attachment_${digest}`;
}

function validateLocatorExpiry(expiresAt: Date, now: Date): void {
  const leaseMs = expiresAt.getTime() - now.getTime();
  if (
    !Number.isFinite(leaseMs)
    || leaseMs <= 0
    || leaseMs > MAX_LOCATOR_LEASE_MS
  ) {
    throw stableError("attachment_locator_expiry_invalid");
  }
}
