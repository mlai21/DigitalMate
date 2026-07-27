import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import {
  BUILD_COMMANDS as CONSOLE_BUILD_COMMANDS,
  __testing as buildTesting,
  buildConsole,
} from "../../scripts/qwenpaw-console/build.mjs";
import {
  PATCHES,
  __testing as prepareTesting,
  prepareConsole,
} from "../../scripts/qwenpaw-console/prepare.mjs";
import {
  attachSignalToError,
  createSignalLifecycle as createProcessSignalLifecycle,
  formatSignalLifecycleDiagnostic,
  getWindowsTreeKillCommand,
  runManagedExecFile,
  runManagedSpawn,
} from "../../scripts/qwenpaw-console/process-lifecycle.mjs";
import * as qwenpawSync from "../../scripts/qwenpaw-console/sync.mjs";
import {
  COMMANDS as CONSOLE_TEST_COMMANDS,
  runPreparedConsoleTests,
} from "../../scripts/qwenpaw-console/test.mjs";
import * as consoleTestScript from "../../scripts/qwenpaw-console/test.mjs";
import {
  __testing as channelParityTesting,
  auditChannelParity,
} from "../../scripts/qwenpaw-console/audit-channel-parity.mjs";
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";
import {
  CHANNEL_TYPES,
  getChannelManifest,
  isChannelType,
} from "../../src/server/channels/manifests/catalog";

const { UPSTREAM } = qwenpawSync;
const execFileAsync = promisify(execFile);
const SNAPSHOT_ROOT = path.resolve("vendor/qwenpaw-console");
const SOURCE_MAPPING_CASES = [
  {
    source: "console",
    destination: "console",
    kind: "directory",
  },
  {
    source: "LICENSE",
    destination: "LICENSE",
    kind: "file",
  },
  {
    source: "src/qwenpaw/app/channels",
    destination: "reference/src/qwenpaw/app/channels",
    kind: "directory",
  },
  {
    source: "src/qwenpaw/config/config.py",
    destination: "reference/src/qwenpaw/config/config.py",
    kind: "file",
  },
  {
    source: "src/qwenpaw/app/routers/config.py",
    destination: "reference/src/qwenpaw/app/routers/config.py",
    kind: "file",
  },
  {
    source: "tests/unit/channels",
    destination: "reference/tests/unit/channels",
    kind: "directory",
  },
  {
    source: "tests/contract/channels",
    destination: "reference/tests/contract/channels",
    kind: "directory",
  },
  {
    source: "tests/fixtures/channels",
    destination: "reference/tests/fixtures/channels",
    kind: "directory",
  },
] as const;
const IDENTITY_FIELDS = [
  {
    field: "Repository",
    expected: UPSTREAM.repository,
    invalid: "https://example.invalid/QwenPaw.git",
  },
  {
    field: "Tag",
    expected: UPSTREAM.tag,
    invalid: "v0.0.0.invalid",
  },
  {
    field: "Commit",
    expected: UPSTREAM.commit,
    invalid: "0000000000000000000000000000000000000000",
  },
] as const;

type FileOperationOverrides = {
  lstat?: typeof lstat;
  rename?: typeof rename;
  rm?: typeof rm;
};

type SyncTestingInterface = {
  replaceSnapshotAtomically: (
    stagingRoot: string,
    destinationRoot: string,
    options?: {
      backupRoot?: string;
      fileOperations?: FileOperationOverrides;
    },
  ) => Promise<void>;
};

async function withSnapshotCopy(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "dm-qwenpaw-"));
  const snapshotRoot = path.join(temporaryRoot, "snapshot");

  try {
    await cp(SNAPSHOT_ROOT, snapshotRoot, { recursive: true });
    await run(snapshotRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function updateUpstreamMetadata(
  root: string,
  update: (metadata: string) => string,
): Promise<void> {
  const metadataPath = path.join(root, "UPSTREAM.md");
  const metadata = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, update(metadata), "utf8");
}

function requireMetadataFieldLine(metadata: string, field: string): string {
  const prefix = `- ${field}: `;
  const matchingLines = metadata
    .split("\n")
    .filter((line) => line.startsWith(prefix));
  if (matchingLines.length !== 1) {
    throw new Error(`test fixture field ${field} is not unique`);
  }
  return matchingLines[0];
}

function requireSyncTestingInterface(): SyncTestingInterface {
  const testing = Reflect.get(qwenpawSync, "__testing") as
    SyncTestingInterface | undefined;
  expect(testing).toBeDefined();
  return testing as SyncTestingInterface;
}

async function createFakeUpstream(root: string): Promise<void> {
  for (const [index, mapping] of SOURCE_MAPPING_CASES.entries()) {
    const sourcePath = path.join(root, ...mapping.source.split("/"));
    const content = `mapping-${index}:${mapping.source}\n`;
    if (mapping.kind === "directory") {
      await mkdir(sourcePath, { recursive: true });
      await writeFile(path.join(sourcePath, "mapping.txt"), content, "utf8");
    } else {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, content, "utf8");
    }
  }
}

async function withFakeUpstream(
  run: (context: {
    destinationRoot: string;
    fixtureRoot: string;
    temporaryRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "dm-qwenpaw-sync-"));
  const fixtureRoot = path.join(temporaryRoot, "upstream-fixture");
  const fakeBinRoot = path.join(temporaryRoot, "bin");
  const fakeGitPath = path.join(fakeBinRoot, "git");
  const destinationRoot = path.join(temporaryRoot, "vendor", "qwenpaw-console");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(fakeBinRoot, { recursive: true });
  await createFakeUpstream(fixtureRoot);
  await writeFile(
    fakeGitPath,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("clone")) {
  fs.cpSync(process.env.DM_QWENPAW_FIXTURE, args.at(-1), { recursive: true });
} else if (args.includes("rev-parse")) {
  process.stdout.write("${UPSTREAM.commit}\\n");
} else {
  process.exitCode = 2;
}
`,
    "utf8",
  );
  await chmod(fakeGitPath, 0o755);

  const previousPath = process.env.PATH;
  const previousFixture = process.env.DM_QWENPAW_FIXTURE;
  process.env.PATH = `${fakeBinRoot}${path.delimiter}${previousPath ?? ""}`;
  process.env.DM_QWENPAW_FIXTURE = fixtureRoot;

  try {
    await run({ destinationRoot, fixtureRoot, temporaryRoot });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousFixture === undefined) {
      delete process.env.DM_QWENPAW_FIXTURE;
    } else {
      process.env.DM_QWENPAW_FIXTURE = previousFixture;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function createReplacementFixture(): Promise<{
  backupRoot: string;
  destinationRoot: string;
  stagingRoot: string;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "dm-qwenpaw-replace-"),
  );
  const destinationRoot = path.join(temporaryRoot, "qwenpaw-console");
  const stagingRoot = path.join(temporaryRoot, "staging");
  const backupRoot = path.join(temporaryRoot, "backup");
  await mkdir(destinationRoot);
  await mkdir(stagingRoot);
  await writeFile(path.join(destinationRoot, "old.txt"), "old snapshot\n");
  await writeFile(path.join(stagingRoot, "new.txt"), "new snapshot\n");
  return { backupRoot, destinationRoot, stagingRoot, temporaryRoot };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function runRealSignalLifecycleTest(
  signal: "SIGINT" | "SIGTERM",
  phase: "prepare" | "cleanup",
): Promise<{
  commandLogPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  temporaryRoot: string;
  workdir: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), `dm-qwenpaw-${phase}-signal-`),
  );
  const fixturePath = path.join(temporaryRoot, "signal-fixture.mjs");
  const workdir = path.join(temporaryRoot, "console");
  const commandLogPath = path.join(temporaryRoot, "commands.log");
  const runnerUrl = pathToFileURL(
    path.resolve("scripts/qwenpaw-console/test.mjs"),
  ).href;
  await writeFile(
    fixturePath,
    `
import { appendFile, mkdir, rm } from "node:fs/promises";
import { runPreparedConsoleTests } from ${JSON.stringify(runnerUrl)};

const phase = ${JSON.stringify(phase)};
const workdir = ${JSON.stringify(workdir)};
const commandLogPath = ${JSON.stringify(commandLogPath)};
const waitForSignal = () => new Promise((resolve) => setTimeout(resolve, 500));

const outcome = await runPreparedConsoleTests({
  prepare: async () => {
    await mkdir(workdir, { recursive: true });
    if (phase === "prepare") {
      process.stdout.write("READY:prepare\\n");
      await waitForSignal();
    }
    return { workdir, applied: [] };
  },
  runCommand: async (command) => {
    await appendFile(commandLogPath, \`\${command}\\n\`);
    return { exitCode: 0, signal: null };
  },
  validateBuild: async () => ({
    indexPath: "",
    logoPath: "",
    resourceUrls: [],
  }),
  cleanup: async (target) => {
    if (phase === "cleanup") {
      process.stdout.write("READY:cleanup\\n");
      await waitForSignal();
    }
    await rm(target, { recursive: true, force: true });
  },
});

if (outcome.signal) {
  process.kill(process.pid, outcome.signal);
} else {
  process.exitCode = outcome.exitCode;
}
`,
    "utf8",
  );

  const child = spawn(process.execPath, [fixturePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`signal fixture did not reach ${phase}`)),
      10_000,
    );
    const inspectOutput = () => {
      if (stdout.includes(`READY:${phase}\n`)) {
        clearTimeout(timeout);
        child.stdout.off("data", inspectOutput);
        resolve();
      }
    };
    child.stdout.on("data", inspectOutput);
    child.once("exit", (exitCode, exitSignal) => {
      if (!stdout.includes(`READY:${phase}\n`)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `signal fixture exited before ${phase}: ${exitCode}/${exitSignal}`,
          ),
        );
      }
    });
  });

  try {
    await ready;
    expect(child.kill(signal)).toBe(true);
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ exitCode, signal: exitSignal }),
      );
    });
    return { ...result, commandLogPath, stderr, temporaryRoot, workdir };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function runRealConsoleBuildSignalTest(
  phase: "prepare" | "publish" | "cleanup",
  signal: "SIGINT" | "SIGTERM",
): Promise<{
  exitCode: number | null;
  outcome: {
    commandCount: number;
    error: null | {
      message: string;
      signal: NodeJS.Signals | null;
    };
    listenerCounts: { sigint: number; sigterm: number };
    result: null | {
      publishRoot: string | null;
      signal: NodeJS.Signals | null;
    };
  };
  preparedRoot: string;
  publicRoot: string;
  publishRoot: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), `dm-qwenpaw-build-${phase}-signal-`),
  );
  const fixturePath = path.join(temporaryRoot, "build-signal-fixture.mjs");
  const outcomePath = path.join(temporaryRoot, "outcome.json");
  const preparedRoot = path.join(
    temporaryRoot,
    "digitalmate-qwenpaw-console-fixture",
  );
  const publicRoot = path.join(temporaryRoot, "public");
  const publishRoot = path.join(publicRoot, "_admin-console");
  const buildModuleUrl = pathToFileURL(
    path.resolve("scripts/qwenpaw-console/build.mjs"),
  ).href;
  await mkdir(publishRoot, { recursive: true });
  await writeFile(path.join(publishRoot, "old.txt"), "old console\n", "utf8");
  await writeFile(
    fixturePath,
    `
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildConsole, __testing } from ${JSON.stringify(buildModuleUrl)};

const phase = ${JSON.stringify(phase)};
const signal = ${JSON.stringify(signal)};
const preparedRoot = ${JSON.stringify(preparedRoot)};
const publicRoot = ${JSON.stringify(publicRoot)};
const publishRoot = ${JSON.stringify(publishRoot)};
const outcomePath = ${JSON.stringify(outcomePath)};
const waitForSignal = () => new Promise((resolve) => setTimeout(resolve, 700));
let commandCount = 0;
let result = null;
let caughtError = null;

const prepare = async () => {
  const assetsRoot = path.join(preparedRoot, "dist", "assets");
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(
    path.join(preparedRoot, "dist", "index.html"),
    '<script src="/_admin-console/assets/app-abc12345.js"></script>\\n',
  );
  await writeFile(
    path.join(preparedRoot, "dist", "digitalmate-logo.svg"),
    "<svg></svg>\\n",
  );
  await writeFile(
    path.join(assetsRoot, "app-abc12345.js"),
    'console.log("new console");\\n',
  );
  if (phase === "prepare") {
    process.stdout.write("READY:prepare\\n");
    await waitForSignal();
  }
  return { workdir: preparedRoot, applied: [] };
};

const publishBuild = (distRoot, options) =>
  __testing.publishConsoleBuild(distRoot, {
    ...options,
    fileOperations:
      phase === "publish"
        ? {
            rename: async (source, destination) => {
              await rename(source, destination);
              if (source === publishRoot) {
                process.stdout.write("READY:publish\\n");
                await waitForSignal();
              }
            },
          }
        : undefined,
  });

try {
  result = await buildConsole({
    prepare,
    runCommand: async () => {
      commandCount += 1;
      return { exitCode: 0, signal: null };
    },
    validateBuild: async () => undefined,
    publishBuild,
    cleanupPrepared: async (target) => {
      if (phase === "cleanup") {
        process.stdout.write("READY:cleanup\\n");
        await waitForSignal();
      }
      await rm(target, { recursive: true, force: true });
    },
    publicRoot,
  });
} catch (error) {
  caughtError = error;
}

const recordedSignal =
  result?.signal ??
  (caughtError && typeof caughtError === "object"
    ? Reflect.get(caughtError, "signal")
    : null);
await writeFile(
  outcomePath,
  JSON.stringify({
    commandCount,
    error: caughtError
      ? {
          message:
            caughtError instanceof Error ? caughtError.message : String(caughtError),
          signal: recordedSignal,
        }
      : null,
    listenerCounts: {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    },
    result,
  }),
);
if (recordedSignal) {
  process.kill(process.pid, recordedSignal);
} else if (caughtError) {
  process.exitCode = 1;
}
`,
    "utf8",
  );

  const child = spawn(process.execPath, [fixturePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const marker = `READY:${phase}\n`;
    const timeout = setTimeout(
      () => reject(new Error(`build fixture did not reach ${phase}`)),
      10_000,
    );
    const inspect = () => {
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (exitCode, exitSignal) => {
      if (!stdout.includes(marker)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `build fixture exited before ${phase}: ${exitCode}/${exitSignal}`,
          ),
        );
      }
    });
  });

  try {
    await ready;
    expect(child.kill(signal)).toBe(true);
    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ exitCode, signal: exitSignal }),
      );
    });
    const outcome = JSON.parse(await readFile(outcomePath, "utf8"));
    return {
      ...closed,
      outcome,
      preparedRoot,
      publicRoot,
      publishRoot,
      stderr,
      temporaryRoot,
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function processTargetExists(pid: number, processGroup = false) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(processGroup ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function processPidIsActive(pid: number) {
  if (!processTargetExists(pid)) {
    return false;
  }
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "stat=",
      "-p",
      String(pid),
    ]);
    const state = stdout.trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForProcessTargetsToExit(
  leaderPid: number,
  descendantPids: number[],
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const descendantStates = await Promise.all(
      descendantPids.map((pid) => processPidIsActive(pid)),
    );
    if (
      !processTargetExists(leaderPid, true) &&
      !descendantStates.some(Boolean)
    ) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type ProcessIdentity = {
  pid: number;
  pgid: number;
  command: string;
};

type RecordedProcessTree = {
  identityToken: string;
  leaderPid: number;
  descendantPids: number[];
};

async function readProcessTable(): Promise<ProcessIdentity[]> {
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,pgid=,command=",
  ]);
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        command: match[3],
      };
    })
    .filter((entry): entry is ProcessIdentity => entry !== null);
}

function parseRecordedProcessTree(source: string): RecordedProcessTree | null {
  try {
    const parsed = JSON.parse(source.split("\n", 1)[0]) as Partial<
      RecordedProcessTree
    >;
    const descendantPids = Array.isArray(parsed.descendantPids)
      ? parsed.descendantPids.filter(
          (pid): pid is number => Number.isInteger(pid) && pid > 0,
        )
      : [];
    if (
      typeof parsed.identityToken !== "string" ||
      parsed.identityToken.length < 8 ||
      !Number.isInteger(parsed.leaderPid) ||
      (parsed.leaderPid ?? 0) <= 0
    ) {
      return null;
    }
    return {
      identityToken: parsed.identityToken,
      leaderPid: parsed.leaderPid as number,
      descendantPids,
    };
  } catch {
    return null;
  }
}

function processTreeIdentityMatches(
  record: RecordedProcessTree,
  processTable: ProcessIdentity[],
) {
  const targetPids = new Set([
    record.leaderPid,
    ...record.descendantPids,
  ]);
  const targetRows = processTable.filter((entry) =>
    targetPids.has(entry.pid),
  );
  const groupRows = processTable.filter(
    (entry) => entry.pgid === record.leaderPid,
  );
  const observedRows = new Set([...targetRows, ...groupRows]);

  return [...observedRows].every(
    (entry) =>
      entry.pgid === record.leaderPid &&
      entry.command.includes(record.identityToken),
  );
}

async function forceCleanupRecordedProcessTree(
  pidPath: string,
  {
    killProcess = process.kill.bind(process),
    readProcessTable: inspectProcesses = readProcessTable,
    waitForExit = waitForProcessTargetsToExit,
  }: {
    killProcess?: typeof process.kill;
    readProcessTable?: () => Promise<ProcessIdentity[]>;
    waitForExit?: (
      leaderPid: number,
      descendantPids: number[],
    ) => Promise<boolean>;
  } = {},
) {
  let source: string;
  try {
    source = await readFile(pidPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        descendantPids: [],
        identityMatched: true,
        leaderPid: 0,
      };
    }
    throw error;
  }

  const record = parseRecordedProcessTree(source);
  if (!record) {
    throw new Error(`recorded process tree identity invalid: ${pidPath}`);
  }
  const { descendantPids, identityToken, leaderPid } = record;
  let processTable = await inspectProcesses();
  if (!processTreeIdentityMatches(record, processTable)) {
    throw new Error(
      `recorded process tree identity mismatch: ${leaderPid}`,
    );
  }

  const groupRows = processTable.filter(
    (entry) => entry.pgid === leaderPid,
  );
  if (groupRows.length > 0) {
    try {
      killProcess(-leaderPid, "SIGKILL");
    } catch (groupError) {
      if ((groupError as NodeJS.ErrnoException).code !== "ESRCH") {
        processTable = await inspectProcesses();
        if (!processTreeIdentityMatches(record, processTable)) {
          throw new Error(
            `recorded process tree identity changed: ${leaderPid}`,
          );
        }
        for (const pid of [leaderPid, ...descendantPids]) {
          const identity = processTable.find(
            (entry) => entry.pid === pid,
          );
          if (
            identity &&
            identity.pgid === leaderPid &&
            identity.command.includes(identityToken)
          ) {
            killProcess(pid, "SIGKILL");
          }
        }
      }
    }
  }

  if (!(await waitForExit(leaderPid, descendantPids))) {
    throw new Error(
      `recorded process tree did not exit: ${[
        leaderPid,
        ...descendantPids,
      ].join(", ")}`,
    );
  }
  await rm(pidPath, { force: true });
  return {
    descendantPids,
    identityMatched: true,
    leaderPid,
  };
}

