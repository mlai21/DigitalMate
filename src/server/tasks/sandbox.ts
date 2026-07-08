import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

export type SandboxCommandInput = {
  image: string;
  workdir: string;
  script: string;
  memoryMb: number;
  cpus: number;
  network: boolean;
};

export type SandboxExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxCommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const blockedPatterns = [
  /\brm\s+-rf\s+\//,
  /\bcurl\b.*\|\s*(sh|bash)/,
  /\bwget\b.*\|\s*(sh|bash)/,
  /\bssh\b/,
  /\bscp\b/,
  />\s*\/etc\//,
  /\b(docker|podman|nerdctl)\b.*(--privileged|--pid=host|--network=host|--cap-add(?:=|\s+)|\/var\/run\/docker\.sock)/,
  /\/var\/run\/docker\.sock/,
];

export function isSandboxTaskAllowed(script: string): boolean {
  return !blockedPatterns.some((pattern) => pattern.test(script));
}

export function isSandboxImageAllowed(image: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image);
}

export function isSandboxWorkdirAllowed(workdir: string): boolean {
  if (!workdir.startsWith("/") || workdir.includes("\0")) return false;

  const normalized = normalizeAbsolutePath(workdir);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes(".") || segments.includes("..")) return false;

  const basename = segments.at(-1) ?? "";
  const isDigitalMateTempDir = basename.startsWith("digitalmate-sandbox-") || basename.startsWith("digitalmate-tool-");
  if (!isDigitalMateTempDir) return false;

  const allowedRoots = [os.tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/var/folders"]
    .map(normalizeAbsolutePath)
    .filter(Boolean);

  return allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function buildSandboxCommand(input: SandboxCommandInput): string {
  if (!isSandboxTaskAllowed(input.script)) {
    throw new Error("Sandbox task is not allowed by policy");
  }
  if (!isSandboxImageAllowed(input.image)) {
    throw new Error("Sandbox image is not allowed by policy");
  }
  if (!isSandboxWorkdirAllowed(input.workdir)) {
    throw new Error("Sandbox workdir is not allowed by policy");
  }

  const network = input.network ? "bridge" : "none";
  return [
    "docker run --rm",
    `--memory=${input.memoryMb}m`,
    `--cpus=${input.cpus}`,
    `--network=${network}`,
    `-v ${input.workdir}:/workspace:rw`,
    "-w /workspace",
    input.image,
    "sh",
    "-lc",
    JSON.stringify(input.script),
  ].join(" ");
}

export async function runSandboxTask(
  input: SandboxCommandInput,
  runner: SandboxCommandRunner = defaultCommandRunner,
): Promise<SandboxExecutionResult> {
  if (!isSandboxTaskAllowed(input.script)) {
    throw new Error("Sandbox task is not allowed by policy");
  }
  if (!isSandboxImageAllowed(input.image)) {
    throw new Error("Sandbox image is not allowed by policy");
  }
  if (!isSandboxWorkdirAllowed(input.workdir)) {
    throw new Error("Sandbox workdir is not allowed by policy");
  }

  const { stdout, stderr } = await runner("docker", buildSandboxArgs(input));
  return {
    stdout: String(stdout),
    stderr: String(stderr),
    exitCode: 0,
  };
}

function buildSandboxArgs(input: SandboxCommandInput): string[] {
  const network = input.network ? "bridge" : "none";
  return [
    "run",
    "--rm",
    `--memory=${input.memoryMb}m`,
    `--cpus=${input.cpus}`,
    `--network=${network}`,
    "-v",
    `${input.workdir}:/workspace:rw`,
    "-w",
    "/workspace",
    input.image,
    "sh",
    "-lc",
    input.script,
  ];
}

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(file: string, args: string[]) {
  return execFileAsync(file, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

function normalizeAbsolutePath(input: string): string {
  const normalized = input.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}
