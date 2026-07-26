import {
  constants,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createDecipheriv,
  scrypt,
} from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const scryptAsync = promisify(scrypt);
const encryptedBundleSchema = z
  .object({
    format: z.literal("digitalmate-channel-node-v1"),
    algorithm: z.literal("A256GCM"),
    salt: z.string().min(1).max(128),
    iv: z.string().min(1).max(128),
    ciphertext: z.string().min(1).max(1024 * 1024),
    auth_tag: z.string().min(1).max(128),
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal(1),
    node: z
      .object({
        id: z.string().uuid(),
        server_url: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === "wss:"
              && url.pathname === "/channel-node"
              && !url.username
              && !url.password
              && !url.search
              && !url.hash
            );
          }),
        connection_ids: z
          .array(z.string().uuid())
          .min(1)
          .max(256),
      })
      .strict(),
    files: z
      .object({
        certificate_authority: z
          .string()
          .min(1)
          .max(64 * 1024),
        certificate: z
          .string()
          .min(1)
          .max(64 * 1024),
        private_key: z
          .string()
          .min(1)
          .max(64 * 1024),
      })
      .strict(),
  })
  .strict();

export async function installChannelNodeBundle(input: Readonly<{
  bundlePath: string;
  tokenPath: string;
  targetDirectory: string;
}>): Promise<string> {
  for (const candidate of [
    input.bundlePath,
    input.tokenPath,
    input.targetDirectory,
  ]) {
    if (!path.isAbsolute(candidate)) {
      throw new Error("channel_node_install_path_absolute");
    }
  }
  const [bundleRaw, tokenRaw] = await Promise.all([
    readFile(input.bundlePath, "utf8"),
    readPrivateToken(input.tokenPath),
  ]);
  const bundle = encryptedBundleSchema.parse(
    JSON.parse(bundleRaw) as unknown,
  );
  let payload: z.infer<typeof payloadSchema>;
  try {
    const token = tokenRaw.toString("utf8").trim();
    if (token.length < 32 || token.length > 256) {
      throw new Error("channel_node_enrollment_token_invalid");
    }
    payload = payloadSchema.parse(
      await decryptBundle(bundle, token),
    );
  } finally {
    tokenRaw.fill(0);
  }

  let created = false;
  try {
    await mkdir(input.targetDirectory, {
      mode: 0o700,
      recursive: false,
    });
    created = true;
    const caPath = path.join(input.targetDirectory, "ca.pem");
    const certificatePath = path.join(
      input.targetDirectory,
      "node.pem",
    );
    const keyPath = path.join(
      input.targetDirectory,
      "node.key",
    );
    const configPath = path.join(
      input.targetDirectory,
      "node.json",
    );
    await Promise.all([
      writeFile(
        caPath,
        payload.files.certificate_authority,
        { mode: 0o644, flag: "wx" },
      ),
      writeFile(
        certificatePath,
        payload.files.certificate,
        { mode: 0o600, flag: "wx" },
      ),
      writeFile(
        keyPath,
        payload.files.private_key,
        { mode: 0o600, flag: "wx" },
      ),
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify({
        nodeId: payload.node.id,
        serverUrl: payload.node.server_url,
        caPath,
        certificatePath,
        keyPath,
        connectionIds: payload.node.connection_ids,
      }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return configPath;
  } catch (error) {
    if (created) {
      await rm(input.targetDirectory, {
        recursive: true,
        force: true,
      });
    }
    throw error;
  }
}

async function readPrivateToken(
  filePath: string,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > 256
    ) {
      throw new Error(
        "channel_node_enrollment_token_file_invalid",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function decryptBundle(
  bundle: z.infer<typeof encryptedBundleSchema>,
  token: string,
): Promise<unknown> {
  try {
    const salt = Buffer.from(bundle.salt, "base64url");
    const iv = Buffer.from(bundle.iv, "base64url");
    const tag = Buffer.from(bundle.auth_tag, "base64url");
    const ciphertext = Buffer.from(
      bundle.ciphertext,
      "base64url",
    );
    if (
      salt.length !== 16
      || iv.length !== 12
      || tag.length !== 16
      || ciphertext.length === 0
    ) {
      throw new Error("channel_node_bundle_ciphertext_invalid");
    }
    const key = Buffer.from(
      await scryptAsync(token, salt, 32) as ArrayBuffer,
    );
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        iv,
      );
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } finally {
      key.fill(0);
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message ===
        "channel_node_bundle_ciphertext_invalid"
    ) {
      throw error;
    }
    throw new Error("channel_node_bundle_decryption_failed");
  }
}
