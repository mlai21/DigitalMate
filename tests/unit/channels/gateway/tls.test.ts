import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  authorizeNodeCertificate,
  buildNodeTlsOptions,
} from "@/server/channels/gateway/tls";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const RAW_CERTIFICATE = Buffer.from("der-certificate-fixture");
const FINGERPRINT = createHash("sha256")
  .update(RAW_CERTIFICATE)
  .digest();

describe("channel node TLS authorization", () => {
  it("authorizes a known active certificate by SHA-256 fingerprint", async () => {
    const findByCertificateFingerprint = vi.fn(async () => ({
      id: NODE_ID,
      userId: USER_ID,
      status: "disconnected" as const,
      certificateFingerprint: FINGERPRINT,
    }));

    await expect(
      authorizeNodeCertificate(
        {
          raw: RAW_CERTIFICATE,
          validFrom: "Jul 25 00:00:00 2026 GMT",
          validTo: "Jul 27 00:00:00 2026 GMT",
        },
        { findByCertificateFingerprint },
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ id: NODE_ID, userId: USER_ID });
    expect(findByCertificateFingerprint).toHaveBeenCalledWith(
      FINGERPRINT,
    );
  });

  it("rejects unknown, revoked, expired, and not-yet-valid certificates", async () => {
    const base = {
      raw: RAW_CERTIFICATE,
      validFrom: "Jul 25 00:00:00 2026 GMT",
      validTo: "Jul 27 00:00:00 2026 GMT",
    };

    await expect(
      authorizeNodeCertificate(
        base,
        { findByCertificateFingerprint: async () => null },
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).rejects.toThrow("node_certificate_unknown");
    await expect(
      authorizeNodeCertificate(
        base,
        {
          findByCertificateFingerprint: async () => ({
            id: NODE_ID,
            userId: USER_ID,
            status: "revoked",
            certificateFingerprint: FINGERPRINT,
          }),
        },
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).rejects.toThrow("node_certificate_revoked");
    await expect(
      authorizeNodeCertificate(
        base,
        { findByCertificateFingerprint: async () => null },
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).rejects.toThrow("node_certificate_expired");
    await expect(
      authorizeNodeCertificate(
        base,
        { findByCertificateFingerprint: async () => null },
        new Date("2026-07-24T00:00:00.000Z"),
      ),
    ).rejects.toThrow("node_certificate_not_yet_valid");
  });

  it("builds strict mutual TLS options", () => {
    const options = buildNodeTlsOptions({
      certificate: Buffer.from("server-cert"),
      privateKey: Buffer.from("server-key"),
      certificateAuthority: Buffer.from("node-ca"),
    });

    expect(options).toMatchObject({
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(options.ca).toEqual(Buffer.from("node-ca"));
  });
});
