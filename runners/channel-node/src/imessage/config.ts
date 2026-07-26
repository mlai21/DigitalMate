import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

const MAX_IMESSAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const absoluteOrHomePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => path.isAbsolute(value) || value.startsWith("~/"),
    { message: "imessage_path_must_be_absolute" },
  );

export const iMessageRunnerConfigSchema = z
  .object({
    connection_id: z.string().uuid(),
    db_path: absoluteOrHomePath.default(
      "~/Library/Messages/chat.db",
    ),
    poll_sec: z.number().min(0.1).max(3_600).default(1),
    media_dir: absoluteOrHomePath.nullable().default(null),
    max_decoded_size: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMESSAGE_ATTACHMENT_BYTES)
      .default(MAX_IMESSAGE_ATTACHMENT_BYTES),
    bot_prefix: z.string().max(1_024).default(""),
  })
  .strict();

export type IMessageRunnerConfig = Readonly<{
  connectionId: string;
  dbPath: string;
  pollMilliseconds: number;
  mediaDirectory: string;
  maxDecodedSize: number;
  botPrefix: string;
}>;

export function resolveIMessageRunnerConfig(
  value: unknown,
  options: Readonly<{
    homeDirectory: string;
    defaultMediaDirectory: string;
  }>,
): IMessageRunnerConfig {
  const parsed = iMessageRunnerConfigSchema.parse(value);
  const homeDirectory = assertAbsolute(
    options.homeDirectory,
  );
  const defaultMediaDirectory = assertAbsolute(
    options.defaultMediaDirectory,
  );
  return {
    connectionId: parsed.connection_id,
    dbPath: expandHome(parsed.db_path, homeDirectory),
    pollMilliseconds: Math.round(parsed.poll_sec * 1_000),
    mediaDirectory: parsed.media_dir
      ? expandHome(parsed.media_dir, homeDirectory)
      : defaultMediaDirectory,
    maxDecodedSize: parsed.max_decoded_size,
    botPrefix: parsed.bot_prefix,
  };
}

export async function loadIMessageRunnerConfigs(
  input: Readonly<{
    nodeConfigPath: string;
    connectionIds: readonly string[];
    homeDirectory?: string;
  }>,
): Promise<IMessageRunnerConfig[]> {
  const nodeDirectory = path.dirname(
    assertAbsolute(input.nodeConfigPath),
  );
  const homeDirectory = input.homeDirectory ?? homedir();
  const configs: IMessageRunnerConfig[] = [];
  for (const connectionId of input.connectionIds) {
    if (!z.string().uuid().safeParse(connectionId).success) {
      throw new Error("imessage_connection_id_invalid");
    }
    const configPath = path.join(
      nodeDirectory,
      "channels",
      "imessage",
      `${connectionId}.json`,
    );
    const value = await readOptionalPrivateConfig(configPath);
    if (value === null) continue;
    const config = resolveIMessageRunnerConfig(value, {
      homeDirectory,
      defaultMediaDirectory: path.join(
        nodeDirectory,
        "media",
        "imessage",
        connectionId,
      ),
    });
    if (config.connectionId !== connectionId) {
      throw new Error("imessage_config_connection_mismatch");
    }
    configs.push(config);
  }
  return configs;
}

async function readOptionalPrivateConfig(
  filePath: string,
): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "imessage_config_private_file_mode_invalid",
      );
    }
    if (metadata.size > 64 * 1024) {
      throw new Error("imessage_config_file_too_large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await handle.readFile()).toString("utf8"),
      );
    } catch {
      throw new Error("imessage_config_invalid");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

function expandHome(value: string, homeDirectory: string): string {
  const resolved = value.startsWith("~/")
    ? path.join(homeDirectory, value.slice(2))
    : value;
  return assertAbsolute(path.normalize(resolved));
}

function assertAbsolute(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("imessage_path_must_be_absolute");
  }
  return value;
}
