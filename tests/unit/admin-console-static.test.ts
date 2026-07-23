import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as productionPreviewGet,
  runtime as previewRuntime,
} from "@/app/admin-preview/[[...path]]/route";
import { createSessionToken } from "@/server/auth/session";
import {
  createAdminConsolePreviewHandler,
  serveAdminConsoleStatic,
} from "@/server/admin/console-static";

const routeMocks = vi.hoisted(() => ({
  ensureDefault: vi.fn(async () => ({ id: "user-1" })),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    users: { ensureDefault: routeMocks.ensureDefault },
  })),
}));

const execFileAsync = promisify(execFile);
const secret = "preview-test-secret";
let fixtureRoot = "";

beforeEach(async () => {
  routeMocks.ensureDefault.mockClear();
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "digitalmate-console-static-"));
  await mkdir(path.join(fixtureRoot, "assets"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "index.html"), "<!doctype html><title>DigitalMate</title>");
  await writeFile(path.join(fixtureRoot, "assets", "app-ABC12345.js"), "console.log('ok')");
  await writeFile(path.join(fixtureRoot, "assets", "plain.js"), "console.log('plain')");
  await writeFile(path.join(fixtureRoot, "digitalmate-logo.svg"), "<svg></svg>");
});

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

function staticRequest(segments: string[] | undefined, rawPathname: string) {
  return serveAdminConsoleStatic({
    rootDirectory: fixtureRoot,
    pathSegments: segments,
    rawPathname,
  });
}

async function authenticatedRequest(
  pathname = "/admin-preview",
  pathSegments?: string[],
  search = "",
) {
  const token = await createSessionToken("user-1", secret);
  const handler = createAdminConsolePreviewHandler({
    appSecret: secret,
    defaultUserId: "user-1",
    rootDirectory: fixtureRoot,
  });
  return handler(
    new Request(`https://digitalmate.example${pathname}${search}`, {
      headers: { cookie: `dm_session=${token}` },
    }),
    { params: Promise.resolve({ path: pathSegments }) },
  );
}

