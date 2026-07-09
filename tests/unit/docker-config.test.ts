import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("docker deployment config", () => {
  it("installs docker CLI for sandbox task execution", async () => {
    const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile"), "utf8");

    expect(dockerfile).toContain("docker-cli");
  });

  it("mounts the docker socket into services that can run sandbox tools", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("fronts the web app with Caddy on the public HTTP/HTTPS ports", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(compose).toContain('"80:80"');
    expect(compose).toContain('"443:443"');
    expect(compose).toMatch(/expose:\s*\n\s*- "3000"/);
  });

  it("sets the app runtime timezone for local reminder scheduling", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");
    const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile"), "utf8");

    expect(compose.match(/TZ: \$\{TZ:-Asia\/Shanghai\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(dockerfile).toContain("tzdata");
  });

  it("copies tsconfig into the runtime image for tsx path aliases", async () => {
    const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY --from=builder /app/tsconfig.json ./tsconfig.json");
  });

  it("sets restart policies for self-hosted runtime services", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(compose.match(/restart: unless-stopped/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
