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
import { verifySnapshot } from "../../scripts/qwenpaw-console/verify-upstream.mjs";

const SNAPSHOT_ROOT = path.resolve("vendor/qwenpaw-console");

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

  it("拒绝禁用路径段", async () => {
    await withSnapshotCopy(async (root) => {
      const forbiddenRoot = path.join(root, "console", "node_modules");
      await mkdir(forbiddenRoot, { recursive: true });
      await writeFile(path.join(forbiddenRoot, "package.js"), "export {};\n");

      await expect(verifySnapshot(root)).rejects.toThrow(
        "forbidden path segment",
      );
    });
  });

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

  it("拒绝缺少固定快照路径", async () => {
    await withSnapshotCopy(async (root) => {
      await rm(path.join(root, "reference", "src", "qwenpaw", "config", "config.py"));

      await expect(verifySnapshot(root)).rejects.toThrow(
        "required snapshot path missing",
      );
    });
  });
});
