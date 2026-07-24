import type { PoolClient } from "pg";

import {
  createSecretExposureFingerprint,
  type SecretExposureFingerprint,
} from "@/server/admin/secret-content";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

type StoredSecretExposureFingerprint = {
  key_version: number;
  digest: Buffer;
  utf8_bytes: number;
  character_length: number;
};

export async function rememberSecretExposureFingerprint(
  client: PoolClient,
  connectionId: string,
  fieldName: string,
  plaintext: string,
  key: ChannelSecretsKey,
): Promise<void> {
  const fingerprint = createSecretExposureFingerprint(key, plaintext);
  await client.query(
    `INSERT INTO channel_secret_exposure_fingerprints (
       connection_id, field_name, key_version, digest,
       utf8_bytes, character_length
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (
       connection_id, field_name, key_version, digest
     ) DO NOTHING`,
    [
      connectionId,
      fieldName,
      fingerprint.keyVersion,
      fingerprint.digest,
      fingerprint.utf8Bytes,
      fingerprint.characterLength,
    ],
  );
}

export async function readSecretExposureFingerprints(
  client: PoolClient,
  connectionId: string,
  fieldNames: readonly string[],
): Promise<SecretExposureFingerprint[]> {
  if (fieldNames.length === 0) return [];
  const result = await client.query<StoredSecretExposureFingerprint>(
    `SELECT key_version, digest, utf8_bytes, character_length
     FROM channel_secret_exposure_fingerprints
     WHERE connection_id = $1
       AND field_name = ANY($2::text[])
     ORDER BY field_name ASC, key_version ASC, digest ASC`,
    [connectionId, fieldNames],
  );
  return result.rows.map((row) => ({
    keyVersion: row.key_version,
    digest: row.digest,
    utf8Bytes: row.utf8_bytes,
    characterLength: row.character_length,
  }));
}
