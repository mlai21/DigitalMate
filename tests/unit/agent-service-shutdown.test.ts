import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent service shutdown", () => {
  it("handles SIGTERM, stops cleanup, closes PostgreSQL pools, and exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-agent-shutdown-"));
    temporaryRoots.push(root);
    const databasePort = await findAvailablePort();
    const password = "digitalmate-agent-test";
    const database = new EmbeddedPostgres({
      databaseDir: path.join(root, "postgres"),
      user: "postgres",
      password,
      port: databasePort,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });

    await database.initialise();
    await database.start();
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${databasePort}/postgres`;
    const pool = new Pool({ connectionString: databaseUrl });
    let child: ChildProcess | undefined;
    try {
      await installSchema(pool);
      child = spawn(
        process.execPath,
        [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/agent-service/index.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            ATTACHMENT_STORAGE_DIR: path.join(root, "attachments"),
            APP_PASSWORD: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      await waitForOutput(child, "DigitalMate agent service started.");

      child.kill("SIGTERM");
      const [exitCode, signal] = await Promise.race([
        once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("agent_shutdown_timeout")), 5_000)),
      ]);

      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      await pool.end();
      await database.stop();
    }
  }, 30_000);
});

async function installSchema(pool: Pool) {
  let schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  schema = schema
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m, "");
  await pool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
  await pool.query(schema);
}

async function waitForOutput(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error(`agent_start_timeout:${output}`)), 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(expected)) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`agent_exited_before_start:${code ?? signal ?? "unknown"}:${output}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function findAvailablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("database_port_unavailable");
  server.close();
  await once(server, "close");
  return address.port;
}