async function forceCloseCliProcess(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runRealConsoleBuildCliSignalTest({
  ignoreFirstSignal = false,
  grandchildIgnoresFirstSignal = ignoreFirstSignal,
  secondSignal = null,
}: {
  grandchildIgnoresFirstSignal?: boolean;
  ignoreFirstSignal?: boolean;
  secondSignal?: "SIGINT" | "SIGTERM" | null;
} = {}): Promise<{
  exitCode: number | null;
  fakeNpmPid: number;
  grandchildLogPath: string;
  grandchildPid: number;
  pidPath: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "dm-qwenpaw-build-cli-signal-"),
  );
  const fakeBinRoot = path.join(temporaryRoot, "bin");
  const fakeNpmPath = path.join(fakeBinRoot, "npm");
  const fakeNpmPidPath = path.join(temporaryRoot, "fake-npm.pid");
  const grandchildLogPath = path.join(temporaryRoot, "grandchild.log");
  const grandchildReadyPath = path.join(temporaryRoot, "grandchild.ready");
  const identityToken = path.basename(temporaryRoot);
  await mkdir(fakeBinRoot);
  await writeFile(
    fakeNpmPath,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const ignoreFirstSignal = ${JSON.stringify(ignoreFirstSignal)};
const grandchild = spawn(
  process.execPath,
  [
    "-e",
    ${JSON.stringify(`
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(grandchildReadyPath)}, "ready");
if (${JSON.stringify(grandchildIgnoresFirstSignal)}) {
  process.on("SIGINT", () =>
    fs.appendFileSync(${JSON.stringify(grandchildLogPath)}, "SIGINT\\n"),
  );
  process.on("SIGTERM", () =>
    fs.appendFileSync(${JSON.stringify(grandchildLogPath)}, "SIGTERM\\n"),
  );
}
setInterval(() => {}, 1000);
`)},
  ],
  { stdio: "ignore" },
);
fs.writeFileSync(
  ${JSON.stringify(fakeNpmPidPath)},
  JSON.stringify({
    identityToken: ${JSON.stringify(identityToken)},
    leaderPid: process.pid,
    descendantPids: [grandchild.pid],
  }),
);
const finish = (signal) => {
  fs.appendFileSync(
    ${JSON.stringify(fakeNpmPidPath)},
    "\\n" + (ignoreFirstSignal ? "IGNORED:" : "") + signal,
  );
  if (!ignoreFirstSignal) {
    process.exit(128);
  }
};
process.on("SIGINT", () => finish("SIGINT"));
process.on("SIGTERM", () => finish("SIGTERM"));
const readyTimer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(grandchildReadyPath)})) {
    clearInterval(readyTimer);
    process.stdout.write("READY:fake-npm\\n");
  }
}, 5);
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  await chmod(fakeNpmPath, 0o755);

  const child = spawn(
    process.execPath,
    [path.resolve("scripts/qwenpaw-console/build.mjs")],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${fakeBinRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Console build CLI did not start fake npm")),
      30_000,
    );
    const inspect = () => {
      if (stdout.includes("READY:fake-npm\n")) {
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (exitCode, exitSignal) => {
      if (!stdout.includes("READY:fake-npm\n")) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Console build CLI exited early: ${exitCode}/${exitSignal}\n${stderr}`,
          ),
        );
      }
    });
  });

  try {
    await ready;
    expect(child.kill("SIGTERM")).toBe(true);
    if (secondSignal) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(child.kill(secondSignal)).toBe(true);
    }
    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Console build CLI did not exit after signal"));
      }, 10_000);
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => {
        clearTimeout(timeout);
        resolve({ exitCode, signal: exitSignal });
      });
    });
    const record = parseRecordedProcessTree(
      await readFile(fakeNpmPidPath, "utf8"),
    );
    if (!record) {
      throw new Error("fake npm did not write a valid identity record");
    }
    return {
      ...closed,
      fakeNpmPid: record.leaderPid,
      grandchildLogPath,
      grandchildPid: record.descendantPids[0],
      pidPath: fakeNpmPidPath,
      stderr,
      temporaryRoot,
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await forceCloseCliProcess(child);
      await forceCleanupRecordedProcessTree(fakeNpmPidPath);
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        "Console build CLI fixture and process-tree cleanup failed",
      );
    }
    throw error;
  }
}

async function runRealConsolePrepareCliForceKillTest(): Promise<{
  exitCode: number | null;
  fakeGitPid: number;
  grandchildPid: number;
  pidPath: string;
  signal: NodeJS.Signals | null;
  signalLogPath: string;
  stderr: string;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "dm-qwenpaw-prepare-cli-signal-"),
  );
  const fakeBinRoot = path.join(temporaryRoot, "bin");
  const fakeGitPath = path.join(fakeBinRoot, "git");
  const pidPath = path.join(temporaryRoot, "fake-git.pid");
  const readyPath = path.join(temporaryRoot, "fake-git.ready");
  const signalLogPath = path.join(temporaryRoot, "fake-git-signals.log");
  const identityToken = path.basename(temporaryRoot);
  await mkdir(fakeBinRoot);
  await writeFile(
    fakeGitPath,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(
  process.execPath,
  [
    "-e",
    ${JSON.stringify(`
const fs = require("node:fs");
const record = (signal) =>
  fs.appendFileSync(${JSON.stringify(signalLogPath)}, "grandchild:" + signal + "\\n");
process.on("SIGINT", () => record("SIGINT"));
process.on("SIGTERM", () => record("SIGTERM"));
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1000);
`)},
  ],
  { stdio: "ignore" },
);
fs.writeFileSync(
  ${JSON.stringify(pidPath)},
  JSON.stringify({
    identityToken: ${JSON.stringify(identityToken)},
    leaderPid: process.pid,
    descendantPids: [grandchild.pid],
  }),
);
const record = (signal) =>
  fs.appendFileSync(
    ${JSON.stringify(signalLogPath)},
    "git:" + signal + "\\n",
  );
process.on("SIGINT", () => record("SIGINT"));
process.on("SIGTERM", () => record("SIGTERM"));
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  await chmod(fakeGitPath, 0o755);

  const child = spawn(
    process.execPath,
    [path.resolve("scripts/qwenpaw-console/prepare.mjs")],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${fakeBinRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await access(readyPath);
        break;
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `Console prepare CLI exited before fake git was ready: ${child.exitCode}/${child.signalCode}\n${stderr}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await access(readyPath);
    expect(child.kill("SIGTERM")).toBe(true);

    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Console prepare CLI did not exit")),
        12_000,
      );
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({ exitCode, signal });
      });
    });
    const record = parseRecordedProcessTree(
      await readFile(pidPath, "utf8"),
    );
    if (!record) {
      throw new Error("fake git did not write a valid identity record");
    }
    return {
      ...closed,
      fakeGitPid: record.leaderPid,
      grandchildPid: record.descendantPids[0],
      pidPath,
      signalLogPath,
      stderr,
      temporaryRoot,
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await forceCloseCliProcess(child);
      await forceCleanupRecordedProcessTree(pidPath);
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        "Console prepare CLI fixture and process-tree cleanup failed",
      );
    }
    throw error;
  }
}

