import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type BinaryFixture = Readonly<{
  bytes: Buffer;
  sha256: string;
}>;

export async function readBinaryFixture(
  file: string,
): Promise<BinaryFixture> {
  const bytes = await readFile(file);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function redactBinaryDiagnostic(
  bytes: Buffer,
  secrets: readonly Buffer[],
): string {
  let hex = bytes.toString("hex");
  const secretHexValues = [
    ...new Set(
      secrets
        .filter((secret) => secret.length > 0)
        .map((secret) => secret.toString("hex")),
    ),
  ].sort((left, right) => right.length - left.length);

  for (const secretHex of secretHexValues) {
    hex = hex.replaceAll(secretHex, "[redacted]");
  }
  return hex.slice(0, 512);
}
