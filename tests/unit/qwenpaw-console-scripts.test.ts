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
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";

const { UPSTREAM } = qwenpawSync;
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
    | SyncTestingInterface
    | undefined;
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
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "dm-qwenpaw-replace-"));
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

      await expect(
        qwenpawSync.syncSnapshot(destinationRoot),
      ).rejects.toThrow("symbolic link not allowed");
      await expectPathMissing(destinationRoot);
    });
  });

  it("复制前拒绝来源类型不符", async () => {
    await withFakeUpstream(async ({ destinationRoot, fixtureRoot }) => {
      const licensePath = path.join(fixtureRoot, "LICENSE");
      await rm(licensePath);
      await mkdir(licensePath);

      await expect(
        qwenpawSync.syncSnapshot(destinationRoot),
      ).rejects.toThrow("source snapshot path invalid");
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
      ).rejects.toThrow(
        /injected install failure.*injected cleanup failure/,
      );

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
      expect(upstream).toContain(
        "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
      );
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
      await writeFile(path.join(root, "UNREGISTERED.txt"), "unexpected\n", "utf8");

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
      await rm(path.join(root, "reference", "src", "qwenpaw", "config", "config.py"));

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

  it(
    "真实验证并应用四个补丁，生成 DigitalMate Console 集成树",
    async () => {
      const result = await prepareConsole({ keep: true });

      try {
        expect(result.applied).toEqual(PATCHES);
        expect(result.applied).not.toBe(PATCHES);

        const readPrepared = (relativePath: string) =>
          readFile(path.join(result.workdir, ...relativePath.split("/")), "utf8");
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
        ] = await Promise.all([
          readPrepared("src/App.tsx"),
          readPrepared("index.html"),
          readPrepared("src/layouts/registry/builtinRoutes.tsx"),
          readPrepared("src/api/config.ts"),
          readPrepared("src/api/request.ts"),
          readPrepared("src/pages/Settings/Agents/index.tsx"),
          readPrepared(
            "src/pages/Settings/Agents/components/AgentTable.tsx",
          ),
          readPrepared("src/i18n.ts"),
          readPrepared("src/layouts/Header.tsx"),
          readPrepared("src/layouts/constants.ts"),
          readPrepared("src/layouts/index.module.less"),
          readPrepared("src/pages/Chat/index.tsx"),
        ]);

        expect(indexHtml).toContain("<title>DigitalMate Console</title>");
        expect(indexHtml).not.toContain("<title>QwenPaw Console</title>");
        expect(i18nSource).toContain(
          'return value.replace(/QwenPaw/g, "DigitalMate")',
        );
        expect(headerSource).toContain('src="/digitalmate-logo.svg"');
        expect(headerSource).toContain('alt="DigitalMate"');
        expect(headerSource).toContain("How to update DigitalMate");
        expect(updateContentSource).toContain("How to update DigitalMate");
        expect(updateContentSource).toContain("DigitalMate如何更新");
        expect(layoutStyles).toContain(
          "linear-gradient(135deg, #faf7f2 0%, #f7ddd6 100%)",
        );
        expect(layoutStyles).not.toContain("qwenpawBack.png");
        expect(chatSource).toContain('avatar: extAvatar ?? "/digitalmate-logo.svg"');
        expect(chatSource).toContain('nick: extNick ?? "DigitalMate"');
        expect(appSource).toContain('colorPrimary: "#E8684A"');
        expect(appSource).toContain('colorBgLayout: "#FAF7F2"');
        expect(appSource).toContain('pathname.startsWith("/admin-preview/")');
        expect(appSource).toContain('return "/admin-preview"');
        expect(appSource).toContain('pathname.startsWith("/admin/")');
        expect(appSource).toContain('return "/admin"');
        expect(appSource).toContain(
          'fetch("/api/admin/compat/auth/status"',
        );
        expect(routesSource).toContain('window.location.assign("/")');
        expect(configSource).toContain(
          'const API_BASE_URL = "/api/admin/compat"',
        );
        expect(configSource).toContain('let csrfToken = ""');
        expect(requestSource).toContain('headers.set("x-csrf-token", csrfToken)');
        expect(requestSource).toContain("getCsrfToken()");
        expect(agentsPageSource).toContain(
          'const SECONDARY_AGENT_CAPABILITY = "unsupported"',
        );
        expect(agentsPageSource).toContain("disabled");
        expect(agentTableSource).toContain("secondaryAgentActionsDisabled");
        expect(agentTableSource).toContain("disabled={deleteDisabled}");
      } finally {
        await rm(result.workdir, { recursive: true, force: true });
      }

      await expect(verifySnapshot(SNAPSHOT_ROOT)).resolves.toMatchObject({
        commit: UPSTREAM.commit,
      });
    },
    120_000,
  );

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

      const outcome = await runPreparedConsoleTests({
        prepare: async () => ({ workdir, applied: [...PATCHES] }),
        runCommand: async (command, args, options) => {
          commands.push({ command, args: [...args], cwd: options.cwd });
          const commandIndex = commands.length - 1;
          return commandIndex === failedCommand
            ? { exitCode, signal: null }
            : { exitCode: 0, signal: null };
        },
      });

      expect(outcome).toEqual({ exitCode, signal: null });
      expect(commands).toEqual(
        CONSOLE_TEST_COMMANDS.slice(
          0,
          failedCommand === null ? undefined : failedCommand + 1,
        ).map(([command, ...args]) => ({ command, args, cwd: workdir })),
      );
      await expectPathMissing(workdir);
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  );
});
