import {
  createHash,
  X509Certificate,
} from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const RESTRICTED_ENVIRONMENT_NAMES = new Set([
  ["DATA", "BASE_URL"],
  ["CHANNEL_SECRETS", "_KEY"],
  ["DINGTALK_ROBOT", "_CODE"],
  ["CHANNEL_NODE_TLS_KEY", "_PATH"],
  ["SEARCH", "_PROVIDER"],
  ["SSH_AUTH", "_SOCK"],
  ["PG", "PASSWORD"],
  ["NODE", "_OPTIONS"],
  ["NODE", "_PATH"],
  ["LD", "_PRELOAD"],
  ["DYLD_INSERT", "_LIBRARIES"],
].map((parts) => parts.join("")));
const RESTRICTED_ENVIRONMENT_SUFFIX =
  /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|CREDENTIALS)$/;

const absolutePath = z
  .string()
  .min(1)
  .refine(path.isAbsolute, {
    message: "channel_node_path_must_be_absolute",
  });

export const channelNodeConfigSchema = z
  .object({
    nodeId: z.string().uuid(),
    serverUrl: z
      .string()
      .url()
      .superRefine((value, context) => {
        const url = new URL(value);
        if (
          url.protocol !== "wss:"
          || url.pathname !== "/channel-node"
          || url.username
          || url.password
          || url.search
          || url.hash
        ) {
          context.addIssue({
            code: "custom",
            message: "channel_node_server_url_invalid",
          });
        }
      }),
    caPath: absolutePath,
    certificatePath: absolutePath,
    keyPath: absolutePath,
    connectionIds: z
      .array(z.string().uuid())
      .min(1)
      .max(256)
      .refine(
        (values) => new Set(values).size === values.length,
        { message: "channel_node_connection_ids_duplicate" },
      ),
  })
  .strict();

export type ChannelNodeConfig = z.infer<
  typeof channelNodeConfigSchema
>;

export type ChannelNodeTlsMaterial = Readonly<{
  ca: Buffer;
  certificate: Buffer;
  key: Buffer;
  certificateFingerprint: string;
}>;

export function assertRestrictedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      value
      && (
        RESTRICTED_ENVIRONMENT_NAMES.has(normalizedName)
        || RESTRICTED_ENVIRONMENT_SUFFIX.test(
          normalizedName,
        )
      )
    ) {
      throw new Error(
        `channel_node_forbidden_environment:${name}`,
      );
    }
  }
}

export async function loadChannelNodeConfig(
  configPath: string,
  environment: Readonly<
    Record<string, string | undefined>
  > = process.env,
): Promise<Readonly<{
  config: ChannelNodeConfig;
  tls: ChannelNodeTlsMaterial;
}>> {
  assertRestrictedEnvironment(environment);
  const raw = JSON.parse(
    (
      await readCheckedFile(configPath, true)
    ).toString("utf8"),
  ) as unknown;
  const config = channelNodeConfigSchema.parse(raw);
  const [ca, certificate, key] = await Promise.all([
    readCheckedFile(config.caPath, false),
    readCheckedFile(config.certificatePath, true),
    readCheckedFile(config.keyPath, true),
  ]);
  return {
    config,
    tls: {
      ca,
      certificate,
      key,
      certificateFingerprint:
        createCertificateFingerprint(certificate),
    },
  };
}

export function createCertificateFingerprint(
  certificate: Buffer,
): string {
  try {
    return createHash("sha256")
      .update(new X509Certificate(certificate).raw)
      .digest("hex");
  } catch {
    throw new Error("channel_node_certificate_invalid");
  }
}

async function readCheckedFile(
  filePath: string,
  privateMode: boolean,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("channel_node_file_invalid");
    }
    if (
      privateMode
      && (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "channel_node_private_file_mode_invalid",
      );
    }
    if (
      !privateMode
      && (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("channel_node_trust_file_writable");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
