import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  authorizeNodeCertificate,
  buildNodeTlsOptions,
} from "@/server/channels/gateway/tls";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const RAW_CERTIFICATE = Buffer.from("der-certificate-fixture");
const FINGERPRINT = createHash("sha256")
  .update(RAW_CERTIFICATE)
  .digest();
const DATABASE_EXPIRY =
  new Date("2026-07-27T12:00:00.000Z");

function nodeRecord(
  status: "connected" | "disconnected" | "revoked" =
    "disconnected",
) {
  return {
    id: NODE_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    status,
    certificateFingerprint: FINGERPRINT,
    certificateExpiresAt: DATABASE_EXPIRY,
  };
}

describe("channel node TLS authorization", () => {
  it("authorizes a known active certificate by SHA-256 fingerprint", async () => {
    const findByCertificateFingerprint =
      vi.fn(async () => nodeRecord());
    const consumeEnrollmentByCertificateFingerprint =
      vi.fn(async () => true);
    const authorizedAt =
      new Date("2026-07-26T00:00:00.000Z");

    await expect(
      authorizeNodeCertificate(
        {
          raw: RAW_CERTIFICATE,
          validFrom: "Jul 25 00:00:00 2026 GMT",
          validTo: "Jul 27 00:00:00 2026 GMT",
        },
        {
          findByCertificateFingerprint,
          consumeEnrollmentByCertificateFingerprint,
        },
        authorizedAt,
      ),
    ).resolves.toMatchObject({ id: NODE_ID, userId: USER_ID });
    expect(findByCertificateFingerprint).toHaveBeenCalledWith(
      FINGERPRINT,
    );
    expect(
      consumeEnrollmentByCertificateFingerprint,
    ).toHaveBeenCalledWith(FINGERPRINT, authorizedAt);
  });

  it("rejects a certificate whose one-time enrollment expired before first mTLS", async () => {
    await expect(
      authorizeNodeCertificate(
        {
          raw: RAW_CERTIFICATE,
          validFrom: "Jul 25 00:00:00 2026 GMT",
          validTo: "Aug 27 00:00:00 2026 GMT",
        },
        {
          findByCertificateFingerprint:
            async () => nodeRecord(),
          consumeEnrollmentByCertificateFingerprint:
            async () => {
              throw new Error("node_enrollment_expired");
            },
        },
        new Date("2026-07-27T00:11:00.000Z"),
      ),
    ).rejects.toThrow("node_enrollment_expired");
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
          findByCertificateFingerprint:
            async () => nodeRecord("revoked"),
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

  it("rejects a certificate expired by the database deadline", async () => {
    await expect(
      authorizeNodeCertificate(
        {
          raw: RAW_CERTIFICATE,
          validFrom: "Jul 25 00:00:00 2026 GMT",
          validTo: "Aug 27 00:00:00 2026 GMT",
        },
        {
          findByCertificateFingerprint: async () => ({
            ...nodeRecord(),
            certificateExpiresAt:
              new Date("2026-07-26T00:00:00.000Z"),
          }),
        },
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).rejects.toThrow("node_certificate_expired");
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
