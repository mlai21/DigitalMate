import { execFile, spawn } from "node:child_process";
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
import {
  PATCHES,
  __testing as prepareTesting,
  prepareConsole,
} from "../../scripts/qwenpaw-console/prepare.mjs";
import * as qwenpawSync from "../../scripts/qwenpaw-console/sync.mjs";
import {
  COMMANDS as CONSOLE_TEST_COMMANDS,
  runPreparedConsoleTests,
} from "../../scripts/qwenpaw-console/test.mjs";
import * as consoleTestScript from "../../scripts/qwenpaw-console/test.mjs";
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";

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
    `#!/usr/bin/env node
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

describe("QwenPaw Console patch preparation", () => {
  it("固定四个补丁的不可变应用顺序", () => {
    expect(PATCHES).toEqual([
      "0001-brand.patch",
      "0002-theme.patch",
      "0003-route-auth.patch",
      "0004-api-compat.patch",
    ]);
    expect(Object.isFrozen(PATCHES)).toBe(true);
    expect(Reflect.set(PATCHES, 0, "changed.patch")).toBe(false);
    expect(PATCHES[0]).toBe("0001-brand.patch");
  });

  it("四个补丁使用普通 unified diff 上下文且没有行尾空白", async () => {
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

  it("真实验证并应用四个补丁，生成 DigitalMate Console 集成树", async () => {
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
        configSource,
        requestSource,
        agentsPageSource,
        agentTableSource,
        i18nSource,
        headerSource,
        updateContentSource,
        layoutStyles,
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
        readPrepared("src/api/config.ts"),
        readPrepared("src/api/request.ts"),
        readPrepared("src/pages/Settings/Agents/index.tsx"),
        readPrepared("src/pages/Settings/Agents/components/AgentTable.tsx"),
        readPrepared("src/i18n.ts"),
        readPrepared("src/layouts/Header.tsx"),
        readPrepared("src/layouts/constants.ts"),
        readPrepared("src/layouts/index.module.less"),
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
      expect(appSource).toContain('pathname.startsWith("/admin-preview/")');
      expect(appSource).toContain('return "/admin-preview"');
      expect(appSource).toContain('pathname.startsWith("/admin/")');
      expect(appSource).toContain('return "/admin"');
      expect(appSource).toContain('fetch("/api/admin/compat/auth/status"');
      expect(routesSource).toContain('window.location.assign("/")');
      expect
        .soft(routesSource)
        .toContain('return <Navigate to="/inbox" replace />');
      expect
        .soft(routesSource)
        .not.toContain('return <Navigate to="/channels" replace />');
      expect
        .soft(routesSource)
        .toContain('path: "/coding/*", component: CodingCapabilityRoute');
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
      expect(requestSource).toContain("buildMutationHeaders");
      expect.soft(authHeadersSource).toContain("buildMutationHeaders");
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
      expect(agentsPageSource).toContain(
        'const SECONDARY_AGENT_CAPABILITY = "unsupported"',
      );
      expect(agentsPageSource).toContain("disabled");
      expect(agentTableSource).toContain("secondaryAgentActionsDisabled");
      expect(agentTableSource).toContain("disabled={deleteDisabled}");
      expect
        .soft(agentTableSource)
        .toMatch(
          /record\.id === "default"\s*\?\s*t\("agent\.defaultNotDeletable"\)\s*:\s*startupInProgress\s*\?\s*t\("agent\.status\.waitUntilStarted"\)\s*:\s*secondaryActionsDisabled\s*\?\s*t\("agent\.secondaryAgentUnsupported"\)/,
        );
      expect
        .soft(agentTableTestSource)
        .toContain('screen.getByTitle("agent.defaultNotDeletable")');
      expect
        .soft(agentSelectorSource)
        .toContain('.filter((agent) => agent.id === "default")');
      expect
        .soft(agentSelectorTestSource)
        .toContain("does not show secondary agent");
      expect
        .soft(agentTableTestSource)
        .toContain("does not invoke secondary agent actions");
      expect
        .soft(agentTableTestSource)
        .toContain("does not reorder secondary agents");
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
