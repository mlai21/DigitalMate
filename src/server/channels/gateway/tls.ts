import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import type { TlsOptions } from "node:tls";

export type ChannelNodeCertificateRecord = Readonly<{
  id: string;
  userId: string;
  agentId: string;
  status: "connected" | "disconnected" | "revoked";
  certificateFingerprint: Buffer;
  certificateExpiresAt: Date;
}>;

type PeerCertificate = Readonly<{
  raw?: Buffer;
  validFrom?: string;
  validTo?: string;
  valid_from?: string;
  valid_to?: string;
}>;

export async function authorizeNodeCertificate(
  certificate: PeerCertificate,
  repository: Readonly<{
    findByCertificateFingerprint(
      fingerprint: Buffer,
    ): Promise<ChannelNodeCertificateRecord | null>;
    consumeEnrollmentByCertificateFingerprint?(
      fingerprint: Buffer,
      consumedAt?: Date,
    ): Promise<boolean>;
  }>,
  now = new Date(),
): Promise<ChannelNodeCertificateRecord> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("node_certificate_time_invalid");
  }
  if (!certificate.raw || certificate.raw.length === 0) {
    throw new Error("node_certificate_missing");
  }
  const validFrom = parseCertificateTime(
    certificate.validFrom ?? certificate.valid_from,
    "node_certificate_not_yet_valid",
  );
  const validTo = parseCertificateTime(
    certificate.validTo ?? certificate.valid_to,
    "node_certificate_expired",
  );
  if (now < validFrom) {
    throw new Error("node_certificate_not_yet_valid");
  }
  if (now >= validTo) {
    throw new Error("node_certificate_expired");
  }

  const fingerprint = createHash("sha256")
    .update(certificate.raw)
    .digest();
  const node = await repository.findByCertificateFingerprint(
    fingerprint,
  );
  if (!node) {
    throw new Error("node_certificate_unknown");
  }
  if (
    node.certificateFingerprint.length !== fingerprint.length
    || !timingSafeEqual(
      node.certificateFingerprint,
      fingerprint,
    )
  ) {
    throw new Error("node_certificate_unknown");
  }
  if (node.status === "revoked") {
    throw new Error("node_certificate_revoked");
  }
  if (
    !Number.isFinite(node.certificateExpiresAt.getTime())
    || now >= node.certificateExpiresAt
  ) {
    throw new Error("node_certificate_expired");
  }
  await repository.consumeEnrollmentByCertificateFingerprint?.(
    fingerprint,
    now,
  );
  return {
    ...node,
    certificateExpiresAt: new Date(
      Math.min(
        validTo.getTime(),
        node.certificateExpiresAt.getTime(),
      ),
    ),
  };
}

export function buildNodeTlsOptions(input: Readonly<{
  certificate: Buffer;
  privateKey: Buffer;
  certificateAuthority: Buffer;
}>): TlsOptions {
  return {
    cert: input.certificate,
    key: input.privateKey,
    ca: input.certificateAuthority,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };
}

function parseCertificateTime(
  value: string | undefined,
  code: string,
): Date {
  if (!value) throw new Error(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(code);
  }
  return parsed;
}