describe("QwenPaw Console sync", () => {
  it("无网络同步 8 个精确来源映射", async () => {
    await withFakeUpstream(async ({ destinationRoot }) => {
      await qwenpawSync.syncSnapshot(destinationRoot);

      for (const [index, mapping] of SOURCE_MAPPING_CASES.entries()) {
        const destinationPath = path.join(
          destinationRoot,
          ...mapping.destination.split("/"),
        );
        const contentPath =
          mapping.kind === "directory"
            ? path.join(destinationPath, "mapping.txt")
            : destinationPath;
        await expect(readFile(contentPath, "utf8")).resolves.toBe(
          `mapping-${index}:${mapping.source}\n`,
        );

        if (mapping.source !== mapping.destination) {
          await expectPathMissing(
            path.join(destinationRoot, ...mapping.source.split("/")),
          );
        }
      }

      const parentEntries = await readdir(path.dirname(destinationRoot));
      expect(parentEntries).toEqual(["qwenpaw-console"]);
    });
  });

  it("拒绝符号链接来源", async () => {
    await withFakeUpstream(async ({ destinationRoot, fixtureRoot }) => {
      const licensePath = path.join(fixtureRoot, "LICENSE");
      const externalLicense = path.join(fixtureRoot, "external-license");
      await rm(licensePath);
      await writeFile(externalLicense, "external\n");
      await symlink("external-license", licensePath);

      await expect(qwenpawSync.syncSnapshot(destinationRoot)).rejects.toThrow(
        "symbolic link not allowed",
      );
      await expectPathMissing(destinationRoot);
    });
  });

  it("复制前拒绝来源类型不符", async () => {
    await withFakeUpstream(async ({ destinationRoot, fixtureRoot }) => {
      const licensePath = path.join(fixtureRoot, "LICENSE");
      await rm(licensePath);
      await mkdir(licensePath);

      await expect(qwenpawSync.syncSnapshot(destinationRoot)).rejects.toThrow(
        "source snapshot path invalid",
      );
      await expectPathMissing(destinationRoot);
    });
  });

  it("替换成功后清理 staging 和 backup", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      await testing.replaceSnapshotAtomically(
        fixture.stagingRoot,
        fixture.destinationRoot,
        { backupRoot: fixture.backupRoot },
      );

      await expect(
        readFile(path.join(fixture.destinationRoot, "new.txt"), "utf8"),
      ).resolves.toBe("new snapshot\n");
      await expectPathMissing(fixture.stagingRoot);
      await expectPathMissing(fixture.backupRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("staging 安装失败后成功回滚且不留临时目录", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      await expect(
        testing.replaceSnapshotAtomically(
          fixture.stagingRoot,
          fixture.destinationRoot,
          {
            backupRoot: fixture.backupRoot,
            fileOperations: {
              rename: async (sourcePath, destinationPath) => {
                if (
                  sourcePath === fixture.stagingRoot &&
                  destinationPath === fixture.destinationRoot
                ) {
                  throw new Error("injected install failure");
                }
                await rename(sourcePath, destinationPath);
              },
            },
          },
        ),
      ).rejects.toThrow("injected install failure");

      await expect(
        readFile(path.join(fixture.destinationRoot, "old.txt"), "utf8"),
      ).resolves.toBe("old snapshot\n");
      await expectPathMissing(fixture.stagingRoot);
      await expectPathMissing(fixture.backupRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("回滚冲突时保留可定位 backup 和旧快照", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      let replacementError: unknown;
      try {
        await testing.replaceSnapshotAtomically(
          fixture.stagingRoot,
          fixture.destinationRoot,
          {
            backupRoot: fixture.backupRoot,
            fileOperations: {
              rename: async (sourcePath, destinationPath) => {
                if (
                  sourcePath === fixture.stagingRoot &&
                  destinationPath === fixture.destinationRoot
                ) {
                  await mkdir(fixture.destinationRoot);
                  await writeFile(
                    path.join(fixture.destinationRoot, "conflict.txt"),
                    "concurrent writer\n",
                  );
                  throw new Error("injected install failure");
                }
                await rename(sourcePath, destinationPath);
              },
            },
          },
        );
      } catch (error) {
        replacementError = error;
      }

      await expect(
        readFile(path.join(fixture.backupRoot, "old.txt"), "utf8"),
      ).resolves.toBe("old snapshot\n");
      await expect(
        readFile(path.join(fixture.destinationRoot, "conflict.txt"), "utf8"),
      ).resolves.toBe("concurrent writer\n");
      await expectPathMissing(fixture.stagingRoot);
      expect(replacementError).toBeInstanceOf(Error);
      expect((replacementError as Error).message).toContain(
        `backup preserved at ${fixture.backupRoot}`,
      );
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("创建 backup 失败时保留旧快照并清理 staging", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      await expect(
        testing.replaceSnapshotAtomically(
          fixture.stagingRoot,
          fixture.destinationRoot,
          {
            backupRoot: fixture.backupRoot,
            fileOperations: {
              rename: async (sourcePath, destinationPath) => {
                if (
                  sourcePath === fixture.destinationRoot &&
                  destinationPath === fixture.backupRoot
                ) {
                  throw new Error("injected backup failure");
                }
                await rename(sourcePath, destinationPath);
              },
            },
          },
        ),
      ).rejects.toThrow("injected backup failure");

      await expect(
        readFile(path.join(fixture.destinationRoot, "old.txt"), "utf8"),
      ).resolves.toBe("old snapshot\n");
      await expectPathMissing(fixture.stagingRoot);
      await expectPathMissing(fixture.backupRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("故障清理失败时保留原始安装错误", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      await expect(
        testing.replaceSnapshotAtomically(
          fixture.stagingRoot,
          fixture.destinationRoot,
          {
            backupRoot: fixture.backupRoot,
            fileOperations: {
              rename: async (sourcePath, destinationPath) => {
                if (
                  sourcePath === fixture.stagingRoot &&
                  destinationPath === fixture.destinationRoot
                ) {
                  throw new Error("injected install failure");
                }
                await rename(sourcePath, destinationPath);
              },
              rm: async (targetPath, options) => {
                if (targetPath === fixture.stagingRoot) {
                  throw new Error("injected cleanup failure");
                }
                await rm(targetPath, options);
              },
            },
          },
        ),
      ).rejects.toThrow(/injected install failure.*injected cleanup failure/);

      await expect(
        readFile(path.join(fixture.destinationRoot, "old.txt"), "utf8"),
      ).resolves.toBe("old snapshot\n");
      await expectPathMissing(fixture.backupRoot);
      await expect(access(fixture.stagingRoot)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("安装后 backup 清理失败时保留 backup 并明确报错", async () => {
    const fixture = await createReplacementFixture();
    try {
      const testing = requireSyncTestingInterface();
      await expect(
        testing.replaceSnapshotAtomically(
          fixture.stagingRoot,
          fixture.destinationRoot,
          {
            backupRoot: fixture.backupRoot,
            fileOperations: {
              rm: async (targetPath, options) => {
                if (targetPath === fixture.backupRoot) {
                  throw new Error("injected cleanup failure");
                }
                await rm(targetPath, options);
              },
            },
          },
        ),
      ).rejects.toThrow(
        `snapshot installed but backup cleanup failed; backup preserved at ${fixture.backupRoot}`,
      );

      await expect(
        readFile(path.join(fixture.destinationRoot, "new.txt"), "utf8"),
      ).resolves.toBe("new snapshot\n");
      await expect(
        readFile(path.join(fixture.backupRoot, "old.txt"), "utf8"),
      ).resolves.toBe("old snapshot\n");
      await expectPathMissing(fixture.stagingRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("QwenPaw Console snapshot", () => {
  it("将 vendor 和生成目录排除在根类型检查之外", async () => {
    const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8")) as {
      exclude?: string[];
    };

    expect(tsconfig.exclude).toEqual([
      "node_modules",
      ".worktrees/**",
      "vendor/**",
      ".generated/**",
      "public/_admin-console/**",
    ]);
  });

  it("固定 tag、commit 并拒绝缺失的来源元数据", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dm-qwenpaw-"));

    try {
      await expect(verifySnapshot(root)).rejects.toThrow("UPSTREAM.md missing");
      const upstream = await readFile(
        path.join(SNAPSHOT_ROOT, "UPSTREAM.md"),
        "utf8",
      );
      expect(upstream).toContain("v2.0.0.post3");
      expect(upstream).toContain("fef7e64d984f4332d0b84a343cd209bd3ea5d316");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(IDENTITY_FIELDS)(
    "拒绝 $field 字段值不符，即使无关备注保留正确值",
    async ({ field, expected, invalid }) => {
      await withSnapshotCopy(async (root) => {
        await updateUpstreamMetadata(root, (metadata) => {
          const fieldLine = requireMetadataFieldLine(metadata, field);
          return `${metadata.replace(fieldLine, `- ${field}: ${invalid}`)}\n无关备注：${expected}\n`;
        });

        await expect(verifySnapshot(root)).rejects.toThrow(
          "upstream identity mismatch",
        );
      });
    },
  );

  it.each(
    IDENTITY_FIELDS.flatMap(({ field, expected }) => [
      {
        field,
        variant: "缺失",
        update: (metadata: string, fieldLine: string) =>
          metadata.replace(`${fieldLine}\n`, ""),
      },
      {
        field,
        variant: "重复",
        update: (metadata: string, fieldLine: string) =>
          metadata.replace(fieldLine, `${fieldLine}\n${fieldLine}`),
      },
      {
        field,
        variant: "格式异常",
        update: (metadata: string, fieldLine: string) =>
          `${metadata.replace(fieldLine, `${field}: ${expected}`)}\n无关备注：${expected}\n`,
      },
    ]),
  )("拒绝 $field 字段$variant", async ({ field, update }) => {
    await withSnapshotCopy(async (root) => {
      await updateUpstreamMetadata(root, (metadata) => {
        const fieldLine = requireMetadataFieldLine(metadata, field);
        return update(metadata, fieldLine);
      });

      await expect(verifySnapshot(root)).rejects.toThrow(
        "invalid upstream metadata",
      );
    });
  });

  it("拒绝载荷 checksum 篡改", async () => {
    await withSnapshotCopy(async (root) => {
      await writeFile(path.join(root, "LICENSE"), "tampered\n", "utf8");

      await expect(verifySnapshot(root)).rejects.toThrow(
        "snapshot checksum mismatch",
      );
    });
  });

  it("拒绝未登记载荷文件", async () => {
    await withSnapshotCopy(async (root) => {
      await writeFile(
        path.join(root, "UNREGISTERED.txt"),
        "unexpected\n",
        "utf8",
      );

      await expect(verifySnapshot(root)).rejects.toThrow(
        "unregistered snapshot file",
      );
    });
  });

  it("拒绝 checksum 中合法格式的 digest 篡改", async () => {
    await withSnapshotCopy(async (root) => {
      const checksumPath = path.join(root, "SHA256SUMS");
      const checksums = await readFile(checksumPath, "utf8");
      const [firstEntry, ...remainingEntries] = checksums.trimEnd().split("\n");
      const replacement = firstEntry[0] === "0" ? "1" : "0";
      const tamperedEntry = `${replacement}${firstEntry.slice(1)}`;
      await writeFile(
        checksumPath,
        [tamperedEntry, ...remainingEntries].join("\n") + "\n",
      );

      await expect(verifySnapshot(root)).rejects.toThrow(
        "snapshot checksum mismatch",
      );
    });
  });

  it("拒绝 checksum 条目顺序错误", async () => {
    await withSnapshotCopy(async (root) => {
      const checksumPath = path.join(root, "SHA256SUMS");
      const entries = (await readFile(checksumPath, "utf8"))
        .trimEnd()
        .split("\n");
      [entries[0], entries[1]] = [entries[1], entries[0]];
      await writeFile(checksumPath, `${entries.join("\n")}\n`);

      await expect(verifySnapshot(root)).rejects.toThrow(
        "invalid checksum order",
      );
    });
  });

  it.each(["node_modules", "dist", ".git"])(
    "拒绝禁用路径段 %s",
    async (forbiddenSegment) => {
      await withSnapshotCopy(async (root) => {
        const forbiddenRoot = path.join(root, "console", forbiddenSegment);
        await mkdir(forbiddenRoot, { recursive: true });
        await writeFile(path.join(forbiddenRoot, "package.js"), "export {};\n");

        await expect(verifySnapshot(root)).rejects.toThrow(
          "forbidden path segment",
        );
      });
    },
  );

  it("拒绝重复和格式错误的 checksum 条目", async () => {
    await withSnapshotCopy(async (root) => {
      const checksumPath = path.join(root, "SHA256SUMS");
      const checksums = await readFile(checksumPath, "utf8");
      const firstEntry = checksums.split("\n")[0];
      await writeFile(checksumPath, `${checksums.trimEnd()}\n${firstEntry}\n`);

      await expect(verifySnapshot(root)).rejects.toThrow(
        "duplicate checksum entry",
      );
    });

    await withSnapshotCopy(async (root) => {
      await writeFile(path.join(root, "SHA256SUMS"), "not-a-checksum\n");

      await expect(verifySnapshot(root)).rejects.toThrow(
        "invalid checksum format",
      );
    });
  });

  it("拒绝 checksum 路径穿越", async () => {
    await withSnapshotCopy(async (root) => {
      const checksumPath = path.join(root, "SHA256SUMS");
      const checksums = await readFile(checksumPath, "utf8");
      const [firstEntry, ...remainingEntries] = checksums.trimEnd().split("\n");
      const digest = firstEntry.slice(0, 64);
      await writeFile(
        checksumPath,
        [`${digest}  ../escape`, ...remainingEntries].join("\n") + "\n",
      );

      await expect(verifySnapshot(root)).rejects.toThrow(
        "invalid checksum path",
      );
    });
  });

  it("拒绝符号链接", async () => {
    await withSnapshotCopy(async (root) => {
      await symlink("LICENSE", path.join(root, "linked-license"));

      await expect(verifySnapshot(root)).rejects.toThrow(
        "symbolic link not allowed",
      );
    });
  });

  it.each(["UPSTREAM.md", "SHA256SUMS"])(
    "读取前拒绝非普通元数据文件 %s",
    async (metadataFile) => {
      await withSnapshotCopy(async (root) => {
        const metadataPath = path.join(root, metadataFile);
        await rm(metadataPath);
        await mkdir(metadataPath);

        await expect(verifySnapshot(root)).rejects.toThrow(
          "non-regular snapshot metadata",
        );
      });
    },
  );

  it("拒绝缺少固定快照路径", async () => {
    await withSnapshotCopy(async (root) => {
      await rm(
        path.join(root, "reference", "src", "qwenpaw", "config", "config.py"),
      );

      await expect(verifySnapshot(root)).rejects.toThrow(
        "required snapshot path missing",
      );
    });
  });

  it("拒绝缺少已登记但非 required 的文件", async () => {
    await withSnapshotCopy(async (root) => {
      await rm(path.join(root, "console", "index.html"));

      await expect(verifySnapshot(root)).rejects.toThrow(
        "registered snapshot file missing",
      );
    });
  });

  it.each([
    {
      variant: "缺失",
      update: (metadata: string, fieldLine: string) =>
        metadata.replace(`${fieldLine}\n`, ""),
    },
    {
      variant: "重复",
      update: (metadata: string, fieldLine: string) =>
        metadata.replace(fieldLine, `${fieldLine}\n${fieldLine}`),
    },
    {
      variant: "格式异常",
      update: (metadata: string, fieldLine: string) =>
        metadata.replace(
          fieldLine,
          fieldLine.replace("Directory SHA-256:", "Directory SHA-256 :"),
        ),
    },
  ])("拒绝 Directory SHA-256 字段$variant", async ({ update }) => {
    await withSnapshotCopy(async (root) => {
      await updateUpstreamMetadata(root, (metadata) => {
        const fieldLine = requireMetadataFieldLine(
          metadata,
          "Directory SHA-256",
        );
        return update(metadata, fieldLine);
      });

      await expect(verifySnapshot(root)).rejects.toThrow(
        "invalid upstream metadata",
      );
    });
  });

  it("拒绝 Directory SHA-256 值不符", async () => {
    await withSnapshotCopy(async (root) => {
      await updateUpstreamMetadata(root, (metadata) => {
        const fieldLine = requireMetadataFieldLine(
          metadata,
          "Directory SHA-256",
        );
        return metadata.replace(
          fieldLine,
          `- Directory SHA-256: ${"0".repeat(64)}`,
        );
      });

      await expect(verifySnapshot(root)).rejects.toThrow(
        "snapshot directory hash mismatch",
      );
    });
  });
});

describe("QwenPaw channel parity audit", () => {
  const ledgerPath = path.resolve(
    "docs/verification/qwenpaw-channel-parity.md",
  );
  const requiredChannels = [...CHANNEL_TYPES];

  type LedgerFixture = {
    channel: string;
    upstream: {
      config_fields: string[];
      source_files: string[];
      source_sha256: string;
    };
    digitalmate: {
      evidence_sha256: string;
      secret_fields?: string[];
    };
    intentional_differences: string[];
    status: string;
  };

  async function withLedgerFixture(
    update: (ledger: LedgerFixture[]) => void,
    run: (fixturePath: string) => Promise<void>,
  ): Promise<void> {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-channel-parity-"),
    );
    try {
      const markdown = await readFile(ledgerPath, "utf8");
      const ledger = structuredClone(
        channelParityTesting.extractLedger(markdown),
      ) as LedgerFixture[];
      update(ledger);
      const fixturePath = path.join(temporaryRoot, "parity.md");
      await writeFile(
        fixturePath,
        [
          "# Fixture",
          "",
          "<!-- qwenpaw-channel-parity-ledger:start -->",
          "```json",
          JSON.stringify(ledger, null, 2),
          "```",
          "<!-- qwenpaw-channel-parity-ledger:end -->",
          "",
        ].join("\n"),
        "utf8",
      );
      await run(fixturePath);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  it("核验固定快照与十七个非空渠道证据", async () => {
    await expect(
      auditChannelParity({ requiredChannels }),
    ).resolves.toMatchObject({
      channels: 17,
      required: 17,
      tag: "v2.0.0.post3",
      commit: "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
    });
  });

  it("支持显式要求全部十七个渠道", () => {
    expect(
      channelParityTesting.parseRequiredChannels([
        "--require-all",
      ]),
    ).toEqual(requiredChannels);
  });

  it("生产 Adapter switch 穷尽覆盖十七个渠道", async () => {
    const source = await readFile(
      "src/server/channels/runtime/start.ts",
      "utf8",
    );

    expect(
      channelParityTesting
        .parseManagedAdapterCases(source)
        .sort(),
    ).toEqual([...CHANNEL_TYPES].sort());
    expect(() =>
      channelParityTesting.parseManagedAdapterCases(
        source.replace(
          "return assertNeverManagedChannel(channelType);",
          "return unavailableAdapter(channelType);",
        ),
      ),
    ).toThrow("production managed adapter switch is not exhaustive");
  });

  it("每个上游配置字段都由本地严格 manifest 接受", async () => {
    const markdown = await readFile(ledgerPath, "utf8");
    const ledger = channelParityTesting.extractLedger(
      markdown,
    ) as LedgerFixture[];

    for (const entry of ledger) {
      expect(isChannelType(entry.channel)).toBe(true);
      if (!isChannelType(entry.channel)) continue;
      const manifest = getChannelManifest(entry.channel);
      const localFields = manifest.fields.map(
        (field) => field.name,
      );
      expect(
        entry.upstream.config_fields.filter(
          (field) => !localFields.includes(field),
        ),
      ).toEqual([]);
      if (entry.digitalmate.secret_fields) {
        expect(manifest.secretFields).toEqual(
          entry.digitalmate.secret_fields,
        );
      }
    }
  });

  it.each([
    {
      variant: "未知渠道",
      expected: "unknown channel ledger entry",
      update: (ledger: LedgerFixture[]) => {
        ledger[0].channel = "unknown";
      },
    },
    {
      variant: "重复渠道",
      expected: "duplicate channel ledger entry",
      update: (ledger: LedgerFixture[]) => {
        ledger[1].channel = ledger[0].channel;
      },
    },
    {
      variant: "空证据",
      expected: "intentional_differences must not be empty",
      update: (ledger: LedgerFixture[]) => {
        ledger[0].intentional_differences = [];
      },
    },
    {
      variant: "错误源集合哈希",
      expected: "source_sha256 mismatch",
      update: (ledger: LedgerFixture[]) => {
        ledger[0].upstream.source_sha256 = "0".repeat(64);
      },
    },
    {
      variant: "错误本地证据哈希",
      expected: "evidence_sha256 mismatch",
      update: (ledger: LedgerFixture[]) => {
        ledger[0].digitalmate.evidence_sha256 =
          "0".repeat(64);
      },
    },
    {
      variant: "无外部证据的 smoke 状态",
      expected: "status must be automated_verified",
      update: (ledger: LedgerFixture[]) => {
        ledger[0].status = "smoke_verified";
      },
    },
    {
      variant: "错误密钥字段集合",
      expected: "digitalmate.secret_fields",
      update: (ledger: LedgerFixture[]) => {
        ledger[7].digitalmate.secret_fields = ["password"];
      },
    },
  ])("拒绝$variant", async ({ expected, update }) => {
    await withLedgerFixture(update, async (fixturePath) => {
      await expect(
        auditChannelParity({
          ledgerPath: fixturePath,
          requiredChannels,
        }),
      ).rejects.toThrow(expected);
    });
  });

  it("拒绝命令行和程序化入口中的未知或重复必需渠道", async () => {
    expect(() =>
      channelParityTesting.parseRequiredChannels([
        "--require",
        "telegram,unknown",
      ]),
    ).toThrow("unknown required channel:unknown");
    expect(() =>
      channelParityTesting.parseRequiredChannels([
        "--require",
        "telegram,telegram",
      ]),
    ).toThrow("duplicate required channel");
    await expect(
      auditChannelParity({
        requiredChannels: ["telegram", "telegram"],
      }),
    ).rejects.toThrow("duplicate required channel");
  });

  it("拒绝通过父目录符号链接读取证据根之外的文件", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-channel-parity-path-"),
    );
    const evidenceRoot = path.join(temporaryRoot, "evidence");
    const externalRoot = path.join(temporaryRoot, "external");
    try {
      await mkdir(evidenceRoot);
      await mkdir(externalRoot);
      await writeFile(
        path.join(externalRoot, "proof.txt"),
        "outside\n",
        "utf8",
      );
      await symlink(
        externalRoot,
        path.join(evidenceRoot, "linked"),
        "dir",
      );

      await expect(
        channelParityTesting.assertRealPathWithin(
          evidenceRoot,
          path.join(evidenceRoot, "linked", "proof.txt"),
          "test evidence",
        ),
      ).rejects.toThrow("test evidence escapes its evidence root");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("QwenPaw Console patch preparation", () => {
  it("固定五个补丁的不可变应用顺序", () => {
    expect(PATCHES).toEqual([
      "0001-brand.patch",
      "0002-theme.patch",
      "0003-route-auth.patch",
      "0004-api-compat.patch",
      "0005-agent-scope.patch",
    ]);
    expect(Object.isFrozen(PATCHES)).toBe(true);
    expect(Reflect.set(PATCHES, 0, "changed.patch")).toBe(false);
    expect(PATCHES[0]).toBe("0001-brand.patch");
  });

  it("五个补丁使用普通 unified diff 上下文且没有行尾空白", async () => {
    for (const patchName of PATCHES) {
      const patchSource = await readFile(
        path.resolve("patches/qwenpaw-console", patchName),
        "utf8",
      );
      expect.soft(patchSource).toMatch(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m);
      const modifiedFileSections = patchSource
        .split(/^diff --git /m)
        .slice(1)
        .filter((section) => !/^(?:new|deleted) file mode /m.test(section));
      expect.soft(modifiedFileSections.length).toBeGreaterThan(0);
      for (const section of modifiedFileSections) {
        const hunks = section.split(/^@@ .*@@.*$/m).slice(1);
        expect.soft(hunks.length).toBeGreaterThan(0);
        for (const hunk of hunks) {
          expect.soft(hunk).toMatch(/^ .*\S.*$/m);
        }
      }
      expect.soft(patchSource).not.toMatch(/[ \t]+$/m);
    }
  });

  it.each([
    "0004-api-compat.patch",
    "0005-agent-scope.patch",
  ])("%s 对每个目标文件只保留一个 canonical diff header", async (patchName) => {
    const patchSource = await readFile(
      path.resolve("patches/qwenpaw-console", patchName),
      "utf8",
    );
    const counts = new Map<string, number>();

    for (const match of patchSource.matchAll(
      /^diff --git a\/(.+) b\/(.+)$/gm,
    )) {
      expect(match[2]).toBe(match[1]);
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }

    expect(counts.size).toBeGreaterThan(0);
    expect(
      [...counts.entries()].filter(([, count]) => count > 1),
    ).toEqual([]);
  });

  it("生产准备路径与全新 vendor 副本均使用普通 git apply", async () => {
    const prepareSource = await readFile(
      path.resolve("scripts/qwenpaw-console/prepare.mjs"),
      "utf8",
    );
    expect(prepareSource).not.toContain("--unidiff-zero");

    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-ordinary-apply-"),
    );
    const workdir = path.join(temporaryRoot, "console");

    try {
      await cp(path.join(SNAPSHOT_ROOT, "console"), workdir, {
        recursive: true,
      });
      for (const patchName of PATCHES) {
        const patchPath = path.resolve(
          "patches/qwenpaw-console",
          patchName,
        );
        await execFileAsync("git", ["apply", "--check", patchPath], {
          cwd: workdir,
        });
        await execFileAsync("git", ["apply", patchPath], { cwd: workdir });
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("keep=false 清理目录后不返回失效路径", async () => {
    const result = await prepareConsole();

    expect(result).toEqual({
      workdir: null,
      applied: [...PATCHES],
    });
  }, 120_000);

  it("真实验证并应用五个补丁，生成 DigitalMate Console 集成树", async () => {
    const result = await prepareConsole({ keep: true });
    if (!result.workdir) {
      throw new Error("keep=true did not preserve the prepared directory");
    }
    const workdir = result.workdir;

    try {
      expect(result.applied).toEqual(PATCHES);
      expect(result.applied).not.toBe(PATCHES);

      const readPrepared = (relativePath: string) =>
        readFile(path.join(workdir, ...relativePath.split("/")), "utf8");
      const readPreparedOptional = (relativePath: string) =>
        readPrepared(relativePath).catch(() => "");
      const [
        appSource,
        indexHtml,
        routesSource,
        homeRedirectSource,
        codingCapabilityRouteSource,
        sidebarSource,
        mainLayoutSource,
        configSource,
        requestSource,
        agentsPageSource,
        agentTableSource,
        agentModalSource,
        profileFormSource,
        agentScopeSource,
        zhLocaleSource,
        i18nSource,
        headerSource,
        updateContentSource,
        layoutStyles,
        globalLayoutStyles,
        chatSource,
        defaultConfigSource,
        codingToggleSource,
        projectSelectSource,
        desktopUpdateSource,
        agentTableTestSource,
        viteConfigSource,
        brandingSource,
        logoSource,
        loginSource,
        backendLoadingSource,
        agentSelectorSource,
        agentSelectorTestSource,
        authHeadersSource,
        authHeadersTestSource,
        requestTestSource,
        skillSource,
        skillTestSource,
        pluginLoaderSource,
        chatApiSource,
      ] = await Promise.all([
        readPrepared("src/App.tsx"),
        readPrepared("index.html"),
        readPrepared("src/layouts/registry/builtinRoutes.tsx"),
        readPrepared(
          "src/layouts/registry/DigitalMateHomeRedirect.tsx",
        ),
        readPrepared(
          "src/layouts/registry/CodingCapabilityRoute.tsx",
        ),
        readPrepared("src/layouts/Sidebar.tsx"),
        readPrepared("src/layouts/MainLayout/index.tsx"),
        readPrepared("src/api/config.ts"),
        readPrepared("src/api/request.ts"),
        readPrepared("src/pages/Settings/Agents/index.tsx"),
        readPrepared("src/pages/Settings/Agents/components/AgentTable.tsx"),
        readPrepared("src/pages/Settings/Agents/components/AgentModal.tsx"),
        readPrepared("src/pages/Settings/Agents/profileForm.ts"),
        readPrepared("src/api/agentScope.ts"),
        readPrepared("src/locales/zh.json"),
        readPrepared("src/i18n.ts"),
        readPrepared("src/layouts/Header.tsx"),
        readPrepared("src/layouts/constants.ts"),
        readPrepared("src/layouts/index.module.less"),
        readPrepared("src/styles/layout.css"),
        readPrepared("src/pages/Chat/index.tsx"),
        readPrepared("src/pages/Chat/OptionsPanel/defaultConfig.ts"),
        readPrepared("src/components/CodingModeToggle/index.tsx"),
        readPrepared("src/components/ProjectSelectModal/index.tsx"),
        readPrepared("src/contexts/DesktopUpdateContext.tsx"),
        readPrepared(
          "src/pages/Settings/Agents/components/AgentTable.test.tsx",
        ),
        readPrepared("vite.config.ts"),
        readPreparedOptional("src/constants/branding.ts"),
        readPreparedOptional("public/digitalmate-logo.svg"),
        readPrepared("src/pages/Login/index.tsx"),
        readPrepared("src/tauri/BackendLoadingPage.tsx"),
        readPrepared("src/components/AgentSelector/index.tsx"),
        readPreparedOptional(
          "src/components/AgentSelector/AgentSelector.test.tsx",
        ),
        readPrepared("src/api/authHeaders.ts"),
        readPreparedOptional("src/api/authHeaders.test.ts"),
        readPreparedOptional("src/api/request.test.ts"),
        readPrepared("src/api/modules/skill.ts"),
        readPreparedOptional("src/api/modules/skill.test.ts"),
        readPrepared("src/plugins/usePluginLoader.ts"),
        readPrepared("src/api/modules/chat.ts"),
      ]);

      expect(indexHtml).toContain("<title>DigitalMate Console</title>");
      expect(indexHtml).not.toContain("<title>QwenPaw Console</title>");
      expect.soft(viteConfigSource).toContain('base: "/_admin-console/"');
      expect.soft(brandingSource).toContain("import.meta.env.BASE_URL");
      expect.soft(brandingSource).toContain("digitalmate-logo.svg");
      expect.soft(logoSource).toMatch(/<svg[\s>]/);
      expect(i18nSource).toContain(
        'return value.replace(/QwenPaw/g, "DigitalMate")',
      );
      expect(headerSource).toContain("DIGITALMATE_LOGO_URL");
      expect(headerSource).toContain('alt="DigitalMate"');
      expect(updateContentSource).toContain("How to update DigitalMate");
      expect(updateContentSource).toContain("DigitalMate如何更新");
      expect(layoutStyles).toContain(
        "linear-gradient(135deg, #faf7f2 0%, #f7ddd6 100%)",
      );
      expect(layoutStyles).not.toContain("qwenpawBack.png");
      expect(layoutStyles).toContain(
        "background: var(--dm-color-bg-layout, #FAF7F2)",
      );
      expect(globalLayoutStyles).toContain(
        "background: var(--dm-color-bg-layout, #FAF7F2)",
      );
      expect(globalLayoutStyles).not.toContain("background: #f9f8f4");
      expect(chatSource).toContain("avatar: extAvatar ?? DIGITALMATE_LOGO_URL");
      expect(chatSource).toContain('nick: extNick ?? "DigitalMate"');
      expect(defaultConfigSource).toContain(
        "`${import.meta.env.BASE_URL}online.svg`",
      );
      expect(defaultConfigSource).not.toContain('avatar: "/online.svg"');
      for (const brandedSource of [
        headerSource,
        chatSource,
        loginSource,
        backendLoadingSource,
      ]) {
        expect.soft(brandedSource).toContain("DIGITALMATE_LOGO_URL");
        expect.soft(brandedSource).not.toContain('"/digitalmate-logo.svg"');
      }
      expect(appSource).toContain('colorPrimary: "#E8684A"');
      expect(appSource).toContain('colorBgLayout: "#FAF7F2"');
      expect(appSource).toContain("--dm-color-primary: #E8684A");
      expect(appSource).toContain("--dm-color-bg-layout: #FAF7F2");
      expect(appSource).toContain('pathname.startsWith("/admin-preview/")');
      expect(appSource).toContain('return "/admin-preview"');
      expect(appSource).toContain('pathname.startsWith("/admin/")');
      expect(appSource).toContain('return "/admin"');
      expect(appSource).toContain('fetch("/api/admin/compat/auth/status"');
      expect(appSource).toContain("function getDigitalMateLoginUrl(");
      expect(appSource).toContain(
        'returnTo.startsWith("/") && !returnTo.startsWith("//")',
      );
      expect(routesSource).toContain(
        'import DigitalMateHomeRedirect from "./DigitalMateHomeRedirect"',
      );
      expect(routesSource).toContain(
        'path: "/chat/*", component: DigitalMateHomeRedirect',
      );
      expect(homeRedirectSource).toContain(
        "export default function DigitalMateHomeRedirect()",
      );
      expect(homeRedirectSource).toContain('window.location.assign("/")');
      expect(homeRedirectSource).toContain("useEffect(() => {");
      expect(sidebarSource).toContain(
        "function getCollapsedNavAriaLabel(item: FlatMenuEntry): string",
      );
      expect(sidebarSource).toContain(
        'typeof item.label === "string" ? item.label : item.key',
      );
      expect(sidebarSource).toContain(
        "aria-label={getCollapsedNavAriaLabel(item)}",
      );
      expect(sidebarSource).not.toContain("String(item.label)");
      expect(mainLayoutSource).toContain(
        'data-console-route={selectedKey}',
      );
      expect(mainLayoutSource).toMatch(
        /caseSensitive=\{\s*r\.id === "core\.acp" \|\|\s*r\.id === "core\.acp-alias"\s*\}/,
      );
      expect(mainLayoutSource).not.toMatch(/<Route\s+caseSensitive\s+key=/);
      expect
        .soft(routesSource)
        .toContain('return <Navigate to="/inbox" replace />');
      expect
        .soft(routesSource)
        .not.toContain('return <Navigate to="/channels" replace />');
      expect
        .soft(routesSource)
        .toContain('path: "/coding/*", component: CodingCapabilityRoute');
      expect(routesSource).toContain(
        'import CodingCapabilityRoute from "./CodingCapabilityRoute"',
      );
      expect(codingCapabilityRouteSource).toContain(
        'const CODING_CAPABILITY = "unsupported" as const',
      );
      expect(codingCapabilityRouteSource).toContain(
        "export default function CodingCapabilityRoute()",
      );
      expect(codingCapabilityRouteSource).toContain(
        't("codingMode.unavailableDigitalMate")',
      );
      expect
        .soft(codingToggleSource)
        .toContain('const CODING_CAPABILITY = "unsupported"');
      expect
        .soft(codingToggleSource)
        .toContain("disabled={codingUnavailable || loading || !initialized}");
      expect
        .soft(codingToggleSource)
        .not.toContain("onClick={() => void toggle()}");
      expect
        .soft(projectSelectSource)
        .toContain("const CODING_PROJECT_MUTATIONS_SUPPORTED = false");
      expect
        .soft(
          projectSelectSource.match(
            /disabled: !CODING_PROJECT_MUTATIONS_SUPPORTED/g,
          ),
        )
        .toHaveLength(3);
      expect
        .soft(projectSelectSource)
        .toContain('t("codingMode.unavailableDigitalMate")');
      expect(configSource).toContain(
        'const API_BASE_URL = "/api/admin/compat"',
      );
      expect(configSource).toContain('let csrfToken = ""');
      expect(configSource).not.toContain("localStorage.setItem");
      expect(configSource).not.toContain("sessionStorage.setItem");
      expect(requestSource).toContain("buildMutationHeaders");
      expect(requestSource).toContain("window.location.assign(");
      expect(requestSource).toContain(
        "`/login?redirect=${encodeURIComponent(safeReturnTo)}`",
      );
      expect(requestSource).not.toContain('window.location.href = "/login"');
      expect.soft(authHeadersSource).toContain("buildMutationHeaders");
      expect.soft(authHeadersSource).toContain("isValidatedAgent");
      expect
        .soft(authHeadersSource)
        .toContain('headers["x-digitalmate-agent-id"] = selectedAgent');
      expect
        .soft(authHeadersSource)
        .toContain('new Set(["POST", "PUT", "PATCH", "DELETE"])');
      expect.soft(authHeadersTestSource).toContain('"GET"');
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect.soft(authHeadersTestSource).toContain(`"${method}"`);
      }
      expect.soft(requestTestSource).toContain("x-csrf-token");
      expect.soft(skillSource).toContain("buildMutationHeaders");
      expect.soft(skillTestSource).toContain("x-csrf-token");
      expect.soft(pluginLoaderSource).not.toContain("Authorization");
      expect.soft(pluginLoaderSource).not.toContain("Bearer");
      expect.soft(pluginLoaderSource).not.toContain("getApiToken");
      expect.soft(chatApiSource).not.toContain("getApiToken");
      expect(agentsPageSource).toContain("disabled={!capabilities.create}");
      expect(agentsPageSource).toContain("if (!capabilities.reorder)");
      expect(agentTableSource).toContain("capabilities: AgentCapabilities");
      expect(agentTableSource).toContain("!capabilities.toggle");
      expect(agentTableSource).toContain("!capabilities.delete");
      expect(agentTableSource).toContain("disabled={deleteDisabled}");
      expect
        .soft(agentTableSource)
        .toContain("isDefaultAgent(record)");
      expect
        .soft(agentTableTestSource)
        .toContain('screen.getByTitle("agent.defaultNotDeletable")');
      expect
        .soft(agentSelectorSource)
        .toContain("agent.is_default === true");
      expect
        .soft(agentSelectorSource)
        .not.toContain('.filter((agent) => agent.id === "default")');
      expect
        .soft(agentSelectorTestSource)
        .toContain("lists a non-default agent and switches scope to it");
      expect
        .soft(agentTableTestSource)
        .toContain("does not invoke secondary agent actions");
      expect
        .soft(agentTableTestSource)
        .toContain("does not reorder secondary agents");
      expect.soft(agentScopeSource).toContain("validatedDefaultAgentId");
      expect.soft(profileFormSource).toContain("buildAgentProfileUpdate");
      expect.soft(profileFormSource).not.toContain("active_model");
      expect.soft(profileFormSource).not.toContain("workspace_dir");
      expect
        .soft(agentModalSource)
        .toContain('t("agent.searchAuthorizationNotice")');
      expect.soft(agentModalSource).not.toContain("providerApi");
      expect.soft(agentModalSource).not.toContain("skillApi");
      expect.soft(zhLocaleSource).toContain("不会开启联网");
      expect.soft(zhLocaleSource).toContain("不代表授予联网权限");
      expect.soft(zhLocaleSource).toContain("普通聊天仍默认不联网");
      expect.soft(headerSource).not.toContain("fetch(PYPI_URL)");
      expect.soft(headerSource).not.toContain("qwenpaw.agentscope.io/docs/faq");
      expect
        .soft(headerSource)
        .toContain("setUpdateMarkdown(UPDATE_MD[lang] ?? UPDATE_MD.en)");
      expect.soft(desktopUpdateSource).not.toContain("checkDesktopUpdate");
      expect.soft(desktopUpdateSource).not.toContain("checkCachedUpdate");
      for (const upstreamCommand of [
        "qwenpaw update",
        "src/qwenpaw/console",
        "agentscope/qwenpaw",
        "qwenpaw app",
      ]) {
        expect.soft(updateContentSource).not.toContain(upstreamCommand);
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }

    await expect(verifySnapshot(SNAPSHOT_ROOT)).resolves.toMatchObject({
      commit: UPSTREAM.commit,
    });
  }, 120_000);

  it("补丁应用失败时删除本次临时目录并保持 vendor 不变", async () => {
    const temporaryParent = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-prepare-test-"),
    );
    const invalidPatch = path.join(temporaryParent, "invalid.patch");
    await writeFile(invalidPatch, "this is not a patch\n", "utf8");

    try {
      await expect(
        prepareTesting.prepareConsoleWithDependencies(
          { keep: true },
          {
            patchPaths: [
              path.resolve("patches/qwenpaw-console/0001-brand.patch"),
              invalidPatch,
            ],
            temporaryParent,
          },
        ),
      ).rejects.toThrow();

      expect(await readdir(temporaryParent)).toEqual(["invalid.patch"]);
      await expect(verifySnapshot(SNAPSHOT_ROOT)).resolves.toMatchObject({
        commit: UPSTREAM.commit,
      });
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("prepare 的冻结主错误、首信号与清理错误共存时包装原错并保留完整诊断", async () => {
    const temporaryParent = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-prepare-frozen-error-"),
    );
    const patchPath = path.resolve(
      "patches/qwenpaw-console/0001-brand.patch",
    );
    const originalError = new Error("frozen git failure");
    Object.defineProperty(originalError, "signal", {
      configurable: false,
      enumerable: true,
      value: "SIGKILL",
    });
    Object.preventExtensions(originalError);
    const cleanupError = new Error("prepared removal failed");
    const lifecycle = createProcessSignalLifecycle();
    let caughtError: unknown;

    lifecycle.install();
    try {
      try {
        await prepareTesting.prepareConsoleWithDependencies(
          { keep: true, signalLifecycle: lifecycle },
          {
            patchPaths: [patchPath],
            remove: async () => {
              throw cleanupError;
            },
            runExecFile: async () => {
              process.emit("SIGTERM", "SIGTERM");
              throw originalError;
            },
            temporaryParent,
            verify: async () => ({
              files: 1,
              commit: UPSTREAM.commit,
            }),
          },
        );
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).not.toBeInstanceOf(TypeError);
      expect(caughtError).not.toBe(originalError);
      expect(Reflect.get(caughtError as object, "cause")).toBe(
        originalError,
      );
      expect(Reflect.get(caughtError as object, "signal")).toBe(
        "SIGTERM",
      );
      expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
        cleanupError,
      );
      expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
        {
          stage: "prepared",
          path: expect.stringContaining(
            "digitalmate-qwenpaw-console-",
          ),
          error: cleanupError,
        },
      ]);
    } finally {
      lifecycle.remove();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("prepare 的纯清理失败包含 prepared 阶段与残留路径且不重复记录", async () => {
    const temporaryParent = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-prepare-cleanup-visible-"),
    );
    const cleanupError = Object.freeze(
      new Error("injected prepared cleanup failure"),
    );
    let caughtError: unknown;

    try {
      try {
        await prepareTesting.prepareConsoleWithDependencies(
          { keep: false },
          {
            patchPaths: [],
            remove: async () => {
              throw cleanupError;
            },
            temporaryParent,
            verify: async () => ({
              files: 1,
              commit: UPSTREAM.commit,
            }),
          },
        );
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).not.toBeInstanceOf(TypeError);
      expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
        cleanupError,
      );
      expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
        {
          stage: "prepared",
          path: expect.stringContaining(
            "digitalmate-qwenpaw-console-",
          ),
          error: cleanupError,
        },
      ]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it.each([
    { signal: "SIGTERM", terminalEvent: "signal:SIGTERM" },
    { signal: null, terminalEvent: "exit:1" },
  ] as const)(
    "prepare CLI 在$terminalEvent前依次输出主错与 cleanup 阶段、路径、message",
    async ({ signal, terminalEvent }) => {
      const cleanupError = new Error("prepared path retained");
      const cliError = Object.assign(new Error("prepare failed"), {
        cleanupError,
        cleanupErrors: [
          {
            stage: "prepared",
            path: "/safe/tmp/digitalmate-qwenpaw-console-residue",
            error: cleanupError,
          },
        ],
        ...(signal ? { signal } : {}),
      });
      const events: string[] = [];
      const runPrepareCli = Reflect.get(
        prepareTesting,
        "runPrepareCli",
      );

      expect(runPrepareCli).toBeTypeOf("function");
      if (typeof runPrepareCli !== "function") {
        return;
      }
      await runPrepareCli({
        prepare: async () => {
          throw cliError;
        },
        resendSignal: (receivedSignal: string) => {
          events.push(`signal:${receivedSignal}`);
        },
        setExitCode: (exitCode: number) => {
          events.push(`exit:${exitCode}`);
        },
        writeStderr: (line: string) => {
          events.push(`stderr:${line}`);
        },
        writeStdout: (line: string) => {
          events.push(`stdout:${line}`);
        },
      });

      expect(events).toEqual([
        "stderr:prepare failed",
        "stderr:Console cleanup failed at prepared (/safe/tmp/digitalmate-qwenpaw-console-residue): prepared path retained",
        terminalEvent,
      ]);
    },
  );

  it("git apply --check 活动进程收到组信号后停止后续 apply 并清理 workdir", async () => {
    const temporaryParent = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-prepare-signal-"),
    );
    const childPidPath = path.join(temporaryParent, "git-child.pid");
    const identityToken = path.basename(temporaryParent);
    const patchPath = path.resolve(
      "patches/qwenpaw-console/0001-brand.patch",
    );
    const calls: string[][] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 1_000,
    });
    let childPid = 0;

    lifecycle.install();
    try {
      await expect(
        prepareTesting.prepareConsoleWithDependencies(
          { keep: true, signalLifecycle: lifecycle },
          {
            patchPaths: [patchPath],
            runExecFile: async (command, args, options) => {
              if (!options?.signalLifecycle) {
                throw new Error("signal lifecycle missing from git command");
              }
              calls.push([command, ...args]);
              const running = runManagedSpawn(
                process.execPath,
                [
                  "-e",
                  `
const identityToken = ${JSON.stringify(identityToken)};
require("node:fs").writeFileSync(
  ${JSON.stringify(childPidPath)},
  JSON.stringify({
    identityToken,
    leaderPid: process.pid,
    descendantPids: [],
  }),
);
setInterval(() => identityToken.length, 1000);
`,
                ],
                {
                  signalLifecycle: options.signalLifecycle,
                  stdio: "ignore",
                },
              );
              const deadline = Date.now() + 5_000;
              while (Date.now() < deadline) {
                try {
                  childPid =
                    parseRecordedProcessTree(
                      await readFile(childPidPath, "utf8"),
                    )?.leaderPid ?? 0;
                  break;
                } catch {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                }
              }
              if (!childPid) {
                throw new Error("managed git fixture did not start");
              }
              process.emit("SIGTERM", "SIGTERM");
              await running;
              return { stdout: "", stderr: "" };
            },
            temporaryParent,
            verify: async () => ({
              files: 1,
              commit: UPSTREAM.commit,
            }),
          },
        ),
      ).rejects.toMatchObject({
        signal: "SIGTERM",
        stage: "patch-apply",
      });

      expect(calls).toEqual([
        ["git", "apply", "--check", patchPath],
      ]);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(await readdir(temporaryParent)).toEqual(["git-child.pid"]);
    } finally {
      lifecycle.remove();
      await forceCleanupRecordedProcessTree(childPidPath);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 20_000);

  it("真实 prepare CLI 强杀忽略首信号的 git 进程树后仍以首个 SIGTERM 退出", async () => {
    const result = await runRealConsolePrepareCliForceKillTest();

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
      });
      await expect(
        readFile(result.signalLogPath, "utf8"),
      ).resolves.toEqual(
        expect.stringContaining("git:SIGTERM"),
      );
      const processTreeExited = await waitForProcessTargetsToExit(
        result.fakeGitPid,
        [result.grandchildPid],
      );
      const remainingProcesses = processTreeExited
        ? ""
        : (
            await execFileAsync("ps", [
              "-o",
              "pid=,ppid=,pgid=,stat=,command=",
              "-p",
              `${result.fakeGitPid},${result.grandchildPid}`,
            ])
          ).stdout;
      expect(
        processTreeExited,
        `fakeGitPid=${result.fakeGitPid}\nstderr=${result.stderr}\n${remainingProcesses}`,
      ).toBe(true);
      expect(processTargetExists(result.fakeGitPid, true)).toBe(false);
      await expect(
        processPidIsActive(result.fakeGitPid),
      ).resolves.toBe(false);
      await expect(
        processPidIsActive(result.grandchildPid),
      ).resolves.toBe(false);
      expect(
        (await readdir(result.temporaryRoot)).filter((entry) =>
          entry.startsWith("digitalmate-qwenpaw-console-"),
        ),
      ).toEqual([]);
    } finally {
      await forceCleanupRecordedProcessTree(result.pidPath);
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("QwenPaw Console isolated test runner", () => {
  it.each([
    { failedCommand: null, exitCode: 0 },
    { failedCommand: 0, exitCode: 23 },
    { failedCommand: 1, exitCode: 37 },
    { failedCommand: 2, exitCode: 41 },
  ])(
    "命令结果为 $exitCode 时清理准备目录并精确保留退出码",
    async ({ failedCommand, exitCode }) => {
      const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "dm-qwenpaw-test-runner-"),
      );
      const workdir = path.join(temporaryRoot, "console");
      await mkdir(workdir);
      const commands: Array<{ command: string; args: string[]; cwd: string }> =
        [];
      let validationCount = 0;

      const outcome = await runPreparedConsoleTests({
        prepare: async () => ({ workdir, applied: [...PATCHES] }),
        runCommand: async (command, args, options) => {
          commands.push({ command, args: [...args], cwd: options.cwd });
          const commandIndex = commands.length - 1;
          return commandIndex === failedCommand
            ? { exitCode, signal: null }
            : { exitCode: 0, signal: null };
        },
        validateBuild: async () => {
          validationCount += 1;
          return { indexPath: "", logoPath: "", resourceUrls: [] };
        },
      });

      expect(outcome).toEqual({ exitCode, signal: null });
      expect(commands).toEqual(
        CONSOLE_TEST_COMMANDS.slice(
          0,
          failedCommand === null ? undefined : failedCommand + 1,
        ).map(([command, ...args]) => ({ command, args, cwd: workdir })),
      );
      expect(validationCount).toBe(failedCommand === null ? 1 : 0);
      await expectPathMissing(workdir);
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  );

  it("严格按依赖、测试、生产构建的顺序运行", () => {
    expect(CONSOLE_TEST_COMMANDS).toEqual([
      ["npm", "ci"],
      ["npm", "run", "test:run"],
      ["npm", "run", "build:prod"],
    ]);
  });

  it.each([
    { label: "null 结果", prepared: null },
    { label: "undefined 结果", prepared: undefined },
    { label: "空字符串结果", prepared: "" },
    { label: "空 workdir", prepared: { workdir: "", applied: [] } },
  ])(
    "prepare 返回 $label 时在任何 npm 命令前拒绝",
    async ({ prepared }) => {
      let commandCount = 0;
      let validationCount = 0;
      let cleanupCount = 0;

      await expect(
        runPreparedConsoleTests({
          prepare: async () => prepared as never,
          runCommand: async () => {
            commandCount += 1;
            return { exitCode: 0, signal: null };
          },
          validateBuild: async () => {
            validationCount += 1;
            return { indexPath: "", logoPath: "", resourceUrls: [] };
          },
          cleanup: async () => {
            cleanupCount += 1;
          },
        }),
      ).rejects.toThrow(
        "Console preparation did not return a workdir",
      );
      expect(commandCount).toBe(0);
      expect(validationCount).toBe(0);
      expect(cleanupCount).toBe(0);
    },
  );

  it.each([
    {
      label: "非零 outcome",
      runTests: async () => ({
        cleanupError: Object.assign(new Error("cleanup failed"), {
          cleanupErrors: [
            {
              stage: "prepared",
              path: "/safe/tmp/qwenpaw-console-test",
              error: new Error("prepared removal failed"),
            },
          ],
        }),
        exitCode: 23,
        signal: null,
      }),
      terminalEvent: "exit:23",
      firstLine: null,
    },
    {
      label: "异常 rejection",
      runTests: async () => {
        throw Object.assign(new Error("tests failed"), {
          cleanupErrors: [
            {
              stage: "prepared",
              path: "/safe/tmp/qwenpaw-console-test",
              error: new Error("prepared removal failed"),
            },
          ],
        });
      },
      terminalEvent: "exit:1",
      firstLine: "stderr:tests failed",
    },
  ])(
    "console:test CLI 在$label时输出 cleanup 阶段、路径与 message",
    async ({ runTests, terminalEvent, firstLine }) => {
      const testing = Reflect.get(
        consoleTestScript,
        "__testing",
      ) as unknown as
        | {
            runTestCli?: (options: {
              resendSignal: (signal: string) => void;
              runTests: () => Promise<unknown>;
              setExitCode: (exitCode: number) => void;
              writeStderr: (line: string) => void;
            }) => Promise<void>;
          }
        | undefined;
      const runTestCli = testing?.runTestCli;
      const events: string[] = [];

      expect(runTestCli).toBeTypeOf("function");
      if (typeof runTestCli !== "function") {
        return;
      }
      await runTestCli({
        resendSignal: (signal) => {
          events.push(`signal:${signal}`);
        },
        runTests,
        setExitCode: (exitCode) => {
          events.push(`exit:${exitCode}`);
        },
        writeStderr: (line) => {
          events.push(`stderr:${line}`);
        },
      });

      expect(events).toEqual([
        ...(firstLine ? [firstLine] : []),
        "stderr:Console cleanup failed at prepared (/safe/tmp/qwenpaw-console-test): prepared removal failed",
        terminalEvent,
      ]);
    },
  );

  it.each([
    {
      label: "非空字面量加号前缀",
      source: 'const loader = "assets" + "/loader.js";\n',
    },
    {
      label: "动态加号前缀",
      source: 'const loader = prefix + "/loader.js";\n',
    },
    {
      label: "嵌套加号链外层动态前缀",
      source: 'const loader = prefix + ("" + "/loader.js");\n',
    },
    {
      label: "concat 链较早的非空前缀",
      source:
        'const loader = "".concat("assets", "", "/loader.js");\n',
    },
  ])("$label 不会把片段资源误判为根资源", async ({ source }) => {
    const testing = Reflect.get(consoleTestScript, "__testing") as
      | {
          validateConsoleBuild: (workdir: string) => Promise<unknown>;
        }
      | undefined;
    expect(testing).toBeDefined();
    if (!testing) {
      return;
    }

    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-dist-concat-"),
    );
    const distRoot = path.join(temporaryRoot, "dist");
    const scriptPath = path.join(distRoot, "assets", "app.js");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(path.join(distRoot, "index.html"), "<main></main>\n");
    await writeFile(
      path.join(distRoot, "digitalmate-logo.svg"),
      "<svg />\n",
    );
    await writeFile(scriptPath, source);

    try {
      await expect(
        testing.validateConsoleBuild(temporaryRoot),
      ).resolves.toBeDefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "独立 JavaScript 缺失资源",
      relativePath: "assets/app.js",
      source: 'const avatar = "/missing.svg";\n',
      expected:
        "build resource outside /_admin-console/: /missing.svg",
    },
    {
      label: "CSS 缺失资源",
      relativePath: "assets/app.css",
      source: '.avatar{background:url("/missing.svg")}\n',
      expected:
        "build resource outside /_admin-console/: /missing.svg",
    },
    {
      label: "JavaScript 非前缀点段资源",
      relativePath: "assets/app.js",
      source: 'const avatar = "/assets/../online.svg";\n',
      expected:
        "build resource outside /_admin-console/: /assets/../online.svg",
    },
    {
      label: "JavaScript 前缀内点段资源",
      relativePath: "assets/app.js",
      source:
        'const avatar = "/_admin-console/assets/../online.svg";\n',
      expected:
        "invalid build resource path: /_admin-console/assets/../online.svg",
    },
    {
      label: "空字面量加号前缀",
      relativePath: "assets/app.js",
      source: 'const avatar = "" + "/missing.svg";\n',
      expected:
        "build resource outside /_admin-console/: /missing.svg",
    },
    {
      label: "只有后缀的加号拼接",
      relativePath: "assets/app.js",
      source: 'const worker = "/worker.js" + suffix;\n',
      expected:
        "build resource outside /_admin-console/: /worker.js",
    },
    {
      label: "只有后缀的 concat 拼接",
      relativePath: "assets/app.js",
      source: 'const worker = "/worker.js".concat(suffix);\n',
      expected:
        "build resource outside /_admin-console/: /worker.js",
    },
    {
      label: "全空 concat 前缀链",
      relativePath: "assets/app.js",
      source: 'const avatar = "".concat("", "/missing.svg");\n',
      expected:
        "build resource outside /_admin-console/: /missing.svg",
    },
    {
      label: "嵌套全空加号前缀链",
      relativePath: "assets/app.js",
      source: 'const avatar = "" + ("" + "/missing.svg");\n',
      expected:
        "build resource outside /_admin-console/: /missing.svg",
    },
  ])("$label 会被产物扫描拒绝", async ({ relativePath, source, expected }) => {
    const testing = Reflect.get(consoleTestScript, "__testing") as
      | {
          validateConsoleBuild: (workdir: string) => Promise<unknown>;
        }
      | undefined;
    expect(testing).toBeDefined();
    if (!testing) {
      return;
    }

    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-dist-context-"),
    );
    const distRoot = path.join(temporaryRoot, "dist");
    const resourcePath = path.join(distRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(resourcePath), { recursive: true });
    await writeFile(path.join(distRoot, "index.html"), "<main></main>\n");
    await writeFile(
      path.join(distRoot, "digitalmate-logo.svg"),
      "<svg />\n",
    );
    await writeFile(path.join(distRoot, "online.svg"), "<svg />\n");
    await writeFile(resourcePath, source);

    try {
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        expected,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("校验生产入口资源均位于部署前缀且存在，并要求品牌图标被复制", async () => {
    const testing = Reflect.get(consoleTestScript, "__testing") as
      | {
          validateConsoleBuild: (workdir: string) => Promise<unknown>;
        }
      | undefined;
    expect(testing).toBeDefined();
    if (!testing) {
      return;
    }

    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-dist-"),
    );
    const distRoot = path.join(temporaryRoot, "dist");
    const scriptPath = path.join(distRoot, "assets", "chunks", "app.js");
    const stylesheetPath = path.join(
      distRoot,
      "assets",
      "styles",
      "app.css",
    );
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(stylesheetPath), { recursive: true });
    await writeFile(
      scriptPath,
      'const avatar = "/_admin-console/online.svg";\n' +
        'const monacoLoader = config.paths.vs + "/loader.js";\n' +
        'const transpiledLoader = "".concat(config.paths.vs, "/loader.js");\n' +
        '// const ignored = "/commented.svg";\n' +
        '/* const ignoredToo = "/commented-too.svg"; */\n',
    );
    await writeFile(
      stylesheetPath,
      '.avatar{background-image:url("/_admin-console/online.svg")}\n',
    );
    await writeFile(path.join(distRoot, "online.svg"), "<svg />\n");
    await writeFile(path.join(distRoot, "digitalmate-logo.svg"), "<svg />\n");

    try {
      await writeFile(
        path.join(distRoot, "index.html"),
        '<script src="/_admin-console/assets/chunks/app.js"></script>' +
          '<link rel="stylesheet" href="/_admin-console/assets/styles/app.css">' +
          '<link href="/_admin-console/online.svg">',
      );
      await expect(
        testing.validateConsoleBuild(temporaryRoot),
      ).resolves.toBeDefined();

      await writeFile(scriptPath, 'const avatar = "/online.svg";\n');
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "outside /_admin-console/",
      );
      await writeFile(
        scriptPath,
        'const avatar = "/_admin-console/online.svg";\n' +
          'const monacoLoader = config.paths.vs + "/loader.js";\n' +
          'const transpiledLoader = "".concat(config.paths.vs, "/loader.js");\n' +
          '// const ignored = "/commented.svg";\n' +
          '/* const ignoredToo = "/commented-too.svg"; */\n',
      );

      await writeFile(
        stylesheetPath,
        '.avatar{background-image:url("/online.svg")}\n',
      );
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "outside /_admin-console/",
      );
      await writeFile(
        stylesheetPath,
        '.avatar{background-image:url("/_admin-console/online.svg")}\n',
      );

      await writeFile(
        scriptPath,
        'const avatar = "/_admin-console/missing.svg";\n',
      );
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "missing build asset",
      );
      await writeFile(
        scriptPath,
        'const avatar = "/_admin-console/online.svg";\n',
      );

      await writeFile(
        path.join(distRoot, "index.html"),
        '<script src="/assets/app.js"></script>',
      );
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "outside /_admin-console/",
      );

      await writeFile(
        path.join(distRoot, "index.html"),
        '<script src="/_admin-console/assets/missing.js"></script>',
      );
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "missing build asset",
      );

      await rm(path.join(distRoot, "digitalmate-logo.svg"));
      await writeFile(
        path.join(distRoot, "index.html"),
        '<script src="/_admin-console/assets/chunks/app.js"></script>',
      );
      await expect(testing.validateConsoleBuild(temporaryRoot)).rejects.toThrow(
        "digitalmate-logo.svg",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("执行异常与清理异常同时发生时保留执行异常并附加清理错误", async () => {
    const primaryError = new Error("injected spawn failure");
    const cleanupError = new Error("injected cleanup failure");

    await expect(
      runPreparedConsoleTests({
        prepare: async () => ({ workdir: "/virtual/console", applied: [] }),
        runCommand: async () => {
          throw primaryError;
        },
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    ).rejects.toBe(primaryError);
    expect(Reflect.get(primaryError, "cleanupError")).toBe(cleanupError);
  });

  it("test runner 的冻结主错误、首信号与清理错误共存时不被 TypeError 掩盖", async () => {
    const originalError = new Error("frozen test command failure");
    Object.defineProperty(originalError, "signal", {
      configurable: false,
      enumerable: true,
      value: "SIGKILL",
    });
    Object.preventExtensions(originalError);
    const cleanupError = new Error("test prepared cleanup failed");
    let caughtError: unknown;

    try {
      await runPreparedConsoleTests({
        prepare: async () => ({
          workdir: "/virtual/frozen-test-console",
          applied: [],
        }),
        runCommand: async () => {
          process.emit("SIGTERM", "SIGTERM");
          throw originalError;
        },
        cleanup: async () => {
          throw cleanupError;
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(TypeError);
    expect(caughtError).not.toBe(originalError);
    expect(Reflect.get(caughtError as object, "cause")).toBe(
      originalError,
    );
    expect(Reflect.get(caughtError as object, "signal")).toBe("SIGTERM");
    expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
      cleanupError,
    );
    expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
      {
        stage: "prepared",
        path: "/virtual/frozen-test-console",
        error: cleanupError,
      },
    ]);
  });

  it("非零退出和清理异常同时发生时保留原退出码", async () => {
    const cleanupError = new Error("injected cleanup failure");

    await expect(
      runPreparedConsoleTests({
        prepare: async () => ({ workdir: "/virtual/console", applied: [] }),
        runCommand: async () => ({ exitCode: 29, signal: null }),
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    ).resolves.toEqual({
      exitCode: 29,
      signal: null,
      cleanupError,
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s 中断后停止后续命令、完成清理并保留信号",
    async (signal) => {
      const commands: string[] = [];
      let cleanupCount = 0;

      const outcome = await runPreparedConsoleTests({
        prepare: async () => ({ workdir: "/virtual/console", applied: [] }),
        runCommand: async (command) => {
          commands.push(command);
          return { exitCode: 1, signal };
        },
        cleanup: async () => {
          cleanupCount += 1;
        },
      });

      expect(outcome).toEqual({ exitCode: 1, signal });
      expect(commands).toEqual(["npm"]);
      expect(cleanupCount).toBe(1);
    },
  );

  it("prepare 阶段收到真实 SIGINT 后清理目录且不执行命令", async () => {
    const result = await runRealSignalLifecycleTest("SIGINT", "prepare");

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGINT",
      });
      await expectPathMissing(result.workdir);
      await expectPathMissing(result.commandLogPath);
      expect(result.stderr).toBe("");
    } finally {
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("cleanup 阶段收到真实 SIGTERM 后完成清理并按原信号退出", async () => {
    const result = await runRealSignalLifecycleTest("SIGTERM", "cleanup");

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
      });
      await expectPathMissing(result.workdir);
      await expect(readFile(result.commandLogPath, "utf8")).resolves.toBe(
        "npm\nnpm\nnpm\n",
      );
      expect(result.stderr).toBe("");
    } finally {
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("信号与清理异常同时发生时保留信号", async () => {
    const cleanupError = new Error("injected cleanup failure");

    await expect(
      runPreparedConsoleTests({
        prepare: async () => ({ workdir: "/virtual/console", applied: [] }),
        runCommand: async () => ({ exitCode: 1, signal: "SIGTERM" }),
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    ).resolves.toEqual({
      exitCode: 1,
      signal: "SIGTERM",
      cleanupError,
    });
  });

  it("命令成功但清理失败时抛出清理错误", async () => {
    const cleanupError = new Error("injected cleanup failure");

    await expect(
      runPreparedConsoleTests({
        prepare: async () => ({ workdir: "/virtual/console", applied: [] }),
        runCommand: async () => ({ exitCode: 0, signal: null }),
        validateBuild: async () => ({
          indexPath: "",
          logoPath: "",
          resourceUrls: [],
        }),
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    ).rejects.toBe(cleanupError);
  });
});

type ConsoleBuildTestingInterface = {
  formatErrorDetails: (error: unknown) => string[];
  publishConsoleBuild: (
    distRoot: string,
    options: {
      publicRoot: string;
      fileOperations?: {
        chmod?: typeof chmod;
        cp?: typeof cp;
        lstat?: typeof lstat;
        mkdtemp?: typeof mkdtemp;
        mkdir?: typeof mkdir;
        readdir?: typeof readdir;
        rename?: typeof rename;
        rm?: typeof rm;
      };
    },
  ) => Promise<{ publishRoot: string }>;
};

async function createConsoleBuildFixture(options?: {
  existingPublish?: boolean;
}): Promise<{
  distRoot: string;
  preparedRoot: string;
  publicRoot: string;
  publishRoot: string;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "dm-qwenpaw-build-"),
  );
  const preparedRoot = path.join(temporaryRoot, "prepared");
  const distRoot = path.join(preparedRoot, "dist");
  const assetsRoot = path.join(distRoot, "assets");
  const publicRoot = path.join(temporaryRoot, "public");
  const publishRoot = path.join(publicRoot, "_admin-console");
  await mkdir(assetsRoot, { recursive: true });
  await mkdir(publicRoot, { recursive: true });
  await writeFile(
    path.join(distRoot, "index.html"),
    [
      '<script type="module" src="/_admin-console/assets/app-abc12345.js"></script>',
      '<img src="/_admin-console/digitalmate-logo.svg">',
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(distRoot, "digitalmate-logo.svg"),
    "<svg></svg>\n",
    "utf8",
  );
  await writeFile(
    path.join(assetsRoot, "app-abc12345.js"),
    'console.log("new console");\n',
    "utf8",
  );
  if (options?.existingPublish !== false) {
    await mkdir(publishRoot);
    await writeFile(path.join(publishRoot, "old.txt"), "old console\n", "utf8");
  }
  return {
    distRoot,
    preparedRoot,
    publicRoot,
    publishRoot,
    temporaryRoot,
  };
}

function requireBuildTestingInterface(): ConsoleBuildTestingInterface {
  expect(buildTesting).toBeDefined();
  return buildTesting as ConsoleBuildTestingInterface;
}

async function listConsolePublicationResidue(publicRoot: string) {
  return (await readdir(publicRoot))
    .filter(
      (entry) =>
        entry.startsWith(".admin-console-staging") ||
        entry.startsWith(".admin-console-backup"),
    )
    .sort();
}

describe("QwenPaw Console atomic static build", () => {
  it("固定安装与生产构建命令，构建失败时不发布并清理准备目录", async () => {
    expect(CONSOLE_BUILD_COMMANDS).toEqual([
      ["npm", "ci"],
      ["npm", "run", "build:prod"],
    ]);

    const fixture = await createConsoleBuildFixture();
    const publishCalls: string[] = [];
    const commands: string[] = [];
    const commandErrorCode = 29;

    try {
      await expect(
        buildConsole({
          prepare: async () => ({
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          }),
          runCommand: async (command, args) => {
            commands.push([command, ...args].join(" "));
            return {
              exitCode:
                commands.length === CONSOLE_BUILD_COMMANDS.length
                  ? commandErrorCode
                  : 0,
              signal: null,
            };
          },
          publishBuild: async (distRoot: string) => {
            publishCalls.push(distRoot);
            return { publishRoot: fixture.publishRoot };
          },
          publicRoot: fixture.publicRoot,
        }),
      ).rejects.toMatchObject({
        command: "npm run build:prod",
        exitCode: commandErrorCode,
      });

      expect(commands).toEqual(["npm ci", "npm run build:prod"]);
      expect(publishCalls).toEqual([]);
      await expect(readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
      await expectPathMissing(fixture.preparedRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("dist 校验失败时不发布且总是清理准备目录", async () => {
    const fixture = await createConsoleBuildFixture();
    const validationError = new Error("invalid dist fixture");
    let publishCount = 0;

    try {
      await expect(
        buildConsole({
          prepare: async () => ({
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          }),
          runCommand: async () => ({ exitCode: 0, signal: null }),
          validateBuild: async () => {
            throw validationError;
          },
          publishBuild: async () => {
            publishCount += 1;
            return { publishRoot: fixture.publishRoot };
          },
          publicRoot: fixture.publicRoot,
        }),
      ).rejects.toBe(validationError);

      expect(publishCount).toBe(0);
      await expect(readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
      await expectPathMissing(fixture.preparedRoot);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("成功时在 public 同文件系统原子替换旧产物且无临时残留", async () => {
    const fixture = await createConsoleBuildFixture();
    const { publishConsoleBuild } = requireBuildTestingInterface();

    try {
      await expect(
        publishConsoleBuild(fixture.distRoot, {
          publicRoot: fixture.publicRoot,
        }),
      ).resolves.toEqual({ publishRoot: fixture.publishRoot });

      await expectPathMissing(path.join(fixture.publishRoot, "old.txt"));
      await expect(
        readFile(
          path.join(fixture.publishRoot, "assets", "app-abc12345.js"),
          "utf8",
        ),
      ).resolves.toContain("new console");
      expect((await lstat(fixture.publishRoot)).mode & 0o777).toBe(0o755);
      expect(
        (await lstat(path.join(fixture.publishRoot, "assets"))).mode & 0o777,
      ).toBe(0o755);
      expect(
        (
          await lstat(
            path.join(
              fixture.publishRoot,
              "assets",
              "app-abc12345.js",
            ),
          )
        ).mode & 0o777,
      ).toBe(0o644);
      expect(await listConsolePublicationResidue(fixture.publicRoot)).toEqual([]);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("安装新产物失败时回滚旧产物并清理 staging 与 backup", async () => {
    const fixture = await createConsoleBuildFixture();
    const { publishConsoleBuild } = requireBuildTestingInterface();
    const installError = new Error("injected install failure");

    try {
      await expect(
        publishConsoleBuild(fixture.distRoot, {
          publicRoot: fixture.publicRoot,
          fileOperations: {
            rename: async (source, destination) => {
              if (
                path
                  .basename(String(source))
                  .startsWith(".admin-console-staging") &&
                destination === fixture.publishRoot
              ) {
                throw installError;
              }
              await rename(source, destination);
            },
          },
        }),
      ).rejects.toBe(installError);

      await expect(readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
      expect(await listConsolePublicationResidue(fixture.publicRoot)).toEqual([]);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("并发目标阻止回滚时保留唯一 backup 并报告状态与路径", async () => {
    const fixture = await createConsoleBuildFixture();
    const { publishConsoleBuild } = requireBuildTestingInterface();
    const installError = new Error("injected concurrent install failure");
    let caughtError: unknown;

    try {
      await publishConsoleBuild(fixture.distRoot, {
        publicRoot: fixture.publicRoot,
        fileOperations: {
          rename: async (source, destination) => {
            if (
              path
                .basename(String(source))
                .startsWith(".admin-console-staging") &&
              destination === fixture.publishRoot
            ) {
              await mkdir(fixture.publishRoot);
              await writeFile(
                path.join(fixture.publishRoot, "concurrent.txt"),
                "concurrent publish\n",
                "utf8",
              );
              throw installError;
            }
            await rename(source, destination);
          },
        },
      });
    } catch (error) {
      caughtError = error;
    }

    try {
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).toMatchObject({
        publishState: "rollback-blocked",
      });
      const backupPath = Reflect.get(
        caughtError as object,
        "backupPath",
      ) as string;
      expect(path.dirname(backupPath)).toBe(fixture.publicRoot);
      expect(path.basename(backupPath)).toMatch(/^\.admin-console-backup-/);
      await expect(readFile(path.join(backupPath, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
      await expect(
        readFile(path.join(fixture.publishRoot, "concurrent.txt"), "utf8"),
      ).resolves.toBe("concurrent publish\n");
      expect(await listConsolePublicationResidue(fixture.publicRoot)).toEqual([
        path.basename(backupPath),
      ]);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("没有旧产物时安装失败不会留下半成品", async () => {
    const fixture = await createConsoleBuildFixture({
      existingPublish: false,
    });
    const { publishConsoleBuild } = requireBuildTestingInterface();
    const installError = new Error("injected first install failure");

    try {
      await expect(
        publishConsoleBuild(fixture.distRoot, {
          publicRoot: fixture.publicRoot,
          fileOperations: {
            rename: async (source, destination) => {
              if (
                path
                  .basename(String(source))
                  .startsWith(".admin-console-staging") &&
                destination === fixture.publishRoot
              ) {
                throw installError;
              }
              await rename(source, destination);
            },
          },
        }),
      ).rejects.toBe(installError);

      await expectPathMissing(fixture.publishRoot);
      expect(await listConsolePublicationResidue(fixture.publicRoot)).toEqual([]);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("复制失败不触碰旧产物，且 staging 清理错误不掩盖主错误", async () => {
    const fixture = await createConsoleBuildFixture();
    const { publishConsoleBuild } = requireBuildTestingInterface();
    const copyError = new Error("injected copy failure");
    const cleanupError = new Error("injected staging cleanup failure");

    try {
      let caughtError: unknown;
      try {
        await publishConsoleBuild(fixture.distRoot, {
          publicRoot: fixture.publicRoot,
          fileOperations: {
            cp: async () => {
              throw copyError;
            },
            rm: async (target, options) => {
              if (
                path
                  .basename(String(target))
                  .startsWith(".admin-console-staging")
              ) {
                throw cleanupError;
              }
              await rm(target, options);
            },
          },
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(copyError);
      expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
        cleanupError,
      );
      await expect(readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("拒绝 dist 中的符号链接与缺少内容哈希 assets，旧产物保持不变", async () => {
    const { publishConsoleBuild } = requireBuildTestingInterface();

    for (const variant of [
      "symlink",
      "unhashed-assets",
      "mixed-unhashed-assets",
    ] as const) {
      const fixture = await createConsoleBuildFixture();
      try {
        if (variant === "symlink") {
          await symlink(
            "../digitalmate-logo.svg",
            path.join(fixture.distRoot, "assets", "linked.svg"),
          );
        } else if (variant === "unhashed-assets") {
          await rename(
            path.join(fixture.distRoot, "assets", "app-abc12345.js"),
            path.join(fixture.distRoot, "assets", "app.js"),
          );
        } else {
          await writeFile(
            path.join(fixture.distRoot, "assets", "runtime.js"),
            "console.log('unhashed runtime');\n",
            "utf8",
          );
        }

        await expect(
          publishConsoleBuild(fixture.distRoot, {
            publicRoot: fixture.publicRoot,
          }),
        ).rejects.toThrow(
          variant === "symlink"
            ? "symbolic link not allowed"
            : "unhashed build asset not allowed",
        );
        await expect(
          readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"),
        ).resolves.toBe("old console\n");
        expect(await listConsolePublicationResidue(fixture.publicRoot)).toEqual(
          [],
        );
      } finally {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }
  });

  it("命令主错误优先于 prepared cleanup 错误", async () => {
    const commandErrorCode = 51;
    const cleanupError = new Error("injected prepared cleanup failure");
    let caughtError: unknown;

    try {
      await buildConsole({
        prepare: async () => ({
          workdir: "/virtual/prepared-console",
          applied: [...PATCHES],
        }),
        runCommand: async () => ({
          exitCode: commandErrorCode,
          signal: null,
        }),
        cleanupPrepared: async () => {
          throw cleanupError;
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      command: "npm ci",
      exitCode: commandErrorCode,
    });
    expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
      cleanupError,
    );
  });

  it("同时累计 staging 与 prepared 清理错误且不覆盖发布主错误", async () => {
    const fixture = await createConsoleBuildFixture();
    const { publishConsoleBuild } = requireBuildTestingInterface();
    const copyError = new Error("injected publish copy failure");
    const stagingCleanupError = new Error("injected staging cleanup failure");
    const preparedCleanupError = new Error("injected prepared cleanup failure");
    let caughtError: unknown;

    try {
      try {
        await buildConsole({
          prepare: async () => ({
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          }),
          runCommand: async () => ({ exitCode: 0, signal: null }),
          validateBuild: async () => ({
            indexPath: "",
            logoPath: "",
            resourceUrls: [],
          }),
          publishBuild: (distRoot: string) =>
            publishConsoleBuild(distRoot, {
              publicRoot: fixture.publicRoot,
              fileOperations: {
                cp: async () => {
                  throw copyError;
                },
                rm: async (target, options) => {
                  if (
                    path
                      .basename(String(target))
                      .startsWith(".admin-console-staging")
                  ) {
                    throw stagingCleanupError;
                  }
                  await rm(target, options);
                },
              },
            }),
          cleanupPrepared: async () => {
            throw preparedCleanupError;
          },
          publicRoot: fixture.publicRoot,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(copyError);
      expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
        stagingCleanupError,
      );
      expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
        {
          stage: "staging",
          path: expect.stringContaining(".admin-console-staging-"),
          error: stagingCleanupError,
        },
        {
          stage: "prepared",
          path: fixture.preparedRoot,
          error: preparedCleanupError,
        },
      ]);
      await expect(readFile(path.join(fixture.publishRoot, "old.txt"), "utf8"))
        .resolves.toBe("old console\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("共享正式导出 validator 与 signal lifecycle，生产构建不依赖 __testing", async () => {
    expect(Reflect.get(consoleTestScript, "validateConsoleBuild")).toBeTypeOf(
      "function",
    );
    expect(Reflect.get(consoleTestScript, "createSignalLifecycle")).toBeTypeOf(
      "function",
    );
    const buildSource = await readFile(
      "scripts/qwenpaw-console/build.mjs",
      "utf8",
    );
    const prepareSource = await readFile(
      "scripts/qwenpaw-console/prepare.mjs",
      "utf8",
    );
    const testSource = await readFile(
      "scripts/qwenpaw-console/test.mjs",
      "utf8",
    );
    expect(buildSource).not.toContain(
      "consoleTestTesting.validateConsoleBuild",
    );
    expect(buildSource).not.toMatch(
      /import\s*\{\s*__testing\b[^}]*\}\s*from\s*["']\.\/test\.mjs["']/,
    );
    expect(buildSource).not.toContain('from "./test.mjs"');
    expect(prepareSource).not.toContain('from "./test.mjs"');
    for (const cliSource of [
      buildSource,
      prepareSource,
      testSource,
    ]) {
      expect(cliSource).toContain("onDiagnostic:");
      expect(cliSource).toContain(
        "formatSignalLifecycleDiagnostic(diagnostic)",
      );
    }
  });

  it("CLI 错误详情同时包含回滚 backup 路径与每个 cleanup 阶段路径", () => {
    const { formatErrorDetails } = requireBuildTestingInterface();
    const stagingCleanup = new Error("staging cleanup failed");
    const preparedCleanup = new Error("prepared cleanup failed");
    const error = Object.assign(new Error("publish failed"), {
      publishState: "rollback-blocked",
      backupPath: "/safe/public/.admin-console-backup-fixture",
      cleanupErrors: [
        {
          stage: "staging",
          path: "/safe/public/.admin-console-staging-fixture",
          error: stagingCleanup,
        },
        {
          stage: "prepared",
          path: "/safe/tmp/digitalmate-qwenpaw-console-fixture",
          error: preparedCleanup,
        },
      ],
    });

    expect(formatErrorDetails).toBeTypeOf("function");
    expect(formatErrorDetails(error)).toEqual([
      "Console publish recovery: state=rollback-blocked backup=/safe/public/.admin-console-backup-fixture",
      "Console cleanup failed at staging (/safe/public/.admin-console-staging-fixture): staging cleanup failed",
      "Console cleanup failed at prepared (/safe/tmp/digitalmate-qwenpaw-console-fixture): prepared cleanup failed",
    ]);
  });

  it("signal lifecycle 保留首信号，并将第二个信号升级为进程组 SIGKILL", () => {
    const forwardedSignals: Array<{
      pid: number;
      signal: string | number;
    }> = [];
    const child = { pid: 4242 };
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      killProcess: (pid: number, signal: string | number = 0) => {
        forwardedSignals.push({ pid, signal });
        return true;
      },
      platform: "darwin",
    });

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      process.emit("SIGINT", "SIGINT");
      expect(lifecycle.signal).toBe("SIGTERM");
      expect(forwardedSignals).toEqual([
        { pid: -4242, signal: "SIGTERM" },
        { pid: -4242, signal: "SIGKILL" },
      ]);
      lifecycle.detachChild(child);
    } finally {
      lifecycle.remove();
    }

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("signal lifecycle 在有界超时后自动强杀仍活动的进程组", async () => {
    const forwardedSignals: Array<{
      pid: number;
      signal: string | number;
    }> = [];
    const child = { pid: 5252 };
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 20,
      killProcess: (pid: number, signal: string | number = 0) => {
        forwardedSignals.push({ pid, signal });
        return true;
      },
      platform: "linux",
    });

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGINT", "SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(lifecycle.signal).toBe("SIGINT");
      expect(forwardedSignals).toEqual([
        { pid: -5252, signal: "SIGINT" },
        { pid: -5252, signal: "SIGKILL" },
      ]);
      lifecycle.detachChild(child);
    } finally {
      lifecycle.remove();
    }
  });

  it("首信号覆盖不可写的子进程信号时包装错误并保留原始详情", () => {
    const originalError = new Error("git was force killed", {
      cause: new Error("original cause"),
    });
    Object.defineProperty(originalError, "signal", {
      configurable: false,
      enumerable: true,
      value: "SIGKILL",
    });
    Object.freeze(originalError);

    const interruptedError = attachSignalToError(
      originalError,
      "SIGTERM",
    );

    expect(interruptedError).not.toBe(originalError);
    expect(interruptedError).toMatchObject({
      message: "git was force killed",
      signal: "SIGTERM",
    });
    expect(Reflect.get(interruptedError, "cause")).toBe(originalError);
    expect(Reflect.get(originalError, "signal")).toBe("SIGKILL");
  });

  it.each([
    { outputStream: "stdout", withLifecycle: true },
    { outputStream: "stderr", withLifecycle: false },
  ] as const)(
    "真实 exec $outputStream 超过 maxBuffer 时强杀完整 detached 进程组且不伪造首信号",
    async ({ outputStream, withLifecycle }) => {
      if (process.platform === "win32") {
        return;
      }

      const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "dm-qwenpaw-max-buffer-"),
      );
      const pidPath = path.join(temporaryRoot, "fixture.pid");
      const identityToken = path.basename(temporaryRoot);
      const maxBuffer = 1_024;
      const lifecycle = withLifecycle
        ? createProcessSignalLifecycle({
            forceKillTimeoutMs: 100,
            treeExitTimeoutMs: 5_000,
          })
        : undefined;
      let caughtError: unknown;

      try {
        try {
          await runManagedExecFile(
            process.execPath,
            [
              "-e",
              `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const identityToken = ${JSON.stringify(identityToken)};
const grandchild = spawn(
  process.execPath,
  [
    "-e",
    ${JSON.stringify(`
const identityToken = ${JSON.stringify(identityToken)};
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
setInterval(() => identityToken.length, 1000);
`)},
  ],
  { stdio: "ignore" },
);
fs.writeFileSync(
  ${JSON.stringify(pidPath)},
  JSON.stringify({
    identityToken,
    leaderPid: process.pid,
    descendantPids: [grandchild.pid],
  }),
);
const output = process.${outputStream};
const payload = Buffer.alloc(64 * 1024, "x");
setInterval(() => {
  output.write(payload);
}, 0);
`,
            ],
            {
              maxBuffer,
              ...(lifecycle ? { signalLifecycle: lifecycle } : {}),
            },
          );
        } catch (error) {
          caughtError = error;
        }

        const record = parseRecordedProcessTree(
          await readFile(pidPath, "utf8"),
        );
        expect(record).not.toBeNull();
        expect.soft(caughtError).toMatchObject({
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          cmd: expect.stringContaining(process.execPath),
          killed: true,
          signal: null,
        });
        expect.soft(caughtError).toBeInstanceOf(Error);
        expect.soft((caughtError as Error).message).toContain(
          `${outputStream} maxBuffer`,
        );
        const retainedStdout = Reflect.get(
          caughtError as object,
          "stdout",
        );
        const retainedStderr = Reflect.get(
          caughtError as object,
          "stderr",
        );
        expect
          .soft(Buffer.byteLength(retainedStdout ?? ""))
          .toBeLessThanOrEqual(
          maxBuffer,
        );
        expect
          .soft(Buffer.byteLength(retainedStderr ?? ""))
          .toBeLessThanOrEqual(
          maxBuffer,
        );
        expect(lifecycle?.signal ?? null).toBeNull();
        expect(
          await waitForProcessTargetsToExit(
            record!.leaderPid,
            record!.descendantPids,
            100,
          ),
        ).toBe(true);
        expect(processTargetExists(record!.leaderPid, true)).toBe(false);
      } finally {
        await forceCleanupRecordedProcessTree(pidPath);
        lifecycle?.remove();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("进程组终止与探测失败只记诊断，仍会清理定时器和监听器", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    let clearedTimers = 0;
    const reportedDiagnostics: string[] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      killProcess: () => {
        const error = Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
        throw error;
      },
      onDiagnostic: (diagnostic) => {
        reportedDiagnostics.push(
          formatSignalLifecycleDiagnostic(diagnostic),
        );
      },
      platform: "linux",
      timerOperations: {
        clearTimeout: (timer) => {
          clearedTimers += 1;
          clearTimeout(timer);
        },
        setTimeout,
      },
      treeExitTimeoutMs: 0,
    });
    const child = { pid: 6262 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      await expect(lifecycle.settleChild(child)).resolves.toBeUndefined();
      expect(lifecycle.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "graceful",
            target: "process-group",
          }),
          expect.objectContaining({
            action: "force",
            target: "process-group",
          }),
          expect.objectContaining({
            action: "settle-timeout",
            target: "process-group",
          }),
        ]),
      );
      expect(reportedDiagnostics).toEqual(
        expect.arrayContaining([
          "Console process cleanup graceful failed for process-group pid=6262: permission denied",
          "Console process cleanup force failed for process-group pid=6262: permission denied",
          "Console process cleanup settle-timeout failed for process-group pid=6262: timed out waiting for process group to exit",
        ]),
      );
      expect(clearedTimers).toBeGreaterThan(0);
    } finally {
      lifecycle.remove();
    }

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("POSIX runner 在 child pid 无效且永不关闭时有界拒绝并保留首信号", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      kill() {
        return false;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });
    let timedOut = false;

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(timedOut).toBe(false);
      if (!raced.timedOut) {
        expect(raced).toMatchObject({
          error: {
            code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            signal: "SIGTERM",
          },
        });
      }
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      const diagnosticCount = lifecycle.diagnostics.length;
      child.emit("close", null, "SIGKILL");
      expect(lifecycle.diagnostics).toHaveLength(diagnosticCount);
    } finally {
      if (timedOut) {
        child.emit("close", null, "SIGKILL");
        await running.catch(() => {});
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX runner 在 group 与 direct kill 持续 EPERM 且 child 永不关闭时有界拒绝", async () => {
    const killCalls: Array<{
      pid: number;
      signal: string | number;
    }> = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 6363,
      kill() {
        return false;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: (pid: number, signal: string | number = 0) => {
        killCalls.push({ pid, signal });
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });
    let timedOut = false;

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(timedOut).toBe(false);
      if (!raced.timedOut) {
        expect(raced).toMatchObject({
          error: {
            code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            signal: "SIGTERM",
          },
        });
      }
      expect(killCalls).toEqual(
        expect.arrayContaining([
          { pid: -6363, signal: "SIGTERM" },
          { pid: 6363, signal: "SIGTERM" },
          { pid: -6363, signal: "SIGKILL" },
          { pid: 6363, signal: "SIGKILL" },
        ]),
      );
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      if (timedOut) {
        child.emit("close", null, "SIGKILL");
        await running.catch(() => {});
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX runner 在 child 已关闭但 PGID 持续不可确认退出时拒绝而非成功", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 6464,
      kill() {
        return false;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);

      expect(raced).toMatchObject({
        error: {
          code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
          signal: "SIGTERM",
        },
        timedOut: false,
      });
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX 同步 close 不会与 watchdog/settle 双跑后误报成功", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 6465,
      kill() {
        return false;
      },
    });
    let emittedClose = false;
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: (pid: number, signal: string | number = 0) => {
        if (
          !emittedClose &&
          pid === -6465 &&
          signal === "SIGTERM"
        ) {
          emittedClose = true;
          child.emit("close", null, "SIGTERM");
        }
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      await expect(running).rejects.toMatchObject({
        code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
        signal: "SIGTERM",
      });
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX maxBuffer 终止失败时保留 overflow 主错误与空信号并附 terminationError", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 6565,
      kill() {
        return false;
      },
    });
    let completeCommand:
      | ((error: Error, stdout: string, stderr: string) => void)
      | undefined;
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        completeCommand = callback;
        queueMicrotask(() =>
          options.onMaxBuffer?.(child, overflowError),
        );
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });
    let timedOut = false;

    try {
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(timedOut).toBe(false);
      if (!raced.timedOut) {
        expect("error" in raced).toBe(true);
        if ("error" in raced) {
          expect(raced.error).toBe(overflowError);
          expect(raced.error).toMatchObject({
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
            signal: null,
            terminationError: {
              code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            },
          });
        }
      }
      expect(lifecycle.signal).toBeNull();
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      if (timedOut) {
        completeCommand?.(overflowError, "", "");
        await running.catch(() => {});
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX maxBuffer 回调先完成但 PGID 未退出时仍附 terminationError", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 6566,
      kill() {
        return false;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        queueMicrotask(() => {
          options.onMaxBuffer?.(child, overflowError);
          queueMicrotask(() =>
            callback(overflowError, "", ""),
          );
        });
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });

    try {
      const caught = await running.catch((error) => error);

      expect(caught).toBe(overflowError);
      expect(caught).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
        terminationError: {
          code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
        },
      });
      expect(lifecycle.signal).toBeNull();
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it.each(["spawn", "exec"] as const)(
    "%s runner 连续收到两个 child error 时保留首错并等待 late close",
    async (runner) => {
      const firstError = Object.assign(new Error("first child error"), {
        code: "EIO",
      });
      const secondError = Object.assign(new Error("second child error"), {
        code: "EPIPE",
      });
      const childTarget = Object.assign(new EventEmitter(), {
        pid: runner === "spawn" ? 6563 : 6564,
        kill() {
          return true;
        },
      });
      let closeListener:
        | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
        | undefined;
      let disposeCount = 0;
      const child = new Proxy(childTarget, {
        get(target, property, receiver) {
          if (
            typeof property === "symbol" &&
            property.description === "managedProcessDispose"
          ) {
            return () => {
              disposeCount += 1;
              if (closeListener) {
                target.off("close", closeListener);
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      let detachCount = 0;
      let forceCount = 0;
      let settleCount = 0;
      let stopWatchingCount = 0;
      const lifecycle = {
        signal: null,
        detachedCommands: true,
        attachChild() {},
        detachChild() {
          detachCount += 1;
        },
        forceTerminateChild() {
          forceCount += 1;
          return Promise.resolve();
        },
        async settleChild() {
          settleCount += 1;
          detachCount += 1;
        },
        watchChildTermination() {
          return () => {
            stopWatchingCount += 1;
          };
        },
      };
      const running =
        runner === "spawn"
          ? runManagedSpawn("fake-command", [], {
              signalLifecycle: lifecycle as never,
              spawnProcess: (() =>
                child as unknown as ReturnType<
                  typeof spawn
                >) as unknown as typeof spawn,
            })
          : runManagedExecFile("fake-command", [], {
              execFileProcess: ((
                _command: string,
                _args: string[],
                _options: unknown,
                callback: (
                  error: Error,
                  stdout: string,
                  stderr: string,
                ) => void,
              ) => {
                closeListener = () =>
                  callback(firstError, "", "");
                child.once("close", closeListener);
                return child;
              }) as never,
              signalLifecycle: lifecycle as never,
            });
      const emittedErrors: unknown[] = [];
      let terminalCount = 0;

      for (const error of [firstError, secondError]) {
        try {
          child.emit("error", error);
        } catch (emittedError) {
          emittedErrors.push(emittedError);
        }
      }
      child.emit("close", null, "SIGKILL");
      const caught = await running.then(
        () => {
          terminalCount += 1;
          return undefined;
        },
        (error) => {
          terminalCount += 1;
          return error;
        },
      );

      expect(emittedErrors).toEqual([]);
      expect(caught).toBe(firstError);
      expect(Reflect.has(caught, "terminationError")).toBe(false);
      expect(terminalCount).toBe(1);
      expect(forceCount).toBe(2);
      expect(settleCount).toBe(1);
      expect(detachCount).toBe(1);
      expect(stopWatchingCount).toBe(1);
      expect(disposeCount).toBe(runner === "exec" ? 1 : 0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    },
  );

  it.each(["spawn", "exec"] as const)(
    "%s runner 的 direct kill 同步触发第二个 child error 时仍安全结算",
    async (runner) => {
      const firstError = Object.assign(new Error("first child error"), {
        code: "EIO",
      });
      const secondError = Object.assign(
        new Error("direct kill child error"),
        {
          code: "EPIPE",
        },
      );
      let groupAlive = true;
      let directKillCount = 0;
      let secondEmitError: unknown;
      let closeListener:
        | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
        | undefined;
      let disposeCount = 0;
      const childTarget = Object.assign(new EventEmitter(), {
        pid: runner === "spawn" ? 6565 : 6566,
        kill() {
          directKillCount += 1;
          groupAlive = false;
          try {
            childTarget.emit("error", secondError);
          } catch (error) {
            secondEmitError = error;
            throw error;
          }
          childTarget.emit("close", null, "SIGKILL");
          return true;
        },
      });
      const child = new Proxy(childTarget, {
        get(target, property, receiver) {
          if (
            typeof property === "symbol" &&
            property.description === "managedProcessDispose"
          ) {
            return () => {
              disposeCount += 1;
              if (closeListener) {
                target.off("close", closeListener);
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const activeTimers = new Set<ReturnType<typeof setTimeout>>();
      const lifecycle = createProcessSignalLifecycle({
        forceKillTimeoutMs: 10,
        killProcess: (_pid: number, signal: string | number = 0) => {
          if (signal === 0) {
            if (!groupAlive) {
              throw Object.assign(new Error("missing"), {
                code: "ESRCH",
              });
            }
            throw Object.assign(new Error("permission denied"), {
              code: "EPERM",
            });
          }
          throw Object.assign(new Error("permission denied"), {
            code: "EPERM",
          });
        },
        platform: "linux",
        timerOperations: {
          clearTimeout(timer: ReturnType<typeof setTimeout>) {
            activeTimers.delete(timer);
            clearTimeout(timer);
          },
          setTimeout(callback: () => void, delay: number) {
            const timer = setTimeout(() => {
              activeTimers.delete(timer);
              callback();
            }, delay);
            activeTimers.add(timer);
            return timer;
          },
        } as never,
        treeExitTimeoutMs: 10,
      });
      const originalSettleChild = lifecycle.settleChild;
      let settleCount = 0;
      lifecycle.settleChild = async (target) => {
        settleCount += 1;
        await originalSettleChild(target);
      };
      const running =
        runner === "spawn"
          ? runManagedSpawn("fake-command", [], {
              signalLifecycle: lifecycle,
              spawnProcess: (() =>
                child as unknown as ReturnType<
                  typeof spawn
                >) as unknown as typeof spawn,
            })
          : runManagedExecFile("fake-command", [], {
              execFileProcess: ((
                _command: string,
                _args: string[],
                _options: unknown,
                callback: (
                  error: Error,
                  stdout: string,
                  stderr: string,
                ) => void,
              ) => {
                closeListener = () =>
                  callback(firstError, "", "");
                child.once("close", closeListener);
                return child;
              }) as never,
              signalLifecycle: lifecycle,
            });
      let terminalCount = 0;

      try {
        child.emit("error", firstError);
        const caught = await running.then(
          () => {
            terminalCount += 1;
            return undefined;
          },
          (error) => {
            terminalCount += 1;
            return error;
          },
        );

        expect(secondEmitError).toBeUndefined();
        expect(caught).toBe(firstError);
        expect(Reflect.has(caught, "terminationError")).toBe(false);
        expect(terminalCount).toBe(1);
        expect(directKillCount).toBe(1);
        expect(settleCount).toBe(1);
        expect(disposeCount).toBe(runner === "exec" ? 1 : 0);
        expect(child.listenerCount("error")).toBe(0);
        expect(child.listenerCount("close")).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(
          lifecycle.diagnostics.some(
            (diagnostic) =>
              diagnostic.action === "runner-timeout" ||
              diagnostic.action === "settle-timeout",
          ),
        ).toBe(false);
        expect(lifecycle.signal).toBeNull();
      } finally {
        lifecycle.detachChild(child);
        lifecycle.remove();
        for (const timer of activeTimers) {
          clearTimeout(timer);
        }
      }
    },
  );

  it("POSIX maxBuffer 后迟到 child error 不会覆盖 overflow 且 late close 只清理一次", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    const commandError = Object.assign(new Error("late child error"), {
      code: "EIO",
    });
    const secondaryError = Object.assign(
      new Error("second late child error"),
      {
        code: "EPIPE",
      },
    );
    let secondaryEmitError: unknown;
    const childTarget = Object.assign(new EventEmitter(), {
      pid: 6567,
      kill() {
        return true;
      },
    });
    let closeListener:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    let disposeCount = 0;
    const child = new Proxy(childTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "symbol" &&
          property.description === "managedProcessDispose"
        ) {
          return () => {
            disposeCount += 1;
            if (closeListener) {
              target.off("close", closeListener);
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let groupAlive = true;
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: (pid: number, signal: string | number = 0) => {
        if (signal === 0) {
          if (!groupAlive) {
            throw Object.assign(new Error("missing"), {
              code: "ESRCH",
            });
          }
          return true;
        }
        if (pid === -6567 && signal === "SIGKILL") {
          groupAlive = false;
        }
        return true;
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const originalSettleChild = lifecycle.settleChild;
    let settleCount = 0;
    lifecycle.settleChild = async (target) => {
      settleCount += 1;
      await originalSettleChild(target);
    };
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        closeListener = () => callback(overflowError, "", "");
        child.once("close", closeListener);
        queueMicrotask(() => {
          options.onMaxBuffer?.(child, overflowError);
          queueMicrotask(() => {
            child.emit("error", commandError);
            try {
              child.emit("error", secondaryError);
            } catch (error) {
              secondaryEmitError = error;
            }
            child.emit("close", null, "SIGKILL");
          });
        });
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });
    let terminalCount = 0;

    try {
      const caught = await running.then(
        () => {
          terminalCount += 1;
          return undefined;
        },
        (error) => {
          terminalCount += 1;
          return error;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(caught).toBe(overflowError);
      expect(caught).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        commandError,
        killed: true,
        signal: null,
      });
      expect(secondaryEmitError).toBeUndefined();
      expect(terminalCount).toBe(1);
      expect(settleCount).toBe(1);
      expect(disposeCount).toBe(1);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(lifecycle.signal).toBeNull();
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX maxBuffer 后迟到 callback error 作为详情且 close 后 child error 不会二次结算", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    const commandError = Object.assign(
      new Error("late callback error"),
      {
        code: "EPIPE",
      },
    );
    const lateChildError = Object.assign(
      new Error("child error after close"),
      {
        code: "EIO",
      },
    );
    const childTarget = Object.assign(new EventEmitter(), {
      pid: 6568,
      kill() {
        return true;
      },
    });
    const externalErrors: Error[] = [];
    const onExternalError = (error: Error) => {
      externalErrors.push(error);
    };
    childTarget.on("error", onExternalError);
    let closeListener:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    let disposeCount = 0;
    const child = new Proxy(childTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "symbol" &&
          property.description === "managedProcessDispose"
        ) {
          return () => {
            disposeCount += 1;
            if (closeListener) {
              target.off("close", closeListener);
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let groupAlive = true;
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: (pid: number, signal: string | number = 0) => {
        if (signal === 0) {
          if (!groupAlive) {
            throw Object.assign(new Error("missing"), {
              code: "ESRCH",
            });
          }
          return true;
        }
        if (pid === -6568 && signal === "SIGKILL") {
          groupAlive = false;
        }
        return true;
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const originalSettleChild = lifecycle.settleChild;
    let settleCount = 0;
    lifecycle.settleChild = async (target) => {
      settleCount += 1;
      await originalSettleChild(target);
    };
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        closeListener = () => callback(commandError, "", "");
        child.once("close", closeListener);
        queueMicrotask(() => {
          options.onMaxBuffer?.(child, overflowError);
          queueMicrotask(() => {
            child.emit("close", null, "SIGKILL");
            child.emit("error", lateChildError);
          });
        });
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });
    let terminalCount = 0;

    try {
      const caught = await running.then(
        () => {
          terminalCount += 1;
          return undefined;
        },
        (error) => {
          terminalCount += 1;
          return error;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(caught).toBe(overflowError);
      expect(caught).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        commandError,
        killed: true,
        signal: null,
      });
      expect(externalErrors).toEqual([lateChildError]);
      expect(terminalCount).toBe(1);
      expect(settleCount).toBe(1);
      expect(disposeCount).toBe(1);
      expect(child.listenerCount("error")).toBe(1);
      expect(child.listenerCount("close")).toBe(0);
      expect(lifecycle.signal).toBeNull();
    } finally {
      childTarget.off("error", onExternalError);
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX 非 maxBuffer child error 仍原样返回并清理 late close", async () => {
    const commandError = Object.assign(new Error("ordinary child error"), {
      code: "EIO",
    });
    const childTarget = Object.assign(new EventEmitter(), {
      pid: 6569,
      kill() {
        return true;
      },
    });
    let closeListener:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    let disposeCount = 0;
    const child = new Proxy(childTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "symbol" &&
          property.description === "managedProcessDispose"
        ) {
          return () => {
            disposeCount += 1;
            if (closeListener) {
              target.off("close", closeListener);
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let groupAlive = true;
    const lifecycle = createProcessSignalLifecycle({
      killProcess: (_pid: number, signal: string | number = 0) => {
        if (signal === 0 && !groupAlive) {
          throw Object.assign(new Error("missing"), {
            code: "ESRCH",
          });
        }
        if (signal === "SIGKILL") {
          groupAlive = false;
        }
        return true;
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const originalSettleChild = lifecycle.settleChild;
    let settleCount = 0;
    lifecycle.settleChild = async (target) => {
      settleCount += 1;
      await originalSettleChild(target);
    };
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        closeListener = () => callback(null, "", "");
        child.once("close", closeListener);
        queueMicrotask(() => {
          child.emit("error", commandError);
          child.emit("close", null, null);
        });
        return child;
      }) as never,
      signalLifecycle: lifecycle,
    });

    try {
      const caught = await running.catch((error) => error);
      await new Promise((resolve) => setImmediate(resolve));

      expect(caught).toBe(commandError);
      expect(Reflect.has(caught, "commandError")).toBe(false);
      expect(Reflect.has(caught, "terminationError")).toBe(false);
      expect(settleCount).toBe(1);
      expect(disposeCount).toBe(1);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX maxBuffer 的 direct kill 同步 error 仍保留 overflow、command 与 termination 三层错误", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    const commandError = Object.assign(
      new Error("direct kill child error"),
      {
        code: "EIO",
      },
    );
    const childTarget = Object.assign(new EventEmitter(), {
      pid: 6570,
      kill() {
        childTarget.emit("error", commandError);
        return false;
      },
    });
    let closeListener:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    let disposeCount = 0;
    const child = new Proxy(childTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "symbol" &&
          property.description === "managedProcessDispose"
        ) {
          return () => {
            disposeCount += 1;
            if (closeListener) {
              target.off("close", closeListener);
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const originalSettleChild = lifecycle.settleChild;
    let settleCount = 0;
    lifecycle.settleChild = async (target) => {
      settleCount += 1;
      await originalSettleChild(target);
    };
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        closeListener = () => callback(overflowError, "", "");
        child.once("close", closeListener);
        queueMicrotask(() =>
          options.onMaxBuffer?.(child, overflowError),
        );
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });

    try {
      const caught = await running.catch((error) => error);
      child.emit("close", null, "SIGKILL");
      await new Promise((resolve) => setImmediate(resolve));

      expect(caught).toBe(overflowError);
      expect(caught).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        commandError,
        killed: true,
        signal: null,
        terminationError: {
          code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
        },
      });
      expect(settleCount).toBe(0);
      expect(disposeCount).toBe(1);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(lifecycle.signal).toBeNull();
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("POSIX maxBuffer 的 direct kill 同步 close 后仍从已捕获 watchdog 读取 terminationError", async () => {
    const overflowError = Object.assign(
      new Error("stdout maxBuffer length exceeded (1024)"),
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      },
    );
    let closeEmitted = false;
    const childTarget = Object.assign(new EventEmitter(), {
      pid: 6572,
      kill() {
        if (!closeEmitted) {
          closeEmitted = true;
          childTarget.emit("close", null, "SIGKILL");
        }
        return false;
      },
    });
    let closeListener:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    let disposeCount = 0;
    const child = new Proxy(childTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "symbol" &&
          property.description === "managedProcessDispose"
        ) {
          return () => {
            disposeCount += 1;
            if (closeListener) {
              target.off("close", closeListener);
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 10,
      killProcess: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EPERM",
        });
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const originalSettleChild = lifecycle.settleChild;
    let settleCount = 0;
    lifecycle.settleChild = async (target) => {
      settleCount += 1;
      await originalSettleChild(target);
    };
    const running = runManagedExecFile("fake-command", [], {
      execFileProcess: ((
        _command: string,
        _args: string[],
        options: {
          onMaxBuffer?: (target: typeof child, error: Error) => void;
        },
        callback: (
          error: Error,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        closeListener = () => callback(overflowError, "", "");
        child.once("close", closeListener);
        queueMicrotask(() =>
          options.onMaxBuffer?.(child, overflowError),
        );
        return child;
      }) as never,
      maxBuffer: 1_024,
      signalLifecycle: lifecycle,
    });

    try {
      const caught = await running.catch((error) => error);

      expect(caught).toBe(overflowError);
      expect(caught).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
        terminationError: {
          code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
        },
      });
      expect(Reflect.has(caught, "commandError")).toBe(false);
      expect(settleCount).toBe(1);
      expect(disposeCount).toBe(1);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(lifecycle.signal).toBeNull();
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it.each(["spawn", "exec"] as const)(
    "%s runner 在 child error 无有效 PID 且永不 close 时有界保留主错误",
    async (runner) => {
      const commandError = Object.assign(
        new Error(`${runner} abort before spawn`),
        {
          code: "ABORT_ERR",
          name: "AbortError",
          signal: null,
        },
      );
      const childTarget = Object.assign(new EventEmitter(), {
        pid: undefined,
        kill() {
          return false;
        },
      });
      let disposeCount = 0;
      const child = new Proxy(childTarget, {
        get(target, property, receiver) {
          if (
            typeof property === "symbol" &&
            property.description === "managedProcessDispose"
          ) {
            return () => {
              disposeCount += 1;
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const lifecycle = createProcessSignalLifecycle({
        forceKillTimeoutMs: 10,
        platform: "linux",
        treeExitTimeoutMs: 10,
      });
      const originalSettleChild = lifecycle.settleChild;
      let settleCount = 0;
      lifecycle.settleChild = async (target) => {
        settleCount += 1;
        await originalSettleChild(target);
      };
      let completeCommand:
        | ((error: Error, stdout: string, stderr: string) => void)
        | undefined;
      const running =
        runner === "spawn"
          ? runManagedSpawn("fake-command", [], {
              signalLifecycle: lifecycle,
              spawnProcess: (() => {
                queueMicrotask(() =>
                  child.emit("error", commandError),
                );
                return child as unknown as ReturnType<typeof spawn>;
              }) as unknown as typeof spawn,
            })
          : runManagedExecFile("fake-command", [], {
              execFileProcess: ((
                _command: string,
                _args: string[],
                _options: unknown,
                callback: (
                  error: Error,
                  stdout: string,
                  stderr: string,
                ) => void,
              ) => {
                completeCommand = callback;
                queueMicrotask(() =>
                  child.emit("error", commandError),
                );
                return child;
              }) as never,
              signalLifecycle: lifecycle,
            });

      try {
        const raced = await Promise.race([
          running.then(
            () => ({ error: undefined, timedOut: false }),
            (error) => ({ error, timedOut: false }),
          ),
          new Promise<{ timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true }), 300),
          ),
        ]);

        expect(raced.timedOut).toBe(false);
        if (!raced.timedOut) {
          expect(raced.error).toBe(commandError);
          expect(raced.error).toMatchObject({
            code: "ABORT_ERR",
            name: "AbortError",
            signal: null,
            terminationError: {
              code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            },
          });
        }
        child.emit("close", null, "SIGKILL");
        completeCommand?.(commandError, "", "");
        await new Promise((resolve) => setImmediate(resolve));
        expect(settleCount).toBe(0);
        expect(disposeCount).toBe(runner === "exec" ? 1 : 0);
        expect(child.listenerCount("error")).toBe(0);
        expect(child.listenerCount("close")).toBe(0);
        expect(lifecycle.signal).toBeNull();
      } finally {
        lifecycle.detachChild(child);
        lifecycle.remove();
      }
    },
  );

  it("真实 ENOENT spawn 会等待 close 并只保留原始命令错误", async () => {
    const missingCommand = path.join(
      tmpdir(),
      `digitalmate-missing-command-${process.pid}-${Date.now()}`,
    );
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 20,
      platform: "linux",
      treeExitTimeoutMs: 20,
    });

    try {
      const caught = await runManagedSpawn(missingCommand, [], {
        signalLifecycle: lifecycle,
        stdio: "ignore",
      }).catch((error) => error);

      expect(caught).toMatchObject({
        code: "ENOENT",
      });
      expect(Reflect.has(caught, "terminationError")).toBe(false);
      expect(
        lifecycle.diagnostics.some(
          (diagnostic) => diagnostic.action === "runner-timeout",
        ),
      ).toBe(false);
      expect(lifecycle.signal).toBeNull();
    } finally {
      lifecycle.remove();
    }
  });

  it.each(["spawn", "exec"] as const)(
    "%s runner 的 child error 遇到 settle failure 时保留原错误并附 terminationError",
    async (runner) => {
      const commandError = Object.assign(
        new Error(`${runner} child error`),
        {
          code: "EIO",
        },
      );
      const terminationError = Object.assign(
        new Error(`${runner} settle failed`),
        {
          code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
        },
      );
      const child = Object.assign(new EventEmitter(), {
        pid: 6571,
        kill() {
          return true;
        },
      });
      let settleCount = 0;
      let detachCount = 0;
      const lifecycle = {
        signal: null,
        detachedCommands: true,
        attachChild() {},
        detachChild() {
          detachCount += 1;
        },
        forceTerminateChild() {
          return Promise.resolve();
        },
        async settleChild() {
          settleCount += 1;
          throw terminationError;
        },
        watchChildTermination() {
          return () => {};
        },
      };
      const running =
        runner === "spawn"
          ? runManagedSpawn("fake-command", [], {
              signalLifecycle: lifecycle as never,
              spawnProcess: (() => {
                queueMicrotask(() => {
                  child.emit("error", commandError);
                  child.emit("close", null, "SIGKILL");
                });
                return child as unknown as ReturnType<typeof spawn>;
              }) as unknown as typeof spawn,
            })
          : runManagedExecFile("fake-command", [], {
              execFileProcess: ((
                _command: string,
                _args: string[],
                _options: unknown,
                callback: (
                  error: Error,
                  stdout: string,
                  stderr: string,
                ) => void,
              ) => {
                queueMicrotask(() => {
                  child.emit("error", commandError);
                  callback(commandError, "", "");
                });
                return child;
              }) as never,
              signalLifecycle: lifecycle as never,
            });

      const caught = await running.catch((error) => error);

      expect(caught).toBe(commandError);
      expect(caught).toMatchObject({
        code: "EIO",
        terminationError,
      });
      expect(settleCount).toBe(1);
      expect(detachCount).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    },
  );

  it("真实 POSIX AbortError 会等忽略 SIGTERM 的 child 被有界终止后再拒绝", async () => {
    if (process.platform === "win32") {
      return;
    }

    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-spawn-abort-"),
    );
    const pidPath = path.join(temporaryRoot, "fixture.pid");
    const identityToken = path.basename(temporaryRoot);
    const controller = new AbortController();
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 50,
      treeExitTimeoutMs: 2_000,
    });
    let leaderPid = 0;

    try {
      const running = runManagedSpawn(
        process.execPath,
        [
          "-e",
          `
const fs = require("node:fs");
const identityToken = ${JSON.stringify(identityToken)};
process.on("SIGTERM", () => {});
fs.writeFileSync(
  ${JSON.stringify(pidPath)},
  JSON.stringify({
    identityToken,
    leaderPid: process.pid,
    descendantPids: [],
  }),
);
setInterval(() => identityToken.length, 1000);
`,
        ],
        {
          signal: controller.signal,
          signalLifecycle: lifecycle,
          stdio: "ignore",
        },
      );
      const readyDeadline = Date.now() + 5_000;
      while (Date.now() < readyDeadline) {
        try {
          const record = parseRecordedProcessTree(
            await readFile(pidPath, "utf8"),
          );
          leaderPid = record?.leaderPid ?? 0;
          if (leaderPid > 0) {
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(leaderPid).toBeGreaterThan(0);

      controller.abort();
      const caught = await running.catch((error) => error);

      expect(caught).toMatchObject({
        code: "ABORT_ERR",
        name: "AbortError",
      });
      expect(lifecycle.signal).toBeNull();
      expect(
        await waitForProcessTargetsToExit(leaderPid, [], 2_000),
      ).toBe(true);
      expect(processTargetExists(leaderPid, true)).toBe(false);
      await expect(processPidIsActive(leaderPid)).resolves.toBe(false);
    } finally {
      await forceCleanupRecordedProcessTree(pidPath);
      lifecycle.remove();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("POSIX runner 正常 graceful close 且 PGID 消失时保持首信号结果", async () => {
    let groupAlive = true;
    const child = Object.assign(new EventEmitter(), {
      pid: 6666,
      kill() {
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 50,
      killProcess: (pid: number, signal: string | number = 0) => {
        if (signal === 0) {
          if (!groupAlive) {
            throw Object.assign(new Error("missing"), {
              code: "ESRCH",
            });
          }
          return true;
        }
        if (pid === -6666 && signal === "SIGTERM") {
          groupAlive = false;
          queueMicrotask(() =>
            child.emit("close", null, "SIGTERM"),
          );
        }
        return true;
      },
      platform: "linux",
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toEqual({
        exitCode: 1,
        signal: "SIGTERM",
      });
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows 进程树终止命令始终含 /T，强杀阶段额外含 /F", () => {
    expect(getWindowsTreeKillCommand(1234)).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T"],
    });
    expect(
      getWindowsTreeKillCommand(1234, { force: true }),
    ).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T", "/F"],
    });
  });

  it("Windows taskkill graceful 与 force 异步非零退出均记录且不阻断后续强杀", async () => {
    const commands: string[][] = [];
    const reportedDiagnostics: string[] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      onDiagnostic: (diagnostic) => {
        reportedDiagnostics.push(
          formatSignalLifecycleDiagnostic(diagnostic),
        );
      },
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const killer = new EventEmitter();
        commands.push([command, ...args]);
        queueMicrotask(() => {
          killer.emit("close", args.includes("/F") ? 9 : 5, null);
        });
        return killer as unknown as ReturnType<typeof spawn>;
      },
    });
    const child = { pid: 7373 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      process.emit("SIGINT", "SIGINT");
      await new Promise((resolve) => setImmediate(resolve));

      expect(commands).toEqual([
        ["taskkill", "/PID", "7373", "/T"],
        ["taskkill", "/PID", "7373", "/T", "/F"],
      ]);
      expect(lifecycle.diagnostics).toEqual([
        expect.objectContaining({
          action: "graceful",
          command: "taskkill /PID 7373 /T",
          exitCode: 5,
          pid: 7373,
          signal: null,
        }),
        expect.objectContaining({
          action: "force",
          command: "taskkill /PID 7373 /T /F",
          exitCode: 9,
          pid: 7373,
          signal: null,
        }),
      ]);
      expect(reportedDiagnostics).toEqual([
        "Console process cleanup graceful failed for taskkill /PID 7373 /T: exit code 5",
        "Console process cleanup force failed for taskkill /PID 7373 /T /F: exit code 9",
      ]);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows graceful taskkill 成功后 settle 不重复强杀也不产生虚假诊断", async () => {
    const commands: string[][] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const killer = new EventEmitter();
        commands.push([command, ...args]);
        queueMicrotask(() => killer.emit("close", 0, null));
        return killer as unknown as ReturnType<typeof spawn>;
      },
    });
    const child = { pid: 7474 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      await lifecycle.settleChild(child);

      expect(commands).toEqual([
        ["taskkill", "/PID", "7474", "/T"],
      ]);
      expect(lifecycle.diagnostics).toEqual([]);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows taskkill error/close 竞态只结算并报告一次", async () => {
    const reportedDiagnostics: string[] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      onDiagnostic: (diagnostic) => {
        reportedDiagnostics.push(
          formatSignalLifecycleDiagnostic(diagnostic),
        );
      },
      platform: "win32",
      spawnProcess: () => {
        const killer = new EventEmitter();
        queueMicrotask(() => {
          killer.emit("error", new Error("taskkill spawn failed"));
          killer.emit("close", 5, null);
        });
        return killer as unknown as ReturnType<typeof spawn>;
      },
    });
    const child = { pid: 7575 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));

      expect(lifecycle.diagnostics).toHaveLength(1);
      expect(reportedDiagnostics).toEqual([
        "Console process cleanup graceful failed for taskkill /PID 7575 /T: taskkill spawn failed",
      ]);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows graceful 与 force taskkill helper 均挂起时会终止并有界回收各 helper", async () => {
    const commands: string[][] = [];
    const helpers: Array<
      EventEmitter & {
        kill: (signal?: NodeJS.Signals) => boolean;
      }
    > = [];
    const helperKillCalls: Array<{
      index: number;
      signal: NodeJS.Signals | undefined;
    }> = [];
    const reportedDiagnostics: string[] = [];
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      onDiagnostic: (diagnostic) => {
        reportedDiagnostics.push(
          formatSignalLifecycleDiagnostic(diagnostic),
        );
      },
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const index = helpers.length;
        const killer = Object.assign(new EventEmitter(), {
          kill: (signal?: NodeJS.Signals) => {
            helperKillCalls.push({ index, signal });
            return true;
          },
        });
        commands.push([command, ...args]);
        helpers.push(killer);
        return killer as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const child = { pid: 7676 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      const startedAt = Date.now();
      await lifecycle.settleChild(child);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(500);
      expect(commands).toEqual([
        ["taskkill", "/PID", "7676", "/T"],
        ["taskkill", "/PID", "7676", "/T", "/F"],
      ]);
      expect(helperKillCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 }),
        ]),
      );
      expect(lifecycle.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "graceful-timeout",
            pid: 7676,
          }),
          expect.objectContaining({
            action: "settle-timeout",
            pid: 7676,
          }),
        ]),
      );
      expect(reportedDiagnostics).toEqual(
        expect.arrayContaining([
          "Console process cleanup graceful-timeout failed for process-tree pid=7676: timed out waiting for taskkill",
          "Console process cleanup settle-timeout failed for process-tree pid=7676: timed out waiting for taskkill",
        ]),
      );
      for (const helper of helpers) {
        expect(helper.listenerCount("error")).toBe(0);
        expect(helper.listenerCount("close")).toBe(0);
      }
      const diagnosticCount = lifecycle.diagnostics.length;
      for (const helper of helpers) {
        helper.emit("close", 0, null);
      }
      expect(lifecycle.diagnostics).toHaveLength(diagnosticCount);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows lifecycle 直接 detach 时终止并移除仍在途的 taskkill helper", () => {
    const helper = Object.assign(new EventEmitter(), {
      killCalls: [] as Array<NodeJS.Signals | undefined>,
      kill(signal?: NodeJS.Signals) {
        this.killCalls.push(signal);
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      platform: "win32",
      spawnProcess: () =>
        helper as unknown as ReturnType<typeof spawn>,
    });
    const child = { pid: 7777 };

    lifecycle.install();
    try {
      lifecycle.attachChild(child);
      process.emit("SIGTERM", "SIGTERM");
      expect(helper.listenerCount("error")).toBe(1);
      expect(helper.listenerCount("close")).toBe(1);

      lifecycle.detachChild(child);

      expect(helper.killCalls).toEqual(
        expect.arrayContaining(["SIGKILL"]),
      );
      expect(helper.listenerCount("error")).toBe(0);
      expect(helper.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows runner 在 graceful 与 force taskkill 成功但 child 未关闭时继续 direct kill 并保留首信号", async () => {
    const taskkillCommands: string[][] = [];
    const childKillCalls: NodeJS.Signals[] = [];
    const listenerSnapshots: Array<{
      close: number;
      error: number;
    }> = [];
    const helpers: EventEmitter[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 9191,
      kill(signal: NodeJS.Signals) {
        childKillCalls.push(signal);
        listenerSnapshots.push({
          close: child.listenerCount("close"),
          error: child.listenerCount("error"),
        });
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const helper = new EventEmitter();
        taskkillCommands.push([command, ...args]);
        helpers.push(helper);
        queueMicrotask(() => helper.emit("close", 0, null));
        return helper as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });
    let timedOut = false;

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(raced).toEqual({
        outcome: { exitCode: 1, signal: "SIGTERM" },
        timedOut: false,
      });
      expect(taskkillCommands).toEqual([
        ["taskkill", "/PID", "9191", "/T"],
        ["taskkill", "/PID", "9191", "/T", "/F"],
      ]);
      expect(childKillCalls).toEqual(["SIGKILL"]);
      expect(listenerSnapshots).toEqual([{ close: 1, error: 1 }]);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      for (const helper of helpers) {
        expect(helper.listenerCount("error")).toBe(0);
        expect(helper.listenerCount("close")).toBe(0);
      }
    } finally {
      if (timedOut) {
        child.emit("close", null, "SIGKILL");
        await running.catch(() => {});
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows runner 在 graceful taskkill 成功且 child 随后关闭时不误升级 force", async () => {
    const taskkillCommands: string[][] = [];
    const childKillCalls: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 9242,
      kill(signal: NodeJS.Signals) {
        childKillCalls.push(signal);
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const helper = new EventEmitter();
        taskkillCommands.push([command, ...args]);
        queueMicrotask(() => {
          helper.emit("close", 0, null);
          queueMicrotask(() =>
            child.emit("close", null, "SIGTERM"),
          );
        });
        return helper as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toEqual({
        exitCode: 1,
        signal: "SIGTERM",
      });
      expect(taskkillCommands).toEqual([
        ["taskkill", "/PID", "9242", "/T"],
      ]);
      expect(childKillCalls).toEqual([]);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows runner 在 direct kill 被接受但 child 仍未关闭时才显式失败并安全 detach", async () => {
    const taskkillCommands: string[][] = [];
    const childKillCalls: NodeJS.Signals[] = [];
    const listenerSnapshots: Array<{
      close: number;
      error: number;
    }> = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 9292,
      kill(signal: NodeJS.Signals) {
        childKillCalls.push(signal);
        listenerSnapshots.push({
          close: child.listenerCount("close"),
          error: child.listenerCount("error"),
        });
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 60_000,
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const helper = new EventEmitter();
        taskkillCommands.push([command, ...args]);
        queueMicrotask(() => helper.emit("close", 0, null));
        return helper as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });
    let timedOut = false;

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(timedOut).toBe(false);
      if (!raced.timedOut) {
        expect(raced).toMatchObject({
          error: {
            code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            signal: "SIGTERM",
          },
        });
      }
      expect(taskkillCommands).toEqual([
        ["taskkill", "/PID", "9292", "/T"],
        ["taskkill", "/PID", "9292", "/T", "/F"],
      ]);
      expect(childKillCalls).toEqual(["SIGKILL"]);
      expect(listenerSnapshots).toEqual([{ close: 1, error: 1 }]);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      const diagnosticCount = lifecycle.diagnostics.length;
      child.emit("close", null, "SIGKILL");
      expect(lifecycle.diagnostics).toHaveLength(diagnosticCount);
    } finally {
      if (timedOut) {
        child.emit("close", null, "SIGKILL");
        await running.catch(() => {});
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows runner 在 child 与 taskkill helpers 都不退出时独立 watchdog 回落 direct kill", async () => {
    const taskkillCommands: string[][] = [];
    const helperKillCalls: Array<{
      index: number;
      signal: NodeJS.Signals | undefined;
    }> = [];
    const helpers: EventEmitter[] = [];
    const childKillCalls: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 7878,
      kill(signal: NodeJS.Signals) {
        childKillCalls.push(signal);
        if (signal === "SIGKILL") {
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        }
        return true;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 20,
      platform: "win32",
      spawnProcess: (command: string, args: readonly string[]) => {
        const index = taskkillCommands.length;
        const helper = Object.assign(new EventEmitter(), {
          kill(signal?: NodeJS.Signals) {
            helperKillCalls.push({ index, signal });
            return true;
          },
        });
        taskkillCommands.push([command, ...args]);
        helpers.push(helper);
        return helper as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then((outcome) => ({ outcome, timedOut: false })),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);

      expect(raced).toEqual({
        outcome: { exitCode: 1, signal: "SIGTERM" },
        timedOut: false,
      });
      expect(taskkillCommands).toEqual([
        ["taskkill", "/PID", "7878", "/T"],
        ["taskkill", "/PID", "7878", "/T", "/F"],
      ]);
      expect(helperKillCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 }),
        ]),
      );
      expect(childKillCalls).toContain("SIGKILL");
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      for (const helper of helpers) {
        expect(helper.listenerCount("error")).toBe(0);
        expect(helper.listenerCount("close")).toBe(0);
      }
    } finally {
      if (childKillCalls.length === 0) {
        child.emit("close", null, "SIGKILL");
        await running;
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows runner 在 taskkill 与 direct kill 均失败时有界返回显式终止错误", async () => {
    const childKillCalls: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 7979,
      kill(signal: NodeJS.Signals) {
        childKillCalls.push(signal);
        return false;
      },
    });
    const lifecycle = createProcessSignalLifecycle({
      forceKillTimeoutMs: 20,
      platform: "win32",
      spawnProcess: () =>
        Object.assign(new EventEmitter(), {
          kill() {
            return true;
          },
        }) as unknown as ReturnType<typeof spawn>,
      treeExitTimeoutMs: 10,
    });
    const running = runManagedSpawn("fake-command", [], {
      signalLifecycle: lifecycle,
      spawnProcess: (() =>
        child as unknown as ReturnType<
          typeof spawn
        >) as unknown as typeof spawn,
    });
    let timedOut = false;

    lifecycle.install();
    try {
      process.emit("SIGTERM", "SIGTERM");
      const raced = await Promise.race([
        running.then(
          (outcome) => ({ outcome, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;

      expect(timedOut).toBe(false);
      if (!raced.timedOut) {
        expect(raced).toMatchObject({
          error: {
            code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            signal: "SIGTERM",
          },
        });
      }
      expect(childKillCalls).toContain("SIGKILL");
      expect(lifecycle.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "direct-child-fallback",
            pid: 7979,
          }),
          expect.objectContaining({
            action: "runner-timeout",
            pid: 7979,
          }),
        ]),
      );
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      const diagnosticCount = lifecycle.diagnostics.length;
      child.emit("close", null, "SIGKILL");
      expect(lifecycle.diagnostics).toHaveLength(diagnosticCount);
    } finally {
      if (timedOut) {
        child.emit("close", null, "SIGKILL");
        await running;
      }
      lifecycle.detachChild(child);
      lifecycle.remove();
    }
  });

  it("Windows maxBuffer 内部取消在 taskkill helper 挂起时仍有界拒绝且不伪造信号", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-win-max-buffer-watchdog-"),
    );
    const readyPath = path.join(temporaryRoot, "ready");
    const stopPath = path.join(temporaryRoot, "stop");
    const helperKillCalls: NodeJS.Signals[] = [];
    const helpers: EventEmitter[] = [];
    const lifecycle = createProcessSignalLifecycle({
      platform: "win32",
      spawnProcess: () => {
        const helper = Object.assign(new EventEmitter(), {
          kill(signal: NodeJS.Signals) {
            helperKillCalls.push(signal);
            return true;
          },
        });
        helpers.push(helper);
        return helper as unknown as ReturnType<typeof spawn>;
      },
      treeExitTimeoutMs: 10,
    });
    const running = runManagedExecFile(
      process.execPath,
      [
        "-e",
        `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
const payload = Buffer.alloc(64 * 1024, "x");
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(stopPath)})) {
    process.exit(0);
  }
  process.stdout.write(payload);
}, 1);
`,
      ],
      {
        maxBuffer: 1_024,
        signalLifecycle: lifecycle,
      },
    );
    let caughtError: unknown;
    let timedOut = false;

    try {
      const readyDeadline = Date.now() + 3_000;
      while (Date.now() < readyDeadline) {
        try {
          await access(readyPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      await access(readyPath);
      const raced = await Promise.race([
        running.then(
          () => ({ error: undefined, timedOut: false }),
          (error) => ({ error, timedOut: false }),
        ),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 300),
        ),
      ]);
      timedOut = raced.timedOut;
      if (!raced.timedOut) {
        caughtError = raced.error;
      }

      expect(timedOut).toBe(false);
      expect(caughtError).toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: null,
      });
      expect(lifecycle.signal).toBeNull();
      expect(helperKillCalls).toEqual(
        expect.arrayContaining(["SIGTERM", "SIGKILL"]),
      );
      for (const helper of helpers) {
        expect(helper.listenerCount("error")).toBe(0);
        expect(helper.listenerCount("close")).toBe(0);
      }
    } finally {
      if (timedOut) {
        await writeFile(stopPath, "stop", "utf8");
        await running.catch(() => {});
      }
      lifecycle.remove();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it("prepare 返回前收到信号时不启动命令、校验或发布并等待清理", async () => {
    const fixture = await createConsoleBuildFixture();
    const calls: string[] = [];
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    try {
      const outcome = await buildConsole({
        prepare: async () => {
          process.emit("SIGTERM", "SIGTERM");
          return {
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          };
        },
        runCommand: async () => {
          calls.push("command");
          return { exitCode: 0, signal: null };
        },
        validateBuild: async () => {
          calls.push("validate");
          return {
            indexPath: "",
            logoPath: "",
            resourceUrls: [],
          };
        },
        publishBuild: async () => {
          calls.push("publish");
          return { publishRoot: fixture.publishRoot };
        },
        publicRoot: fixture.publicRoot,
      });

      expect(outcome).toEqual({
        publishRoot: null,
        signal: "SIGTERM",
      });
      expect(calls).toEqual([]);
      await expectPathMissing(fixture.preparedRoot);
      expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
      expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { phase: "prepare", signal: "SIGINT", expectedCommands: 0 },
    { phase: "publish", signal: "SIGTERM", expectedCommands: 2 },
    { phase: "cleanup", signal: "SIGINT", expectedCommands: 2 },
  ] as const)(
    "$phase 阶段收到真实 $signal 后完成安全收尾并按原信号退出",
    async ({ phase, signal, expectedCommands }) => {
      const result = await runRealConsoleBuildSignalTest(phase, signal);

      try {
        expect(result).toMatchObject({
          exitCode: null,
          signal,
          stderr: "",
        });
        expect(result.outcome).toEqual({
          commandCount: expectedCommands,
          error: null,
          listenerCounts: { sigint: 0, sigterm: 0 },
          result: {
            publishRoot:
              phase === "prepare" ? null : result.publishRoot,
            signal,
          },
        });
        await expectPathMissing(result.preparedRoot);
        expect(
          await listConsolePublicationResidue(result.publicRoot),
        ).toEqual([]);
        if (phase === "prepare") {
          await expect(
            readFile(path.join(result.publishRoot, "old.txt"), "utf8"),
          ).resolves.toBe("old console\n");
          await expectPathMissing(
            path.join(
              result.publishRoot,
              "assets",
              "app-abc12345.js",
            ),
          );
        } else {
          await expectPathMissing(path.join(result.publishRoot, "old.txt"));
          await expect(
            readFile(
              path.join(
                result.publishRoot,
                "assets",
                "app-abc12345.js",
              ),
              "utf8",
            ),
          ).resolves.toContain("new console");
        }
      } finally {
        await rm(result.temporaryRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("真实 CLI helper 失败清理会按记录 PID 强杀 detached 进程组", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-helper-cleanup-"),
    );
    const pidPath = path.join(temporaryRoot, "fixture.pid");
    const identityToken = path.basename(temporaryRoot);
    let leaderPid = 0;
    let grandchildPid = 0;

    try {
      const leader = spawn(
        process.execPath,
        [
          "-e",
          `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(
  process.execPath,
  [
    "-e",
    ${JSON.stringify(
      `const identityToken = ${JSON.stringify(
        identityToken,
      )}; setInterval(() => identityToken.length, 1000);`,
    )},
  ],
  { stdio: "ignore" },
);
fs.writeFileSync(
  ${JSON.stringify(pidPath)},
  JSON.stringify({
    identityToken: ${JSON.stringify(identityToken)},
    leaderPid: process.pid,
    descendantPids: [grandchild.pid],
  }),
);
setInterval(() => {}, 1000);
`,
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      leaderPid = leader.pid ?? 0;

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const record = parseRecordedProcessTree(
            await readFile(pidPath, "utf8"),
          );
          grandchildPid = record?.descendantPids[0] ?? 0;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(grandchildPid).toBeGreaterThan(0);

      await forceCleanupRecordedProcessTree(pidPath);

      expect(processTargetExists(leaderPid, true)).toBe(false);
      await expect(processPidIsActive(leaderPid)).resolves.toBe(false);
      await expect(
        processPidIsActive(grandchildPid),
      ).resolves.toBe(false);
      await expectPathMissing(pidPath);
    } finally {
      await forceCleanupRecordedProcessTree(pidPath);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("CLI helper 遇到 PID/PGID 复用或组内身份不一致时不发送任何信号", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-helper-identity-mismatch-"),
    );
    const pidPath = path.join(temporaryRoot, "fixture.pid");
    const identityToken = "dm-fixture-token-mismatch";
    const killCalls: Array<{
      pid: number;
      signal: string | number;
    }> = [];

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          identityToken,
          leaderPid: 7101,
          descendantPids: [7102],
        }),
        "utf8",
      );

      await expect(
        forceCleanupRecordedProcessTree(pidPath, {
          killProcess: (pid, signal = 0) => {
            killCalls.push({ pid, signal });
            return true;
          },
          readProcessTable: async () => [
            {
              pid: 7101,
              pgid: 7101,
              command: `${process.execPath} fixture ${identityToken}`,
            },
            {
              pid: 7102,
              pgid: 7101,
              command: `${process.execPath} child ${identityToken}`,
            },
            {
              pid: 7199,
              pgid: 7101,
              command: `${process.execPath} unrelated-reused-process`,
            },
          ],
          waitForExit: async () => true,
        }),
      ).rejects.toThrow("identity mismatch");

      expect(killCalls).toEqual([]);
      await expect(readFile(pidPath, "utf8")).resolves.toContain(
        identityToken,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CLI helper 仅在整个记录进程组身份匹配后组杀并删除 PID 记录", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "dm-qwenpaw-helper-identity-match-"),
    );
    const pidPath = path.join(temporaryRoot, "fixture.pid");
    const identityToken = "dm-fixture-token-match";
    const killCalls: Array<{
      pid: number;
      signal: string | number;
    }> = [];

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          identityToken,
          leaderPid: 7201,
          descendantPids: [7202],
        }),
        "utf8",
      );

      await expect(
        forceCleanupRecordedProcessTree(pidPath, {
          killProcess: (pid, signal = 0) => {
            killCalls.push({ pid, signal });
            return true;
          },
          readProcessTable: async () => [
            {
              pid: 7201,
              pgid: 7201,
              command: `${process.execPath} fixture ${identityToken}`,
            },
            {
              pid: 7202,
              pgid: 7201,
              command: `${process.execPath} child ${identityToken}`,
            },
          ],
          waitForExit: async () => true,
        }),
      ).resolves.toEqual({
        descendantPids: [7202],
        identityMatched: true,
        leaderPid: 7201,
      });

      expect(killCalls).toEqual([
        { pid: -7201, signal: "SIGKILL" },
      ]);
      await expectPathMissing(pidPath);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("真实 CLI 向 npm 进程组转发 SIGTERM 且不遗留 npm 或 grandchild", async () => {
    const result = await runRealConsoleBuildCliSignalTest();

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
        stderr: "",
      });
      const pidLog = await readFile(
        path.join(result.temporaryRoot, "fake-npm.pid"),
        "utf8",
      );
      expect(pidLog).toContain("\nSIGTERM");
      expect(() => process.kill(result.fakeNpmPid, 0)).toThrow();
      expect(() => process.kill(result.grandchildPid, 0)).toThrow();
      const temporaryEntries = await readdir(result.temporaryRoot);
      expect(
        temporaryEntries.filter((entry) =>
          entry.startsWith("digitalmate-qwenpaw-console-"),
        ),
      ).toEqual([]);
      expect(
        await listConsolePublicationResidue(path.resolve("public")),
      ).toEqual([]);
    } finally {
      await forceCleanupRecordedProcessTree(result.pidPath);
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("direct npm 响应首信号退出后仍会强杀忽略信号的 grandchild", async () => {
    const result = await runRealConsoleBuildCliSignalTest({
      grandchildIgnoresFirstSignal: true,
    });

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
        stderr: "",
      });
      await expect(readFile(result.grandchildLogPath, "utf8")).resolves.toContain(
        "SIGTERM",
      );
      expect(() => process.kill(result.fakeNpmPid, 0)).toThrow();
      expect(() => process.kill(result.grandchildPid, 0)).toThrow();
      expect(
        (await readdir(result.temporaryRoot)).filter((entry) =>
          entry.startsWith("digitalmate-qwenpaw-console-"),
        ),
      ).toEqual([]);
    } finally {
      await forceCleanupRecordedProcessTree(result.pidPath);
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("真实 CLI 第二个信号会强杀忽略首信号的 npm 进程组并保留首信号退出语义", async () => {
    const result = await runRealConsoleBuildCliSignalTest({
      ignoreFirstSignal: true,
      secondSignal: "SIGINT",
    });

    try {
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
        stderr: "",
      });
      const pidLog = await readFile(
        path.join(result.temporaryRoot, "fake-npm.pid"),
        "utf8",
      );
      expect(pidLog).toContain("\nIGNORED:SIGTERM");
      await expect(readFile(result.grandchildLogPath, "utf8")).resolves.toContain(
        "SIGTERM",
      );
      expect(() => process.kill(result.fakeNpmPid, 0)).toThrow();
      expect(() => process.kill(result.grandchildPid, 0)).toThrow();
      expect(
        (await readdir(result.temporaryRoot)).filter((entry) =>
          entry.startsWith("digitalmate-qwenpaw-console-"),
        ),
      ).toEqual([]);
    } finally {
      await forceCleanupRecordedProcessTree(result.pidPath);
      await rm(result.temporaryRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("spawn error 会 detach child、清理 prepared 并移除信号监听器", async () => {
    const fixture = await createConsoleBuildFixture();
    const previousPath = process.env.PATH;
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    process.env.PATH = "";
    try {
      await expect(
        buildConsole({
          prepare: async () => ({
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          }),
          publicRoot: fixture.publicRoot,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expectPathMissing(fixture.preparedRoot);
      expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
      expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("信号、命令主错误与 prepared cleanup 错误同时发生时保留完整优先级", async () => {
    const fixture = await createConsoleBuildFixture();
    const commandError = new Error("injected command exception");
    const cleanupError = new Error("injected prepared cleanup exception");
    let caughtError: unknown;

    try {
      try {
        await buildConsole({
          prepare: async () => ({
            workdir: fixture.preparedRoot,
            applied: [...PATCHES],
          }),
          runCommand: async () => {
            process.emit("SIGTERM", "SIGTERM");
            throw commandError;
          },
          cleanupPrepared: async () => {
            throw cleanupError;
          },
          publicRoot: fixture.publicRoot,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(commandError);
      expect(Reflect.get(caughtError as object, "signal")).toBe("SIGTERM");
      expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
        cleanupError,
      );
      expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
        {
          stage: "prepared",
          path: fixture.preparedRoot,
          error: cleanupError,
        },
      ]);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  it("build 的冻结主错误、首信号与清理错误共存时包装原错且普通链路不抛 TypeError", async () => {
    const originalError = new Error("frozen build command failure");
    Object.defineProperty(originalError, "signal", {
      configurable: false,
      enumerable: true,
      value: "SIGKILL",
    });
    Object.freeze(originalError);
    const cleanupError = new Error("build prepared cleanup failed");
    let caughtError: unknown;

    try {
      await buildConsole({
        prepare: async () => ({
          workdir: "/virtual/frozen-build-console",
          applied: [...PATCHES],
        }),
        runCommand: async () => {
          process.emit("SIGTERM", "SIGTERM");
          throw originalError;
        },
        cleanupPrepared: async () => {
          throw cleanupError;
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(TypeError);
    expect(caughtError).not.toBe(originalError);
    expect(Reflect.get(caughtError as object, "cause")).toBe(
      originalError,
    );
    expect(Reflect.get(caughtError as object, "signal")).toBe("SIGTERM");
    expect(Reflect.get(caughtError as object, "cleanupError")).toBe(
      cleanupError,
    );
    expect(Reflect.get(caughtError as object, "cleanupErrors")).toEqual([
      {
        stage: "prepared",
        path: "/virtual/frozen-build-console",
        error: cleanupError,
      },
    ]);
  });

  it("根脚本、忽略规则、缓存头与镜像归因范围精确", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.scripts["console:build"]).toBe(
      "node scripts/qwenpaw-console/build.mjs",
    );
    expect(packageJson.scripts.build).toBe(
      "npm run console:build && next build",
    );

    const gitignore = await readFile(".gitignore", "utf8");
    expect(gitignore).toMatch(/^public\/_admin-console\/$/m);
    expect(gitignore).toMatch(/^public\/\.admin-console-staging\*\/$/m);
    expect(gitignore).toMatch(/^\.generated\/$/m);
    expect(gitignore).not.toMatch(/^public\/?$/m);
    expect(gitignore).not.toMatch(/^public\/\*$/m);

    const configuredHeaders = await nextConfig.headers?.();
    expect(configuredHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "/home/:path+" }),
        {
          source: "/_admin-console/assets/:path+",
          headers: [
            {
              key: "Cache-Control",
              value: "public, max-age=31536000, immutable",
            },
          ],
        },
        {
          source: "/_admin-console/index.html",
          headers: [{ key: "Cache-Control", value: "no-store" }],
        },
      ]),
    );

    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain(
      "COPY --from=builder /app/public ./public",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/vendor/qwenpaw-console/LICENSE ./third-party/qwenpaw-console/LICENSE",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/vendor/qwenpaw-console/UPSTREAM.md ./third-party/qwenpaw-console/UPSTREAM.md",
    );
    expect(dockerfile).not.toContain(
      "/app/vendor/qwenpaw-console/reference",
    );
    expect(dockerfile).not.toContain("/app/src/qwenpaw");
  });
});
