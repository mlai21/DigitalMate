import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertIndependentChannelNodeCertificateAuthorities,
  createOpenSslChannelNodeCertificateIssuer,
  decryptChannelNodeBundle,
  encryptChannelNodeBundle,
} from "@/server/admin/channel-node-certificates";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("channel-node certificate enrollment", () => {
  it("requires independent self-signed roots with different public keys", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-ca-boundary-"),
    );
    directories.push(directory);
    const enrollmentCertificate = path.join(
      directory,
      "enrollment-ca.crt",
    );
    const enrollmentKey = path.join(
      directory,
      "enrollment-ca.key",
    );
    const serverCertificate = path.join(
      directory,
      "server-ca.crt",
    );
    const serverKey = path.join(directory, "server-ca.key");
    await Promise.all([
      createRootCertificate(
        enrollmentCertificate,
        enrollmentKey,
        "DigitalMate Enrollment Root",
      ),
      createRootCertificate(
        serverCertificate,
        serverKey,
        "DigitalMate Server Root",
      ),
    ]);
    const [
      enrollmentPem,
      serverPem,
      enrollmentKeyPem,
      serverKeyPem,
    ] = await Promise.all([
      readFile(enrollmentCertificate, "utf8"),
      readFile(serverCertificate, "utf8"),
      readFile(enrollmentKey, "utf8"),
      readFile(serverKey, "utf8"),
    ]);

    expect(() =>
      assertIndependentChannelNodeCertificateAuthorities(
        serverPem,
        enrollmentPem,
        enrollmentKeyPem,
      )
    ).not.toThrow();
    expect(() =>
      assertIndependentChannelNodeCertificateAuthorities(
        serverPem,
        enrollmentPem,
        serverKeyPem,
      )
    ).toThrow("channel_node_enrollment_ca_key_mismatch");

    const reusedKeyCertificate = path.join(
      directory,
      "reused-key-server-ca.crt",
    );
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      enrollmentKey,
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=Different Certificate Same Key",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-out",
      reusedKeyCertificate,
    ]);
    const reusedKeyPem = await readFile(
      reusedKeyCertificate,
      "utf8",
    );
    expect(() =>
      assertIndependentChannelNodeCertificateAuthorities(
        reusedKeyPem,
        enrollmentPem,
        enrollmentKeyPem,
      )
    ).toThrow();

    const requestPath = path.join(
      directory,
      "enrollment-intermediate.csr",
    );
    const intermediatePath = path.join(
      directory,
      "enrollment-intermediate.crt",
    );
    const extensionPath = path.join(
      directory,
      "intermediate.ext",
    );
    await writeFile(
      extensionPath,
      [
        "basicConstraints=critical,CA:TRUE",
        "keyUsage=critical,keyCertSign,cRLSign",
        "",
      ].join("\n"),
    );
    await execFileAsync("openssl", [
      "req",
      "-new",
      "-key",
      enrollmentKey,
      "-subj",
      "/CN=Enrollment Intermediate",
      "-out",
      requestPath,
    ]);
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      requestPath,
      "-CA",
      serverCertificate,
      "-CAkey",
      serverKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensionPath,
      "-out",
      intermediatePath,
    ]);
    const intermediatePem = await readFile(
      intermediatePath,
      "utf8",
    );
    expect(() =>
      assertIndependentChannelNodeCertificateAuthorities(
        serverPem,
        intermediatePem,
        enrollmentKeyPem,
      )
    ).toThrow("channel_node_enrollment_ca_invalid");
    expect(() =>
      assertIndependentChannelNodeCertificateAuthorities(
        intermediatePem,
        enrollmentPem,
        enrollmentKeyPem,
      )
    ).toThrow("channel_node_server_ca_invalid");
  });

  it("issues a short-lived client certificate and encrypts the private bundle", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-test-ca-"),
    );
    directories.push(directory);
    const caCertificatePath = path.join(directory, "ca.crt");
    const caKeyPath = path.join(directory, "ca.key");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=DigitalMate Test Client CA",
      "-keyout",
      caKeyPath,
      "-out",
      caCertificatePath,
    ]);
    const issuer =
      createOpenSslChannelNodeCertificateIssuer({
        certificateAuthorityPath: caCertificatePath,
        certificateAuthorityKeyPath: caKeyPath,
      });

    const issued = await issuer({
      nodeId: "20000000-0000-4000-8000-000000000021",
    });
    const certificate = new X509Certificate(
      issued.certificate,
    );
    const ca = new X509Certificate(
      await readFile(caCertificatePath, "utf8"),
    );

    expect(certificate.checkIssued(ca)).toBe(true);
    expect(certificate.verify(ca.publicKey)).toBe(true);
    expect(issued.fingerprint).toHaveLength(32);
    expect(
      issued.expiresAt.getTime() - Date.now(),
    ).toBeGreaterThan(29 * 24 * 60 * 60 * 1_000);

    const token =
      "one-time-test-token-with-at-least-thirty-two-bytes";
    const bundle = await encryptChannelNodeBundle(
      {
        certificate: issued.certificate,
        private_key: issued.privateKey,
      },
      token,
    );
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("BEGIN EC PRIVATE KEY");
    await expect(
      decryptChannelNodeBundle(bundle, token),
    ).resolves.toMatchObject({
      certificate: expect.stringContaining(
        "BEGIN CERTIFICATE",
      ),
      private_key: expect.stringContaining("PRIVATE KEY"),
    });
    await expect(
      decryptChannelNodeBundle(
        bundle,
        "wrong-token-with-at-least-thirty-two-bytes",
      ),
    ).rejects.toThrow(
      "channel_node_bundle_decryption_failed",
    );
  });
});

async function createRootCertificate(
  certificatePath: string,
  keyPath: string,
  commonName: string,
): Promise<void> {
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ]);
}
