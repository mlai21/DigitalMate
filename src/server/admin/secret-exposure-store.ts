import type { PoolClient } from "pg";

import {
  createSecretExposureFingerprint,
  type SecretExposureFingerprint,
} from "@/server/admin/secret-content";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";
import {
  encryptedSecretFromStorage,
} from "@/server/security/encrypted-secret";

type StoredSecretExposureFingerprint = {
  key_version: number;
  digest: Buffer;
  utf8_bytes: number;
  character_length: number;
};

export const MAX_USER_SECRET_EXPOSURE_FINGERPRINTS = 4_096;
const SECRET_EXPOSURE_FINGERPRINT_BATCH_SIZE = 256;

export type UserCredentialExposureState = Readonly<{
  plaintextValues: readonly string[];
  fingerprints: readonly SecretExposureFingerprint[];
}>;

export async function lockUserCredentialExposure(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 0)
     )`,
    [`channel-secret-exposure:${userId}`],
  );
}

export async function rememberSecretExposureFingerprint(
  client: PoolClient,
  userId: string,
  connectionId: string,
  fieldName: string,
  plaintext: string,
  key: ChannelSecretsKey,
): Promise<void> {
  const fingerprint = createSecretExposureFingerprint(key, plaintext);
  await client.query(
    `INSERT INTO channel_secret_exposure_fingerprints (
       user_id, connection_id, field_name, key_version, digest,
       utf8_bytes, character_length
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (
       user_id, key_version, digest
     ) DO NOTHING`,
    [
      userId,
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
  userId: string,
): Promise<SecretExposureFingerprint[]> {
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM channel_secret_exposure_fingerprints
     WHERE user_id = $1`,
    [userId],
  );
  const countText = countResult.rows.length === 1
    ? countResult.rows[0]?.count
    : undefined;
  if (
    countText === undefined
    || !/^\d+$/.test(countText)
  ) {
    throw new Error("channel_secret_exposure_history_invalid");
  }
  const count = Number(countText);
  if (
    !Number.isSafeInteger(count)
    || count > MAX_USER_SECRET_EXPOSURE_FINGERPRINTS
  ) {
    throw new Error("channel_secret_exposure_limit_exceeded");
  }
  const fingerprints: SecretExposureFingerprint[] = [];
  while (fingerprints.length < count) {
    const result = await client.query<StoredSecretExposureFingerprint>(
      `SELECT key_version, digest, utf8_bytes, character_length
       FROM channel_secret_exposure_fingerprints
       WHERE user_id = $1
       ORDER BY key_version ASC, digest ASC
       LIMIT ${SECRET_EXPOSURE_FINGERPRINT_BATCH_SIZE}
       OFFSET ${fingerprints.length}`,
      [userId],
    );
    const remaining = count - fingerprints.length;
    if (
      result.rows.length === 0
      || result.rows.length >
        Math.min(SECRET_EXPOSURE_FINGERPRINT_BATCH_SIZE, remaining)
    ) {
      throw new Error("channel_secret_exposure_history_invalid");
    }
    fingerprints.push(...result.rows.map((row) => ({
      keyVersion: row.key_version,
      digest: row.digest,
      utf8Bytes: row.utf8_bytes,
      characterLength: row.character_length,
    })));
  }
  return fingerprints;
}

export async function readUserCredentialExposureState(
  client: PoolClient,
  userId: string,
  key: ChannelSecretsKey,
): Promise<UserCredentialExposureState> {
  const current = await client.query<{
    connection_id: string;
    agent_id: string;
    field_name: string;
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }>(
    `SELECT secret.connection_id,
            connection.agent_id,
            secret.field_name,
            secret.ciphertext,
            secret.nonce,
            secret.auth_tag,
            secret.key_version
     FROM channel_secrets AS secret
     JOIN channel_connections AS connection
       ON connection.id = secret.connection_id
     WHERE connection.user_id = $1
     ORDER BY secret.connection_id ASC, secret.field_name ASC`,
    [userId],
  );
  const plaintextValues: string[] = [];
  for (const row of current.rows) {
    const plaintext = key.decrypt(
      encryptedSecretFromStorage({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      }),
      {
        userId,
        agentId: row.agent_id,
        connectionId: row.connection_id,
        fieldName: row.field_name,
      },
    );
    plaintextValues.push(plaintext);
    await rememberSecretExposureFingerprint(
      client,
      userId,
      row.connection_id,
      row.field_name,
      plaintext,
      key,
    );
  }
  return {
    plaintextValues,
    fingerprints: await readSecretExposureFingerprints(
      client,
      userId,
    ),
  };
}
