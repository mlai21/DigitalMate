import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IMESSAGE_SQLITE_PATH = "/usr/bin/sqlite3";

export type IMessageDatabaseRow = Readonly<
  Record<string, unknown>
>;

export type IMessageDatabase = Readonly<{
  readStartupCursor(): Promise<number>;
  readAfter(lastRowId: number): Promise<IMessageDatabaseRow[]>;
}>;

export type IMessageExecute = (
  file: string,
  args: readonly string[],
) => Promise<Readonly<{
  stdout: string;
  stderr: string;
}>>;

const STARTUP_CURSOR_SQL =
  "SELECT IFNULL(MAX(ROWID), 0) AS rowid FROM message";

const POLL_SQL = `
SELECT
  m.ROWID AS rowid,
  m.text AS text,
  m.is_from_me AS is_from_me,
  m.date AS date,
  c.ROWID AS chat_rowid,
  c.chat_identifier AS chat_identifier,
  h.id AS sender,
  (
    SELECT COUNT(*)
    FROM chat_handle_join AS chj
    WHERE chj.chat_id = c.ROWID
  ) AS participant_count,
  COALESCE((
    SELECT json_group_array(json_object(
      'guid', a.guid,
      'path', a.filename,
      'fileName', a.transfer_name,
      'mimeType', a.mime_type,
      'sizeBytes', a.total_bytes
    ))
    FROM message_attachment_join AS maj
    JOIN attachment AS a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = m.ROWID
  ), '[]') AS attachments_json
FROM message AS m
JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
JOIN chat AS c ON c.ROWID = cmj.chat_id
LEFT JOIN handle AS h ON h.ROWID = m.handle_id
WHERE m.ROWID > ?1
ORDER BY m.ROWID ASC
`.trim();

export function createIMessageDatabase(input: Readonly<{
  dbPath: string;
  execute?: IMessageExecute;
}>): IMessageDatabase {
  const execute = input.execute ?? executeFileJson;
  return {
    readStartupCursor(): Promise<number> {
      return execute(
        IMESSAGE_SQLITE_PATH,
        [
          "-readonly",
          "-json",
          input.dbPath,
          STARTUP_CURSOR_SQL,
        ],
      ).then(({ stdout }) => {
        const rows = parseRows(stdout);
        const rowId = rows[0]?.rowid;
        return safeRowId(rowId, true);
      });
    },

    readAfter(lastRowId: number): Promise<IMessageDatabaseRow[]> {
      assertCursor(lastRowId);
      return execute(
        IMESSAGE_SQLITE_PATH,
        [
          "-readonly",
          "-json",
          "-cmd",
          ".parameter init",
          "-cmd",
          `.parameter set ?1 ${lastRowId}`,
          input.dbPath,
          POLL_SQL,
        ],
      ).then(({ stdout }) =>
        parseRows(stdout).map(parseAttachmentJson)
      );
    },
  };
}

function executeFileJson(
  file: string,
  args: readonly string[],
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

function parseRows(stdout: string): IMessageDatabaseRow[] {
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) {
    throw new Error("imessage_database_response_too_large");
  }
  let parsed: unknown;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    throw new Error("imessage_database_response_invalid");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length > 10_000
    || parsed.some((row) =>
      !row || typeof row !== "object" || Array.isArray(row)
    )
  ) {
    throw new Error("imessage_database_response_invalid");
  }
  return parsed as IMessageDatabaseRow[];
}

function parseAttachmentJson(
  row: IMessageDatabaseRow,
): IMessageDatabaseRow {
  const encoded = row.attachments_json;
  if (encoded === undefined) return row;
  if (typeof encoded !== "string" || encoded.length > 4_194_304) {
    throw new Error("imessage_attachment_metadata_invalid");
  }
  let attachments: unknown;
  try {
    attachments = JSON.parse(encoded);
  } catch {
    throw new Error("imessage_attachment_metadata_invalid");
  }
  if (!Array.isArray(attachments) || attachments.length > 32) {
    throw new Error("imessage_attachment_metadata_invalid");
  }
  const {
    attachments_json: _encoded,
    ...rest
  } = row;
  void _encoded;
  return { ...rest, attachments };
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("imessage_cursor_invalid");
  }
}

function safeRowId(value: unknown, allowZero: boolean): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (allowZero ? 0 : 1)
  ) {
    throw new Error("imessage_rowid_invalid");
  }
  return parsed;
}
