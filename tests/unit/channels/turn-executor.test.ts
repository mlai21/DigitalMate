import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentScope } from "@/server/agents/types";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import {
  buildChannelTurnSecurityContext,
  downloadInboundAttachment,
  type InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
} satisfies AgentScope;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("channel attachment ingress", () => {
  it.each([
    ["vector.svg", "image/svg+xml"],
    ["page.html", "text/html"],
    ["archive.zip", "application/zip"],
    ["voice.mp3", "audio/mpeg"],
    ["video.mp4", "video/mp4"],
  ])("rejects %s before opening a download stream", async (
    fileName,
    mimeType,
  ) => {
    const harness = await downloadHarness({
      fileName,
      mimeType,
      sizeBytes: 12,
      bytes: Buffer.from("not-allowed"),
    });

    await expect(harness.run()).rejects.toThrow(
      "attachment_type_not_allowed",
    );
    expect(harness.fetcher.download).not.toHaveBeenCalled();
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
  });

  it("rejects oversized metadata before downloading bytes", async () => {
    const harness = await downloadHarness({
      fileName: "large.txt",
      mimeType: "text/plain",
      sizeBytes: ATTACHMENT_LIMITS.maxFileBytes + 1,
      bytes: Buffer.from("small"),
    });

    await expect(harness.run()).rejects.toThrow(
      "attachment_file_too_large",
    );
    expect(harness.fetcher.download).not.toHaveBeenCalled();
  });

  it("streams an allowed file into private storage and binds one draft", async () => {
    const bytes = Buffer.from("hello DigitalMate");
    const harness = await downloadHarness({
      fileName: "../notes.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      bytes,
      chunks: [bytes.subarray(0, 5), bytes.subarray(5)],
    });

    const result = await harness.run();
    const stored = await readFile(
      path.join(harness.storageRoot, result.storageKey),
    );
    const storedStat = await stat(
      path.join(harness.storageRoot, result.storageKey),
    );

    expect(stored).toEqual(bytes);
    expect(storedStat.mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({
      attachmentId: "attachment-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    });
    expect(harness.repository.markReady).toHaveBeenCalledWith(
      scope,
      "attachment-1",
    );
    expect(harness.bindPrivateAttachment).toHaveBeenCalledWith(
      "attachment-1",
    );
  });

  it("removes temporary data when streamed bytes exceed metadata", async () => {
    const harness = await downloadHarness({
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      bytes: Buffer.from("three"),
    });

    await expect(harness.run()).rejects.toThrow(
      "attachment_size_mismatch",
    );
    expect(await readFileNames(harness.storageRoot)).toEqual([]);
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
  });

  it("rejects signature mismatch without exposing the locator", async () => {
    const secretLocator = "https://platform.invalid/file?token=secret";
    const harness = await downloadHarness({
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: 7,
      bytes: Buffer.from("not-png"),
      source: { url: secretLocator },
    });

    let error: unknown;
    try {
      await harness.run();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "attachment_signature_mismatch",
    );
    expect(String(error)).not.toContain(secretLocator);
    expect(await readFileNames(harness.storageRoot)).toEqual([]);
  });
});

describe("channel turn attachment guard", () => {
  it.each([
    [1, 0],
    [0, 1],
    [1, 1],
  ])(
    "blocks search, skills, and tools for %i current and %i historical attachments",
    (currentCount, historyCount) => {
      const context = buildChannelTurnSecurityContext({
        currentAttachmentCount: currentCount,
        historicalAttachmentCount: historyCount,
        explicitSkillIds: ["skill-1"],
      });

      expect(context).toEqual({
        attachmentToolGuard: true,
        explicitSkillIds: [],
        webSearchEnabled: false,
      });
    },
  );

  it("preserves explicit slash skills only when no attachment is present", () => {
    expect(buildChannelTurnSecurityContext({
      currentAttachmentCount: 0,
      historicalAttachmentCount: 0,
      explicitSkillIds: ["skill-1"],
    })).toEqual({
      attachmentToolGuard: false,
      explicitSkillIds: ["skill-1"],
      webSearchEnabled: false,
    });
  });
});

async function downloadHarness(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
  chunks?: readonly Buffer[];
  source?: Record<string, string>;
}) {
  const storageRoot = await mkdtemp(
    path.join(os.tmpdir(), "digitalmate-channel-attachment-"),
  );
  temporaryDirectories.push(storageRoot);
  const descriptor: InboundAttachmentDescriptor = {
    externalAttachmentId: "external-attachment-1",
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    source: input.source ?? { opaqueId: "file-1" },
  };
  const fetcher: InboundAttachmentFetcher = {
    inspect: vi.fn(async () => ({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })),
    download: vi.fn(async () =>
      asAsyncIterable(input.chunks ?? [input.bytes])
    ),
  };
  const repository = {
    createDraft: vi.fn(async () => ({ id: "attachment-1" })),
    markReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const bindPrivateAttachment = vi.fn(async () => undefined);

  return {
    storageRoot,
    fetcher,
    repository,
    bindPrivateAttachment,
    run: () => downloadInboundAttachment({
      scope,
      descriptor,
      fetcher,
      storageRoot,
      repository,
      bindPrivateAttachment,
    }),
  };
}

async function* asAsyncIterable(
  chunks: readonly Buffer[],
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function readFileNames(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directory)).sort();
}
