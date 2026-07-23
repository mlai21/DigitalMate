import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { migrateSchema } from "@/server/db/migrate";

function readRequiredEnv(name: "DATABASE_URL" | "DIGITALMATE_TEST_SCHEMA_PATH"): string {
  const value = process.env[name];
  if (!value) throw new Error(`migration_fixture_configuration_missing:${name}`);
  return value;
}

const databaseUrl = readRequiredEnv("DATABASE_URL");
const schemaPath = readRequiredEnv("DIGITALMATE_TEST_SCHEMA_PATH");
const pool = new Pool({ connectionString: databaseUrl });

async function main(): Promise<void> {
  try {
    await migrateSchema(pool, await readFile(schemaPath, "utf8"));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