describe("admin Console static reader", () => {
  it("serves the root and valid SPA routes from index.html without caching HTML", async () => {
    for (const [segments, rawPath] of [
      [undefined, "/admin-preview"],
      [[], "/admin-preview/"],
      [["settings", "models"], "/admin-preview/settings/models"],
    ] as const) {
      const response = await staticRequest(segments as string[] | undefined, rawPath);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>DigitalMate</title>");
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("serves real files and never falls back missing resource requests to HTML", async () => {
    const asset = await staticRequest(
      ["assets", "app-ABC12345.js"],
      "/admin-preview/assets/app-ABC12345.js",
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('ok')");

    for (const [segments, rawPath] of [
      [["assets", "missing.js"], "/admin-preview/assets/missing.js"],
      [["missing.css"], "/admin-preview/missing.css"],
      [["favicon"], "/admin-preview/favicon"],
      [["favicon.ico"], "/admin-preview/favicon.ico"],
    ] as const) {
      const response = await staticRequest([...segments], rawPath);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(fixtureRoot);
      expect(body).not.toContain("<!doctype html>");
    }
  });

  it("does not serve directories", async () => {
    const response = await staticRequest(["assets"], "/admin-preview/assets");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(fixtureRoot);
  });

  it.each([
    { name: "page.html", contentType: "text/html; charset=utf-8" },
    { name: "app.js", contentType: "text/javascript; charset=utf-8" },
    { name: "worker.mjs", contentType: "text/javascript; charset=utf-8" },
    { name: "style.css", contentType: "text/css; charset=utf-8" },
    { name: "data.json", contentType: "application/json; charset=utf-8" },
    { name: "icon.svg", contentType: "image/svg+xml; charset=utf-8" },
    { name: "photo.png", contentType: "image/png" },
    { name: "photo.jpg", contentType: "image/jpeg" },
    { name: "photo.jpeg", contentType: "image/jpeg" },
    { name: "photo.webp", contentType: "image/webp" },
    { name: "favicon.ico", contentType: "image/x-icon" },
    { name: "font.woff", contentType: "font/woff" },
    { name: "font.woff2", contentType: "font/woff2" },
    { name: "font.ttf", contentType: "font/ttf" },
    { name: "bundle.map", contentType: "application/json; charset=utf-8" },
    { name: "notice.txt", contentType: "text/plain; charset=utf-8" },
  ])("sets a safe MIME type for $name", async ({ name, contentType }) => {
    await writeFile(path.join(fixtureRoot, name), "fixture");
    const response = await staticRequest([name], `/admin-preview/${name}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("only gives immutable caching to hashed assets", async () => {
    const hashed = await staticRequest(
      ["assets", "app-ABC12345.js"],
      "/admin-preview/assets/app-ABC12345.js",
    );
    const unhashed = await staticRequest(["assets", "plain.js"], "/admin-preview/assets/plain.js");
    const logo = await staticRequest(["digitalmate-logo.svg"], "/admin-preview/digitalmate-logo.svg");

    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(unhashed.headers.get("cache-control")).toBe("no-cache");
    expect(logo.headers.get("cache-control")).toBe("no-cache");
  });

  it.each([
    { segments: ["/etc/passwd"], raw: "/admin-preview/etc/passwd" },
    { segments: [""], raw: "/admin-preview//" },
    { segments: ["."], raw: "/admin-preview/." },
    { segments: ["..", "secret"], raw: "/admin-preview/../secret" },
    { segments: ["C:\\Windows"], raw: "/admin-preview/C:%5CWindows" },
    { segments: ["folder\\secret"], raw: "/admin-preview/folder%5Csecret" },
    { segments: ["nul\u0000byte"], raw: "/admin-preview/nul%00byte" },
    { segments: ["file?download"], raw: "/admin-preview/file%3Fdownload" },
    { segments: ["file#fragment"], raw: "/admin-preview/file%23fragment" },
    { segments: ["..", "secret"], raw: "/admin-preview/%2e%2e/secret" },
    { segments: ["%2e%2e", "secret"], raw: "/admin-preview/%252e%252e/secret" },
    { segments: ["folder/secret"], raw: "/admin-preview/folder%2Fsecret" },
    { segments: ["folder\\secret"], raw: "/admin-preview/folder%5Csecret" },
    { segments: ["%2Fetc"], raw: "/admin-preview/%252Fetc" },
    { segments: ["%5Csecret"], raw: "/admin-preview/%255Csecret" },
    { segments: ["/etc", "passwd"], raw: "/admin-preview/%2Fetc/passwd" },
    { segments: ["%2Fetc", "passwd"], raw: "/admin-preview/%252Fetc/passwd" },
    { segments: ["bad"], raw: "/admin-preview/%E0%A4%A" },
    { segments: ["different"], raw: "/admin-preview/settings" },
  ])("rejects invalid path input: $raw", async ({ segments, raw }) => {
    const response = await staticRequest(segments, raw);

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain(fixtureRoot);
    expect(body).not.toContain(raw);
  });

  it("rejects query or hash characters embedded into framework path segments", async () => {
    for (const segment of ["asset.js?raw=1", "asset.js#source"]) {
      const response = await staticRequest([segment], `/admin-preview/${encodeURIComponent(segment)}`);
      expect(response.status).toBe(400);
    }
  });

  it("rejects symlink files and symlinked intermediate directories", async () => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "digitalmate-console-outside-"));
    try {
      await writeFile(path.join(outsideRoot, "secret.txt"), "do not expose");
      await symlink(path.join(outsideRoot, "secret.txt"), path.join(fixtureRoot, "linked.txt"));
      await symlink(outsideRoot, path.join(fixtureRoot, "linked-directory"));
      await symlink(
        path.join(fixtureRoot, "assets", "plain.js"),
        path.join(fixtureRoot, "internal-link.js"),
      );

      for (const [segments, rawPath] of [
        [["linked.txt"], "/admin-preview/linked.txt"],
        [["linked-directory", "secret.txt"], "/admin-preview/linked-directory/secret.txt"],
        [["internal-link.js"], "/admin-preview/internal-link.js"],
      ] as const) {
        const response = await staticRequest([...segments], rawPath);
        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).not.toContain("do not expose");
        expect(body).not.toContain(outsideRoot);
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects a symlink used as the configured Console root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "digitalmate-console-root-link-"));
    const linkedRoot = path.join(parent, "console");
    try {
      await symlink(fixtureRoot, linkedRoot);
      const response = await serveAdminConsoleStatic({
        rootDirectory: linkedRoot,
        pathSegments: [],
        rawPathname: "/admin-preview",
      });

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(fixtureRoot);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects non-regular filesystem entries", async () => {
    const fifoPath = path.join(fixtureRoot, "events.txt");
    await execFileAsync("mkfifo", [fifoPath]);
    expect((await lstat(fifoPath)).isFIFO()).toBe(true);

    const response = await staticRequest(["events.txt"], "/admin-preview/events.txt");
    expect(response.status).toBe(404);
  });
});

describe("admin Console preview route", () => {
  it("uses the Node.js runtime and keeps the production route authenticated", async () => {
    expect(previewRuntime).toBe("nodejs");

    const response = await productionPreviewGet(
      new Request("https://digitalmate.example/admin-preview"),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(307);
    expect(routeMocks.ensureDefault).toHaveBeenCalledOnce();
  });

  it("redirects unauthenticated requests to the same origin with the original path and query", async () => {
    const handler = createAdminConsolePreviewHandler({
      appSecret: secret,
      defaultUserId: "user-1",
      rootDirectory: fixtureRoot,
    });
    const response = await handler(
      new Request("https://digitalmate.example/admin-preview/settings?tab=models&enabled=1", {
        headers: {
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
      }),
      { params: Promise.resolve({ path: ["settings"] }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://digitalmate.example/login?redirect=%2Fadmin-preview%2Fsettings%3Ftab%3Dmodels%26enabled%3D1",
    );
  });

  it("authenticates before path validation so every unauthenticated request redirects", async () => {
    const handler = createAdminConsolePreviewHandler({
      appSecret: secret,
      defaultUserId: "user-1",
      rootDirectory: fixtureRoot,
    });
    const response = await handler(
      new Request("https://digitalmate.example/admin-preview/%252e%252e/secret"),
      { params: Promise.resolve({ path: ["%2e%2e", "secret"] }) },
    );

    expect(response.status).toBe(307);
  });

  it("rejects a tampered cookie and does not expose the static root", async () => {
    const handler = createAdminConsolePreviewHandler({
      appSecret: secret,
      defaultUserId: "user-1",
      rootDirectory: fixtureRoot,
    });
    const response = await handler(
      new Request("https://digitalmate.example/admin-preview", {
        headers: { cookie: "dm_session=tampered" },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(307);
    expect(await response.text()).not.toContain(fixtureRoot);
  });

  it("rejects a valid signed session belonging to a different user", async () => {
    const token = await createSessionToken("not-the-default-user", secret);
    const handler = createAdminConsolePreviewHandler({
      appSecret: secret,
      defaultUserId: "user-1",
      rootDirectory: fixtureRoot,
    });
    const response = await handler(
      new Request("https://digitalmate.example/admin-preview", {
        headers: { cookie: `dm_session=${token}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(307);
  });

  it("serves authenticated requests and accepts Promise route params", async () => {
    const response = await authenticatedRequest(
      "/admin-preview/assets/app-ABC12345.js",
      ["assets", "app-ABC12345.js"],
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('ok')");
  });

  it("cross-checks framework params against the raw URL path", async () => {
    const mismatch = await authenticatedRequest(
      "/admin-preview/assets/app-ABC12345.js",
      ["settings"],
    );
    const doubleEncodedTraversal = await authenticatedRequest(
      "/admin-preview/%252e%252e/secret",
      ["%2e%2e", "secret"],
    );

    expect(mismatch.status).toBe(400);
    expect(doubleEncodedTraversal.status).toBe(400);
  });

  it("allows a normal URL search while resolving the pathname only", async () => {
    const response = await authenticatedRequest(
      "/admin-preview/assets/plain.js",
      ["assets", "plain.js"],
      "?v=1",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('plain')");
  });
});
