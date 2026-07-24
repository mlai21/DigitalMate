import type { Pool } from "pg";
import { getPool } from "@/server/db/client";
import { defaultSettings } from "@/server/settings/defaults";

export type UserPreferences = Readonly<{
  language: string;
  timezone: string;
  revision: number;
}>;

export type UserPreferencesUpdate = Readonly<{
  language: string;
  timezone: string;
  expectedRevision: number;
}>;

export function createUserPreferencesRepository(providedPool?: Pool) {
  const pool = providedPool ?? getPool();

  async function ensure(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO settings (
         user_id, persona, proactivity, model_routing, cadence, search
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        defaultSettings.persona,
        defaultSettings.proactivity,
        defaultSettings.modelRouting,
        defaultSettings.cadence,
        defaultSettings.search,
      ],
    );
  }

  return {
    async get(userId: string): Promise<UserPreferences> {
      await ensure(userId);
      const result = await pool.query(
        `SELECT language, timezone, revision
         FROM settings
         WHERE user_id = $1`,
        [userId],
      );
      if (!result.rows[0]) {
        throw new Error("user_preferences_not_found");
      }
      return mapUserPreferences(result.rows[0]);
    },

    async update(
      userId: string,
      update: UserPreferencesUpdate,
    ): Promise<UserPreferences> {
      await ensure(userId);
      const result = await pool.query(
        `UPDATE settings
         SET language = $2,
             timezone = $3,
             revision = revision + 1,
             updated_at = now()
         WHERE user_id = $1
           AND revision = $4
         RETURNING language, timezone, revision`,
        [
          userId,
          update.language,
          update.timezone,
          update.expectedRevision,
        ],
      );
      if (!result.rows[0]) {
        throw Object.assign(new Error("revision_conflict"), {
          status: 409,
          code: "revision_conflict",
        });
      }
      return mapUserPreferences(result.rows[0]);
    },
  };
}

function mapUserPreferences(
  row: Record<string, unknown>,
): UserPreferences {
  const revision = Number(row.revision);
  if (
    typeof row.language !== "string" ||
    typeof row.timezone !== "string" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("user_preferences_invalid");
  }
  return {
    language: row.language,
    timezone: row.timezone,
    revision,
  };
}
