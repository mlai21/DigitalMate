import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as productionAdminGet,
  runtime as adminRuntime,
} from "@/app/admin/[[...path]]/route";
import { createAdminConsoleCutoverHandler } from "@/server/admin/console-cutover";
import { createSessionToken } from "@/server/auth/session";
import { readEnv } from "@/server/config/env";

const secret = "admin-cutover-test-secret";
let fixtureRoot = "";

const routeMocks = vi.hoisted(() => ({
  ensureDefault: vi.fn(async () => ({ id: "user-1" })),
  getGeneration: vi.fn(async () => 1),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    users: { ensureDefault: routeMocks.ensureDefault },
    sessionStates: { getGeneration: routeMocks.getGeneration },
  })),
}));

beforeEach(async () => {
  vi.stubEnv("ADMIN_CONSOLE_ENABLED", "0");
  routeMocks.ensureDefault.mockClear();
  routeMocks.getGeneration.mockClear();
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "digitalmate-console-cutover-"),
  );
  await mkdir(path.join(fixtureRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    "<!doctype html><title>DigitalMate Console</title>",
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function createHandler(
  enabled: boolean,
  loadSessionGeneration = vi.fn(async () => 1),
) {
  return createAdminConsoleCutoverHandler({
    enabled,
    appSecret: secret,
    defaultUserId: "user-1",
    loadSessionGeneration,
    rootDirectory: fixtureRoot,
  });
}

describe("admin Console cutover", () => {
  it("defaults the production entry to the legacy admin until explicitly enabled", () => {
    expect(readEnv({}).adminConsoleEnabled).toBe(false);
    expect(
      readEnv({ ADMIN_CONSOLE_ENABLED: "1" }).adminConsoleEnabled,
    ).toBe(true);
    expect(() => readEnv({ ADMIN_CONSOLE_ENABLED: "true" })).toThrow();
  });

  it("redirects the disabled production entry to legacy with its suffix and query", async () => {
    const loadSessionGeneration = vi.fn(async () => 1);
    const response = await createHandler(
      false,
      loadSessionGeneration,
    )(
      new Request(
        "https://digitalmate.example/admin/channels?tab=enabled&kind=telegram",
      ),
      { params: Promise.resolve({ path: ["channels"] }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/admin-legacy/channels?tab=enabled&kind=telegram",
    );
    expect(loadSessionGeneration).not.toHaveBeenCalled();
  });

  it("keeps the production route on Node.js and skips database access during rollback", async () => {
    expect(adminRuntime).toBe("nodejs");

    const response = await productionAdminGet(
      new Request(
        "https://digitalmate.example/admin/channels?tab=enabled",
      ),
      { params: Promise.resolve({ path: ["channels"] }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/admin-legacy/channels?tab=enabled",
    );
    expect(routeMocks.ensureDefault).not.toHaveBeenCalled();
  });

  it("serves the Console from /admin when enabled", async () => {
    const token = await createSessionToken("user-1", 1, secret);
    const response = await createHandler(true)(
      new Request("https://digitalmate.example/admin/settings/models", {
        headers: { cookie: `dm_session=${token}` },
      }),
      { params: Promise.resolve({ path: ["settings", "models"] }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DigitalMate Console");
  });

  it("preserves the /admin path and query in an enabled unauthenticated login redirect", async () => {
    const response = await createHandler(true)(
      new Request(
        "https://digitalmate.example/admin/settings?tab=models&enabled=1",
      ),
      { params: Promise.resolve({ path: ["settings"] }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/login?redirect=%2Fadmin%2Fsettings%3Ftab%3Dmodels%26enabled%3D1",
    );
  });

  it("keeps every DigitalMate homepage admin entry on /admin", () => {
    for (const file of [
      "src/app/home/page.tsx",
      "src/components/chat/chat-shell.tsx",
      "src/components/chat/chat-sidebar.tsx",
    ]) {
      const contents = readFileSync(
        path.join(process.cwd(), file),
        "utf8",
      );
      expect(contents).toContain('href="/admin"');
      expect(contents).not.toContain('href="/admin-legacy"');
    }
  });
});
