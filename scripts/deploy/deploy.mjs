#!/usr/bin/env node
// Ships the working tree to the production VPS and rebuilds it.
//
// The manual version of this kept failing for reasons that had nothing to do
// with the code being deployed, so every one of those traps is handled here:
// the local proxy hijacking port 22, the server having neither git nor rsync,
// macOS tar smuggling AppleDouble files, and a build heap ceiling larger than
// the server's RAM taking the whole box down.
//
// Usage:
//   node scripts/deploy/deploy.mjs            # sync changed files, build, switch
//   node scripts/deploy/deploy.mjs --all      # ignore the marker, sync everything
//   node scripts/deploy/deploy.mjs --no-build # sync only, keep current images
//   node scripts/deploy/deploy.mjs --check    # preflight + status, change nothing

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const config = {
  host: process.env.DEPLOY_HOST ?? "47.88.93.94",
  user: process.env.DEPLOY_USER ?? "ecs-user",
  key: process.env.DEPLOY_SSH_KEY ?? "api-key-platform-demo.pem",
  remoteDir: process.env.DEPLOY_REMOTE_DIR ?? "/home/ecs-user/digitalmate",
  publicUrl: process.env.DEPLOY_PUBLIC_URL ?? "https://ginkgo.xin/",
  // Must stay below the server's physical RAM or the build thrashes the host.
  nodeHeapMb: process.env.NODE_HEAP_MB ?? "2048",
  mihomoSocket: process.env.MIHOMO_SOCKET ?? "/tmp/verge/verge-mihomo.sock",
  vergeDir: process.env.VERGE_CONFIG_DIR
    ?? join(
      process.env.HOME ?? "",
      "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev",
    ),
};

const markerPath = `${config.remoteDir}/.deployed-commit`;
const buildLog = "/home/ecs-user/deploy.log";

// Everything the server needs to build and run. Kept explicit so local-only
// noise (docs, artifacts, coverage, the ssh key) can never reach production.
// `runners` is absent on purpose: .dockerignore keeps it out of the image and
// the channel nodes deploy separately.
const syncRoots = [
  "src",
  "tests",
  "scripts",
  "patches",
  "public",
  "vendor",
  "Dockerfile",
  "docker-compose.yml",
  "Caddyfile",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "vitest.config.ts",
];

const flags = new Set(process.argv.slice(2));
const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

async function main() {
  await ensureProxyBypass();
  await ensureReachable();

  if (flags.has("--check")) {
    await reportStatus();
    return;
  }

  const files = await resolveChangedFiles();
  if (files.length === 0) {
    log("· 没有需要同步的文件");
  } else {
    await syncFiles(files);
  }

  if (!flags.has("--no-build")) {
    await rebuild();
  }
  await reportStatus();
  await recordMarker();
}

/**
 * A TUN-mode proxy swallows the ssh connection and the exit node refuses
 * port 22, which surfaces as an instant "Connection closed". Rule-based
 * bypasses are useless because the app keeps resetting itself to global mode,
 * where rules are ignored. Excluding the address at the TUN layer works in
 * every mode, so make sure that exclusion is live before doing anything else.
 */
async function ensureProxyBypass() {
  if (!existsSync(config.mihomoSocket)) {
    log("· 未检测到本地代理，跳过绕行设置");
    return;
  }
  const live = await mihomo("GET", "/configs");
  const excluded = live?.tun?.["route-exclude-address"] ?? [];
  if (excluded.some((entry) => entry.startsWith(config.host))) {
    log("✓ 代理已在 TUN 层排除服务器 IP");
    return;
  }
  const generated = join(config.vergeDir, "clash-verge.yaml");
  if (!existsSync(generated)) {
    log("! 代理在运行但找不到其配置文件，可能需要手动改为直连");
    return;
  }
  const patched = join(config.vergeDir, "clash-verge-deploy.yaml");
  const text = readFileSync(generated, "utf8");
  const empty = "  route-exclude-address: []\n";
  const filled = `  route-exclude-address:\n  - ${config.host}/32\n`;
  if (!text.includes(empty)) {
    log("! 代理配置里没有可填充的 route-exclude-address，跳过");
    return;
  }
  writeFileSync(patched, text.replace(empty, filled));
  // mihomo only accepts config paths inside its own directory.
  await mihomo("PUT", "/configs", { path: patched });
  log(`✓ 已让代理在 TUN 层排除 ${config.host}`);
}

