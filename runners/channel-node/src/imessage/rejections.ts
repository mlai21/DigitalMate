import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";

const MAX_REJECTIONS = 1_000;
const MAX_REJECTION_LOG_BYTES = 1024 * 1024;

export function createIMessageRejectionLog(
  filePath: string,
) {
  let pending = Promise.resolve();
  return {
    record(
      rowId: number,
      errorCode: string,
      rejectedAt = new Date(),
    ): Promise<void> {
      const operation = pending
        .catch(() => undefined)
        .then(async () => {
          assertRejection(rowId, errorCode, rejectedAt);
          const records = await readRecords(filePath);
          records.push({
            rowId,
            errorCode,
            rejectedAt: rejectedAt.toISOString(),
          });
          await writeRecords(
            filePath,
            records.slice(-MAX_REJECTIONS),
          );
        });
      pending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

type RejectionRecord = Readonly<{
  rowId: number;
  errorCode: string;
  rejectedAt: string;
}>;

async function readRecords(
  filePath: string,
): Promise<RejectionRecord[]> {
  try {
    const metadata = await lstat(filePath);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > MAX_REJECTION_LOG_BYTES
    ) {
      throw new Error("imessage_rejection_log_invalid");
    }
    const content = await readFile(filePath, "utf8");
    if (!content) return [];
    return content.trimEnd().split("\n").map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!isRejection(value)) {
        throw new Error("imessage_rejection_log_invalid");
      }
      return value;
    });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function writeRecords(
  filePath: string,
  records: readonly RejectionRecord[],
): Promise<void> {
  await mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  let retained = [...records];
  let body = serialize(retained);
  while (
    Buffer.byteLength(body) > MAX_REJECTION_LOG_BYTES
    && retained.length > 1
  ) {
    retained = retained.slice(1);
    body = serialize(retained);
  }
  if (Buffer.byteLength(body) > MAX_REJECTION_LOG_BYTES) {
    throw new Error("imessage_rejection_log_limit_exceeded");
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function serialize(records: readonly RejectionRecord[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) =>
        JSON.stringify(record)
      ).join("\n")}\n`;
}

function assertRejection(
  rowId: number,
  errorCode: string,
  rejectedAt: Date,
): void {
  if (
    !Number.isSafeInteger(rowId)
    || rowId < 1
    || !/^[a-z][a-z0-9_]{0,127}$/u.test(errorCode)
    || !Number.isFinite(rejectedAt.getTime())
  ) {
    throw new Error("imessage_rejection_invalid");
  }
}

function isRejection(value: unknown): value is RejectionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.rowId)
    && Number(record.rowId) > 0
    && typeof record.errorCode === "string"
    && /^[a-z][a-z0-9_]{0,127}$/u.test(record.errorCode)
    && typeof record.rejectedAt === "string"
    && Number.isFinite(new Date(record.rejectedAt).getTime());
}
