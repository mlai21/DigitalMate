import {
  containsSecretExposure,
  containsSecretFingerprintExposure,
  type SecretExposureFingerprint,
} from "@/server/admin/secret-content";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

export type PersonalDataExportInput = {
  userId: string;
  exportedAt: Date;
  tables: Record<string, unknown[]>;
  credentialValues?: readonly string[];
  credentialFingerprints?: readonly SecretExposureFingerprint[];
  credentialFingerprintKey?: ChannelSecretsKey;
};

const SENSITIVE_EXPORT_KEY_SEGMENTS = new Set([
  "secret",
  "token",
  "nonce",
  "ciphertext",
  "password",
  "credential",
  "credentials",
]);

const SENSITIVE_EXPORT_KEY_CONCEPTS = new Set([
  "authtag",
  "apikey",
  "privatekey",
  "accesskey",
  "keyversion",
  "storagekey",
  "storagepath",
  "extractedtext",
  "replytoken",
  "pollcursor",
  "temporarypath",
  "temporaryurl",
  "rawpayload",
  "providerpayload",
  "webhookpayload",
  "internalpath",
  "runtimenodeid",
]);

export type ChannelShutdownScope = Readonly<{
  userId: string;
}>;

export type ChannelShutdownPort = Readonly<{
  stopAll(scope: ChannelShutdownScope): Promise<void>;
}>;

type ChannelShutdownRepositories = Readonly<{
  personalData: Readonly<{
    hasEnabledChannelConnections(userId: string): Promise<boolean>;
  }>;
}>;

export class PersonalDataExportError extends Error {
  readonly code = "personal_data_export_failed";

  constructor() {
    super("personal_data_export_failed");
    this.name = "PersonalDataExportError";
  }
}

/**
 * Task 8 has no channel runtime manager yet. The safe default therefore
 * succeeds only after proving that every persisted connection is disabled.
 */
export function createDisabledOnlyChannelShutdownPort(
  repositories: ChannelShutdownRepositories,
): ChannelShutdownPort {
  return {
    async stopAll(scope) {
      if (
        await repositories.personalData.hasEnabledChannelConnections(
          scope.userId,
        )
      ) {
        throw new Error("personal_data_channels_enabled");
      }
    },
  };
}

export function buildPersonalDataExport(input: PersonalDataExportInput) {
  const exported = {
    userId: input.userId,
    exportedAt: input.exportedAt.toISOString(),
    tables: sanitizeExportValue(input.tables) as Record<string, unknown[]>,
  };
  if (
    containsSecretExposure(
      exported,
      input.credentialValues ?? [],
    )
    || (
      (input.credentialFingerprints?.length ?? 0) > 0
      && (
        input.credentialFingerprintKey === undefined
        || containsSecretFingerprintExposure(
          exported,
          input.credentialFingerprints ?? [],
          input.credentialFingerprintKey,
        )
      )
    )
  ) {
    throw new PersonalDataExportError();
  }
  return exported;
}

function sanitizeExportValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isInternalExportKey(key))
      .map(([key, nestedValue]) => [
        key,
        sanitizeExportValue(nestedValue),
      ]),
  );
}

function isInternalExportKey(key: string): boolean {
  const segments = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
  const concept = segments.join("");
  return SENSITIVE_EXPORT_KEY_CONCEPTS.has(concept)
    || segments.some((segment) =>
      SENSITIVE_EXPORT_KEY_SEGMENTS.has(segment)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}