function mihomo(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        socketPath: config.mihomoSocket,
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`mihomo ${method} ${path} -> ${res.statusCode} ${raw}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureReachable() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await ssh("echo ok");
      log(`✓ ssh 可达 ${config.user}@${config.host}`);
      return;
    } catch (error) {
      const reason = String(error.stderr ?? error.message).trim().split("\n").pop();
      log(`· ssh 第 ${attempt} 次失败：${reason}`);
      if (attempt === 5) {
        fail(
          "ssh 始终不可达。秒断通常是本地代理，banner 超时通常是服务器内存被压住。",
        );
      }
      await sleep(5_000);
    }
  }
}

/**
 * The server has no git, so the deployed revision is tracked by a marker file
 * we write ourselves. Everything that changed since then gets shipped.
 */
async function resolveChangedFiles() {
  if (flags.has("--all")) {
    log("· 按 --all 同步全部部署路径");
    return syncRoots;
  }
  let marker = "";
  try {
    marker = (await ssh(`cat ${markerPath} 2>/dev/null || true`)).trim();
  } catch {
    marker = "";
  }
  if (!marker) {
    log("· 服务器没有部署标记，本次同步全部部署路径");
    return syncRoots;
  }
  try {
    await execFileAsync("git", ["cat-file", "-e", `${marker}^{commit}`]);
  } catch {
    log(`· 标记 ${marker.slice(0, 7)} 在本地不存在，本次同步全部部署路径`);
    return syncRoots;
  }
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    marker,
    "HEAD",
  ]);
  const committed = stdout.split("\n").filter(Boolean);
  const { stdout: dirty } = await execFileAsync("git", [
    "status",
    "--porcelain",
  ]);
  const uncommitted = dirty
    .split("\n")
    .filter((line) => line && !line.startsWith("??"))
    .map((line) => line.slice(3).trim());
  if (uncommitted.length > 0) {
    log(`! 工作区有未提交改动，会一起部署：${uncommitted.join(", ")}`);
  }
  const files = [...new Set([...committed, ...uncommitted])].filter(
    (file) => existsSync(file) && syncRoots.some(
      (root) => file === root || file.startsWith(`${root}/`),
    ),
  );
  log(`· 相对 ${marker.slice(0, 7)} 需要同步 ${files.length} 个文件`);
  return files;
}

/**
 * scp is per-file slow and the server has no rsync, so stream a tar instead.
 * COPYFILE_DISABLE stops macOS tar from adding ._* AppleDouble members, which
 * is where the junk files already sitting on the server came from.
 */
async function syncFiles(files) {
  const listFile = join(tmpdir(), `digitalmate-deploy-${process.pid}.txt`);
  writeFileSync(listFile, `${files.join("\n")}\n`);
  const remote = `tar xzf - -C ${config.remoteDir}`;
  await new Promise((resolve, reject) => {
    const tar = spawn(
      "tar",
      [
        "czf",
        "-",
        "--exclude",
        "node_modules",
        "--exclude",
        ".next",
        "--exclude",
        "coverage",
        "-T",
        listFile,
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["ignore", "pipe", "inherit"] },
    );
    const remoteTar = spawn("ssh", [...sshArgs(), remote], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    tar.stdout.pipe(remoteTar.stdin);
    remoteTar.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`远端 tar 退出码 ${code}`))
    );
    tar.on("error", reject);
    remoteTar.on("error", reject);
  });
  log(`✓ 已同步 ${files.length} 个文件`);
}

async function rebuild() {
  log(`· 开始构建（NODE_HEAP_MB=${config.nodeHeapMb}，只 build 不停容器）`);
  await ssh(
    `cd ${config.remoteDir} && sudo sh -c "NODE_HEAP_MB=${config.nodeHeapMb} nohup nice -n 10 docker compose build > ${buildLog} 2>&1 &"`,
  );
  const deadline = Date.now() + 30 * 60 * 1_000;
  while (Date.now() < deadline) {
    await sleep(20_000);
    const status = await ssh(
      `if pgrep -f "docker compose build" > /dev/null; then echo RUNNING; else echo IDLE; fi; free -m | sed -n 2p; tail -n 2 ${buildLog}`,
    ).catch((error) => `PROBE_FAILED ${error.message}`);
    const mem = status.match(/Mem:\s+\d+\s+(\d+)/);
    log(`  构建中… 已用内存 ${mem ? `${mem[1]} MB` : "未知"}`);
    if (status.includes("IDLE")) break;
  }
  const tail = await ssh(`tail -n 30 ${buildLog}`);
  if (/^ERROR|error:|failed to solve/m.test(tail)) {
    fail(`构建失败，日志尾部：\n${tail}`);
  }
  log("✓ 构建完成，切换容器");
  await ssh(`cd ${config.remoteDir} && sudo docker compose up -d`);
}

async function reportStatus() {
  const status = await ssh(
    [
      "sudo docker ps --format '{{.Names}}\t{{.Status}}'",
      "free -m | sed -n '2p;3p'",
      "df -h / | tail -n 1",
    ].join("; "),
  );
  log(`\n${status.trim()}`);
  const code = await httpStatus(config.publicUrl);
  log(`站点 ${config.publicUrl} -> HTTP ${code}`);
  if (code !== 200) {
    fail("站点没有返回 200，检查 caddy 与 web 容器日志");
  }
}

async function httpStatus(url) {
  try {
    const { stdout } = await execFileAsync("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "20",
      "--resolve",
      `${new URL(url).hostname}:443:${config.host}`,
      url,
    ]);
    return Number(stdout);
  } catch {
    return 0;
  }
}

async function recordMarker() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  const head = stdout.trim();
  await ssh(`printf '%s' '${head}' > ${markerPath}`);
  log(`✓ 已记录部署标记 ${head.slice(0, 7)}`);
}

function sshArgs() {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-i",
    config.key,
    `${config.user}@${config.host}`,
  ];
}

async function ssh(command) {
  const { stdout } = await execFileAsync("ssh", [...sshArgs(), command], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => fail(error.stack ?? String(error)));
