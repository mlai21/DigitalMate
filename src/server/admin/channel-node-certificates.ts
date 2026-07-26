import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  scrypt,
  X509Certificate,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import type {
  AdminChannelNodeEncryptedBundle,
} from "@/server/admin/compat/handlers/nodes";

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(scrypt);
const CERTIFICATE_LIFETIME_DAYS = 30;
const OPENSSL_TIMEOUT_MS = 20_000;

export type IssuedChannelNodeCertificate = Readonly<{
  certificate: string;
  privateKey: string;
  fingerprint: Buffer;
  expiresAt: Date;
}>;

export type ChannelNodeCertificateIssuer = (
  input: Readonly<{
    nodeId: string;
    signal?: AbortSignal;
  }>,
) => Promise<IssuedChannelNodeCertificate>;

export function assertIndependentChannelNodeCertificateAuthorities(
  serverTrust: string,
  enrollmentCertificateAuthority: string,
  enrollmentCertificateAuthorityPrivateKey: string,
): void {
  const enrollment = parseTrustAnchor(
    enrollmentCertificateAuthority,
    "channel_node_enrollment_ca_invalid",
  );
  const serverCertificates = parsePemCertificates(
    serverTrust,
  );
  if (serverCertificates.length === 0) {
    throw new Error("channel_node_server_ca_invalid");
  }
  const enrollmentPublicKey =
    enrollment.publicKey.export({
      type: "spki",
      format: "der",
    });
  let configuredEnrollmentPublicKey: Buffer;
  try {
    configuredEnrollmentPublicKey = createPublicKey(
      enrollmentCertificateAuthorityPrivateKey,
    ).export({
      type: "spki",
      format: "der",
    });
  } catch {
    throw new Error(
      "channel_node_enrollment_ca_private_key_invalid",
    );
  }
  if (
    !configuredEnrollmentPublicKey.equals(
      enrollmentPublicKey,
    )
  ) {
    throw new Error(
      "channel_node_enrollment_ca_key_mismatch",
    );
  }
  for (const pem of serverCertificates) {
    const server = parseTrustAnchor(
      pem,
      "channel_node_server_ca_invalid",
    );
    const serverPublicKey = server.publicKey.export({
      type: "spki",
      format: "der",
    });
    if (serverPublicKey.equals(enrollmentPublicKey)) {
      throw new Error(
        "channel_node_certificate_authority_key_reused",
      );
    }
  }
}

export function createOpenSslChannelNodeCertificateIssuer(
  input: Readonly<{
    certificateAuthorityPath: string;
    certificateAuthorityKeyPath: string;
    opensslPath?: string;
  }>,
): ChannelNodeCertificateIssuer {
  const openssl = input.opensslPath ?? "openssl";
  return async ({ nodeId, signal }) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-channel-node-"),
    );
    const keyPath = path.join(directory, "node.key");
    const requestPath = path.join(directory, "node.csr");
    const certificatePath = path.join(
      directory,
      "node.crt",
    );
    const extensionPath = path.join(directory, "client.ext");
    const serialPath = path.join(directory, "ca.srl");
    try {
      await writeFile(
        extensionPath,
        [
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature,keyEncipherment",
          "extendedKeyUsage=critical,clientAuth",
          `subjectAltName=URI:digitalmate:channel-node:${nodeId}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await runOpenSsl(
        openssl,
        [
          "genpkey",
          "-algorithm",
          "EC",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-out",
          keyPath,
        ],
        signal,
      );
      await chmod(keyPath, 0o600);
      await runOpenSsl(
        openssl,
        [
          "req",
          "-new",
          "-key",
          keyPath,
          "-subj",
          `/CN=digitalmate-channel-node-${nodeId}`,
          "-out",
          requestPath,
        ],
        signal,
      );
      await runOpenSsl(
        openssl,
        [
          "x509",
          "-req",
          "-in",
          requestPath,
          "-CA",
          input.certificateAuthorityPath,
          "-CAkey",
          input.certificateAuthorityKeyPath,
          "-CAcreateserial",
          "-CAserial",
          serialPath,
          "-days",
          String(CERTIFICATE_LIFETIME_DAYS),
          "-sha256",
          "-extfile",
          extensionPath,
          "-out",
          certificatePath,
        ],
        signal,
      );
      const [certificate, privateKey] = await Promise.all([
        readFile(certificatePath, "utf8"),
        readFile(keyPath, "utf8"),
      ]);
      const parsed = new X509Certificate(certificate);
      const expiresAt = new Date(parsed.validTo);
      if (!Number.isFinite(expiresAt.getTime())) {
        throw new Error(
          "channel_node_certificate_expiry_invalid",
        );
      }
      return {
        certificate,
        privateKey,
        fingerprint: createHash("sha256")
          .update(parsed.raw)
          .digest(),
        expiresAt,
      };
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  };
}

export async function encryptChannelNodeBundle(
  plaintext: Readonly<Record<string, unknown>>,
  token: string,
): Promise<AdminChannelNodeEncryptedBundle> {
  if (token.length < 32) {
    throw new Error("channel_node_enrollment_token_invalid");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scryptKey(token, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      format: "digitalmate-channel-node-v1",
      algorithm: "A256GCM",
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      auth_tag: authTag.toString("base64url"),
    };
  } finally {
    key.fill(0);
  }
}

export async function decryptChannelNodeBundle(
  bundle: AdminChannelNodeEncryptedBundle,
  token: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (
    bundle.format !== "digitalmate-channel-node-v1"
    || bundle.algorithm !== "A256GCM"
  ) {
    throw new Error("channel_node_bundle_format_invalid");
  }
  try {
    const salt = Buffer.from(bundle.salt, "base64url");
    const iv = Buffer.from(bundle.iv, "base64url");
    const authTag = Buffer.from(
      bundle.auth_tag,
      "base64url",
    );
    const ciphertext = Buffer.from(
      bundle.ciphertext,
      "base64url",
    );
    if (
      salt.length !== 16
      || iv.length !== 12
      || authTag.length !== 16
      || ciphertext.length === 0
    ) {
      throw new Error("channel_node_bundle_ciphertext_invalid");
    }
    const key = await scryptKey(token, salt);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        iv,
      );
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const parsed = JSON.parse(
        plaintext.toString("utf8"),
      ) as unknown;
      if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
      ) {
        throw new Error("channel_node_bundle_payload_invalid");
      }
      return parsed as Readonly<Record<string, unknown>>;
    } finally {
      key.fill(0);
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("channel_node_bundle_")
    ) {
      throw error;
    }
    throw new Error("channel_node_bundle_decryption_failed");
  }
}

async function scryptKey(
  token: string,
  salt: Buffer,
): Promise<Buffer> {
  return Buffer.from(
    await scryptAsync(token, salt, 32) as ArrayBuffer,
  );
}

function parsePemCertificates(value: string): string[] {
  return value.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  ) ?? [];
}

function parseTrustAnchor(
  value: string,
  code: string,
): X509Certificate {
  try {
    const certificate = new X509Certificate(value);
    if (
      !certificate.ca
      || !certificate.checkIssued(certificate)
      || !certificate.verify(certificate.publicKey)
    ) {
      throw new Error(code);
    }
    return certificate;
  } catch (error) {
    if (
      error instanceof Error
      && error.message === code
    ) {
      throw error;
    }
    throw new Error(code);
  }
}

async function runOpenSsl(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await execFileAsync(executable, [...args], {
      signal,
      timeout: OPENSSL_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(
      "channel_node_certificate_issue_failed",
      { cause: error },
    );
  }
}
