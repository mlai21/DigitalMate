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

  it("explicitly trusts proxy headers only in the Caddy-fronted web service", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(compose.match(/^\s+TRUST_PROXY_HEADERS:/gm)).toHaveLength(1);
    expect(compose).toContain('TRUST_PROXY_HEADERS: "true"');
    expect(compose).not.toContain("${TRUST_PROXY_HEADERS");
  });

  it("caps attachment upload request bodies before proxying to the web service", async () => {
    const caddyfile = await readFile(path.join(process.cwd(), "Caddyfile"), "utf8");

    expect(caddyfile).toMatch(/@attachmentUpload[\s\S]*path \/api\/chat\/attachments/);
    expect(caddyfile).toMatch(/request_body @attachmentUpload[\s\S]*max_size 11MB/);
  });

  it("routes only the channel gateway prefix to the agent service", async () => {
    const [compose, caddyfile] = await Promise.all([
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
      readFile(path.join(process.cwd(), "Caddyfile"), "utf8"),
    ]);

    expect(caddyfile).toMatch(
      /@channelGateway path \/channel-gateway\/\*/,
    );
    expect(caddyfile).toMatch(
      /reverse_proxy @channelGateway agent:3101/,
    );
    expect(compose).toMatch(/CHANNEL_GATEWAY_PORT: 3101/);
    expect(compose).toMatch(/CHANNEL_NODE_PORT: 9443/);
    expect(compose).toContain(
      'PUBLIC_BASE_URL: "${PUBLIC_BASE_URL:?请设置对应 DOMAIN 的 HTTPS 根地址}"',
    );
    expect(
      compose.match(/^\s+PUBLIC_BASE_URL:/gm),
    ).toHaveLength(2);
    expect(compose).toContain(
      'DOMAIN: "${DOMAIN:?请设置解析到本服务器的 HTTPS 域名}"',
    );
    expect(compose).toContain('"${CHANNEL_NODE_PORT:-9443}:9443"');
    expect(compose).toContain(
      "${CHANNEL_NODE_TLS_DIR:-./data/channel-node-tls}:/run/digitalmate/channel-node-tls:ro",
    );
  });

  it("replaces any client original-URI header with Caddy's raw request URI", async () => {
    const caddyfile = await readFile(
      path.join(process.cwd(), "Caddyfile"),
      "utf8",
    );
    const proxyStart = caddyfile.indexOf("reverse_proxy web:3000 {");
    const removeHeader = caddyfile.indexOf(
      "header_up -X-DigitalMate-Original-URI",
      proxyStart,
    );
    const setHeader = caddyfile.indexOf(
      "header_up X-DigitalMate-Original-URI {http.request.orig_uri}",
      removeHeader,
    );
    const proxyEnd = caddyfile.indexOf("\n\t}", setHeader);
    expect(proxyStart).toBeGreaterThanOrEqual(0);
    expect(removeHeader).toBeGreaterThan(proxyStart);
    expect(setHeader).toBeGreaterThan(removeHeader);
    expect(proxyEnd).toBeGreaterThan(setHeader);
    expect(caddyfile.match(/X-DigitalMate-Original-URI/g)).toHaveLength(3);
    const gatewayProxy = caddyfile.match(
      /reverse_proxy @channelGateway agent:3101 \{[\s\S]*?\n\t\}/,
    )?.[0];
    expect(gatewayProxy).toContain(
      "header_up -X-DigitalMate-Original-URI",
    );
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

  it("shares the private attachment volume between web and agent services", async () => {
    const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(
      compose.match(/ATTACHMENT_STORAGE_DIR: \/app\/data\/attachments/g)?.length ?? 0,
    ).toBe(2);
    expect(
      compose.match(/digitalmate-attachments:\/app\/data\/attachments/g)?.length ?? 0,
    ).toBe(2);
    expect(compose).toMatch(/volumes:[\s\S]+digitalmate-attachments:\s*$/m);
  });
});
