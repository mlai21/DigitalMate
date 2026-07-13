import { Pool } from "pg";
import { readEnv } from "@/server/config/env";

let pool: Pool | null = null;
let turnLockPool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const env = readEnv();
    pool = new Pool({ connectionString: env.databaseUrl });
  }
  return pool;
}

export function getTurnLockPool(): Pool {
  if (!turnLockPool) {
    const env = readEnv();
    turnLockPool = new Pool({ connectionString: env.databaseUrl, max: 2 });
  }
  return turnLockPool;
}

export async function closePool(): Promise<void> {
  const pools = [pool, turnLockPool].filter((candidate): candidate is Pool => candidate !== null);
  pool = null;
  turnLockPool = null;
  await Promise.all(pools.map((candidate) => candidate.end()));
}
