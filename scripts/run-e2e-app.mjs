import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const { Pool } = pg;
const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-app-e2e-"));
const appPort = Number(process.env.PLAYWRIGHT_APP_PORT ?? "3100");
const databasePort = await findAvailablePort();
const password = "digitalmate-e2e";
const database = new EmbeddedPostgres({
  databaseDir: path.join(root, "postgres"),
  user: "postgres",
  password,
  port: databasePort,
  persistent: false,
  onLog: () => undefined,
  onError: (message) => process.stderr.write(`[embedded-postgres] ${message}\n`),
});
let pool;
let app;
let llmServer;
let shuttingDown = false;

try {
  await database.initialise();
  await database.start();
  const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${databasePort}/postgres`;
  pool = new Pool({ connectionString: databaseUrl });
  await installSchema(pool);
  await seedApplication(pool);
  const llmPort = await findAvailablePort();
  llmServer = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "附件已收到" } }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  llmServer.listen(llmPort, "127.0.0.1");
  await once(llmServer, "listening");

  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  app = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", String(appPort)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ATTACHMENT_STORAGE_DIR: path.join(root, "attachments"),
      APP_PASSWORD: "",
      KIE_AI_API_KEY: "e2e-local-model",
      KIE_AI_BASE_URL: `http://127.0.0.1:${llmPort}`,
    },
  });

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  app.once("exit", (code, signal) => {
    if (!shuttingDown) void shutdown(undefined, code ?? (signal ? 1 : 0));
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown(undefined, 1);
}

async function installSchema(databasePool) {
  let schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  schema = schema
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m, "");
  await databasePool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
  await databasePool.query(schema);
}

async function seedApplication(databasePool) {
  const userId = "00000000-0000-4000-8000-000000000001";
  const conversationId = "10000000-0000-4000-8000-000000000001";
  await databasePool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Tang')", [userId]);
  await databasePool.query(
    `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence, search)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      { name: "DigitalMate", style: "温暖、克制、自然", emojiHabit: "少量使用" },
      { quietStart: "23:00", quietEnd: "08:00", minIntervalMinutes: 30, maxPerHour: 2, maxPerDay: 3 },
      { main: "gemini-3-5-flash-openai", light: "gemini-3-5-flash-openai" },
      { responseDelayMs: 0, segmentDelayMs: 0, maxSegments: 5 },
      { aggressiveness: "conservative" },
    ],
  );
  await databasePool.query(
    "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, '附件 E2E')",
    [conversationId, userId],
  );
}

async function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill(signal ?? "SIGTERM");
    await Promise.race([
      once(app, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  }
  await pool?.end().catch(() => undefined);
  if (llmServer?.listening) {
    llmServer.close();
    await once(llmServer, "close").catch(() => undefined);
  }
  await database.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  process.exit(exitCode);
}

async function findAvailablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("e2e_database_port_unavailable");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}
