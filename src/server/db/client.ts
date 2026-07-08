import { Pool } from "pg";
import { readEnv } from "@/server/config/env";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const env = readEnv();
    pool = new Pool({ connectionString: env.databaseUrl });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
