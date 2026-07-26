import type {
  IMessageDatabaseRow,
} from "./database.js";

export type IMessageAttachment = Readonly<{
  guid: string;
  path: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}>;

export type NormalizedIMessageEvent = Readonly<{
  connectionId: string;
  externalEventId: string;
  externalConversationId: string;
  externalSenderId: string;
  chatType: "direct";
  mentioned: false;
  text: string;
  occurredAt: string;
  rawSummary: Readonly<{
    rowid: number;
    chatRowid: number;
  }>;
  attachments: readonly IMessageAttachment[];
}>;

const APPLE_EPOCH_MILLISECONDS = 978_307_200_000;

export function pollMessages(input: Readonly<{
  connectionId: string;
  lastRowId: number;
  rows: readonly IMessageDatabaseRow[];
  botPrefix: string;
  receivedAt: Date;
}>): NormalizedIMessageEvent[] {
  assertCursor(input.lastRowId);
  return [...input.rows]
    .sort((left, right) => rowId(left) - rowId(right))
    .flatMap((row) => {
      const normalized = normalizeRow(row, input);
      return normalized ? [normalized] : [];
    });
}

function normalizeRow(
  row: IMessageDatabaseRow,
  input: Readonly<{
    connectionId: string;
    lastRowId: number;
    botPrefix: string;
    receivedAt: Date;
  }>,
): NormalizedIMessageEvent | null {
  const messageRowId = rowId(row);
  if (
    messageRowId <= input.lastRowId
    || fromMe(row.is_from_me)
  ) {
    return null;
  }
  const chatRowId = positiveInteger(row.chat_rowid);
  const sender = safeString(row.sender, 1_024);
  if (!chatRowId || !sender || isGroup(row)) return null;
  const attachments = parseAttachments(row.attachments);
  const text = typeof row.text === "string"
    ? row.text
    : "";
  if (
    (text.length === 0 && attachments.length === 0)
    || (
      input.botPrefix.length > 0
      && text.startsWith(input.botPrefix)
    )
    || text.length > 1024 * 1024
  ) {
    return null;
  }
  return {
    connectionId: input.connectionId,
    externalEventId: `imessage:rowid:${messageRowId}`,
    externalConversationId: `chat:${chatRowId}`,
    externalSenderId: sender,
    chatType: "direct",
    mentioned: false,
    text,
    occurredAt: occurredAt(row, input.receivedAt),
    rawSummary: {
      rowid: messageRowId,
      chatRowid: chatRowId,
    },
    attachments,
  };
}

function rowId(row: IMessageDatabaseRow): number {
  const value = positiveInteger(row.rowid);
  if (!value) throw new Error("imessage_rowid_invalid");
  return value;
}

function fromMe(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function isGroup(row: IMessageDatabaseRow): boolean {
  const participants = positiveInteger(row.participant_count);
  const identifier = typeof row.chat_identifier === "string"
    ? row.chat_identifier.toLowerCase()
    : "";
  return (participants ?? 1) > 1
    || identifier.startsWith("chat");
}

function parseAttachments(
  value: unknown,
): IMessageAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error("imessage_attachment_count_invalid");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("imessage_attachment_metadata_invalid");
    }
    const record = item as Record<string, unknown>;
    const attachmentPath = safeString(record.path, 4_096);
    if (!attachmentPath) {
      throw new Error("imessage_attachment_path_invalid");
    }
    const guid = safeString(record.guid, 1_024)
      ?? `index-${index + 1}`;
    return {
      guid,
      path: attachmentPath,
      fileName: nullableString(record.fileName, 1_024),
      mimeType: nullableString(record.mimeType, 256),
      sizeBytes: nullableSize(record.sizeBytes),
    };
  });
}

function occurredAt(
  row: IMessageDatabaseRow,
  fallback: Date,
): string {
  if (typeof row.occurred_at === "string") {
    const timestamp = new Date(row.occurred_at);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  if (typeof row.date === "number" && Number.isFinite(row.date)) {
    const appleMilliseconds = Math.abs(row.date) > 10_000_000_000
      ? row.date / 1_000_000
      : row.date * 1_000;
    const timestamp = new Date(
      APPLE_EPOCH_MILLISECONDS + appleMilliseconds,
    );
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  return fallback.toISOString();
}

function nullableSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function nullableString(
  value: unknown,
  maximum: number,
): string | null {
  return safeString(value, maximum);
}

function safeString(
  value: unknown,
  maximum: number,
): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("imessage_cursor_invalid");
  }
}
