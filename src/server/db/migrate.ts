import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { DATABASE_BOOTSTRAP_LOCK_SQL } from "@/server/db/bootstrap-lock";
import { getPool } from "@/server/db/client";

export async function migrateSchema(pool: Pool, schema: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DATABASE_BOOTSTRAP_LOCK_SQL);
    await client.query(schema);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the migration error when the connection cannot roll back.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  await migrateSchema(getPool(), schema);
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("Database migration completed.");
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
