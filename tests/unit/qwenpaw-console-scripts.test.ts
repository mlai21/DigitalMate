import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UPSTREAM } from "../../scripts/qwenpaw-console/sync.mjs";
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";

const SNAPSHOT_ROOT = path.resolve("vendor/qwenpaw-console");
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
