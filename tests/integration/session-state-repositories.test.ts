import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifySessionRequest,
} from "@/server/auth/session";
import { createRepositories } from "@/server/db/repositories";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const APP_SECRET = "session-state-integration-secret";

describe("persistent session state on PostgreSQL", () => {
  let embeddedPostgres: EmbeddedPostgres;
  let databaseDirectory: string;
  let primaryPool: Pool;
  let secondaryPool: Pool;
  let databaseLifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    databaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-session-state-"),
    );
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embeddedPostgres.initialise();
    await embeddedPostgres.start();
    const poolOptions = {
      connectionString:
        `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    };
    primaryPool = new Pool(poolOptions);
    secondaryPool = new Pool(poolOptions);
    databaseLifecycle = trackEmbeddedPostgresPool(primaryPool);
    let schema = await readFile(
      path.join(process.cwd(), "src/server/db/schema.sql"),
      "utf8",
    );
    schema = schema
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
      .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
      .replaceAll("vector(1536)", "vector")
      .replace(
        /^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m,
        "",
      );
    await primaryPool.query(`
      CREATE DOMAIN vector AS text;
      CREATE FUNCTION vector_cosine_distance(vector, vector)
        RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
      CREATE OPERATOR <=> (
        LEFTARG = vector,
        RIGHTARG = vector,
        PROCEDURE = vector_cosine_distance
      );
    `);
    await primaryPool.query(schema);
    await primaryPool.query(schema);
    await primaryPool.query(
      "INSERT INTO users (id, display_name) VALUES ($1, 'Tang')",
      [USER_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await secondaryPool?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await databaseLifecycle?.stop(embeddedPostgres);
    if (databaseDirectory) {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("converges concurrent logins across pools and accepts only the latest generation", async () => {
    const firstProcess = createRepositories(primaryPool);
    const secondProcess = createRepositories(secondaryPool);

    expect(
      await firstProcess.sessionStates.getGeneration(USER_ID),
    ).toBeNull();
    const generations = await Promise.all([
      firstProcess.sessionStates.rotate(USER_ID),
      secondProcess.sessionStates.rotate(USER_ID),
    ]);
    expect([...generations].sort((left, right) => left - right)).toEqual([
      1,
      2,
    ]);
    await expect(
      firstProcess.sessionStates.getGeneration(USER_ID),
    ).resolves.toBe(2);
    await expect(
      secondProcess.sessionStates.getGeneration(USER_ID),
    ).resolves.toBe(2);

    const firstToken = await createSessionToken(
      USER_ID,
      generations[0],
      APP_SECRET,
    );
    const secondToken = await createSessionToken(
      USER_ID,
      generations[1],
      APP_SECRET,
    );
    const firstRequest = sessionRequest(firstToken);
    const secondRequest = sessionRequest(secondToken);
    const loadFromSecondPool = (userId: string) =>
      secondProcess.sessionStates.getGeneration(userId);
    const accepted = generations[0] === 2
      ? firstRequest
      : secondRequest;
    const rejected = generations[0] === 2
      ? secondRequest
      : firstRequest;

    await expect(
      verifySessionRequest(
        accepted,
        USER_ID,
        APP_SECRET,
        loadFromSecondPool,
      ),
    ).resolves.toBe(USER_ID);
    await expect(
      verifySessionRequest(
        rejected,
        USER_ID,
        APP_SECRET,
        loadFromSecondPool,
      ),
    ).resolves.toBeNull();
  });

  it("revokes the previously valid cookie across processes after logout rotation", async () => {
    const firstProcess = createRepositories(primaryPool);
    const secondProcess = createRepositories(secondaryPool);
    const beforeLogout =
      await firstProcess.sessionStates.getGeneration(USER_ID);
    expect(beforeLogout).not.toBeNull();
    const oldToken = await createSessionToken(
      USER_ID,
      beforeLogout!,
      APP_SECRET,
    );

    await secondProcess.sessionStates.rotate(USER_ID);

    await expect(
      verifySessionRequest(
        sessionRequest(oldToken),
        USER_ID,
        APP_SECRET,
        (userId) => firstProcess.sessionStates.getGeneration(userId),
      ),
    ).resolves.toBeNull();
  });
});

function sessionRequest(token: string): Request {
  return new Request("https://mate.example/admin-preview", {
    headers: { cookie: `dm_session=${token}` },
  });
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed_to_reserve_port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}
