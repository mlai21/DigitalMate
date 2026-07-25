import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ChannelAdapterRegistry,
  type ChannelAdapterFactory,
} from "@/server/channels/runtime/registry";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import { CHANNEL_TYPES } from "@/server/channels/manifests/catalog";

const ADAPTER_KEYS = [
  "manifest",
  "validateConfig",
  "start",
  "stop",
  "health",
  "normalizeInbound",
  "acknowledge",
  "send",
  "typing",
  "streaming",
  "resolveRecipient",
] as const satisfies readonly (keyof ChannelAdapter<Record<string, unknown>>)[];

type UnexpectedAdapterKey = Exclude<
  keyof ChannelAdapter<Record<string, unknown>>,
  (typeof ADAPTER_KEYS)[number]
>;
const HAS_NO_UNEXPECTED_ADAPTER_KEYS: [UnexpectedAdapterKey] extends [never]
  ? true
  : never = true;

const NEVER_FACTORY: ChannelAdapterFactory = () => {
  throw new Error("factory_not_invoked");
};

describe("ChannelAdapter boundary", () => {
  it("only exposes platform responsibilities", () => {
    expect(HAS_NO_UNEXPECTED_ADAPTER_KEYS).toBe(true);
    expect(ADAPTER_KEYS).toEqual([
      "manifest",
      "validateConfig",
      "start",
      "stop",
      "health",
      "normalizeInbound",
      "acknowledge",
      "send",
      "typing",
      "streaming",
      "resolveRecipient",
    ]);
  });

  it("rejects duplicate and missing adapter registrations", () => {
    const registry = new ChannelAdapterRegistry();

    expect(() => registry.assertComplete()).toThrow(
      `channel_adapters_missing:${CHANNEL_TYPES.join(",")}`,
    );

    for (const type of CHANNEL_TYPES) {
      registry.register(type, NEVER_FACTORY);
    }

    expect(() => registry.assertComplete()).not.toThrow();
    expect(() => registry.register("telegram", NEVER_FACTORY)).toThrow(
      "duplicate_channel_adapter:telegram",
    );
  });

  it("fails closed when creating an unregistered adapter", () => {
    const registry = new ChannelAdapterRegistry();

    expect(() =>
      registry.create("telegram", {
        now: () => new Date("2026-07-26T00:00:00.000Z"),
      }),
    ).toThrow("channel_adapter_not_registered:telegram");
  });

  it("adapters cannot import the DigitalMate brain", async () => {
    const violations = await scanImports(
      path.join(process.cwd(), "src/server/channels/adapters"),
      [
        "@/server/agent/run-agent",
        "@/server/agent/tools/web-search",
        "@/server/evolution",
        "@/server/skills",
        "repositories.messages",
        "repositories.memories",
      ],
    );

    expect(violations).toEqual([]);
  });
});

async function scanImports(
  directory: string,
  forbidden: readonly string[],
): Promise<string[]> {
  const files = await listTypeScriptFiles(directory);
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const token of forbidden) {
      if (source.includes(token)) {
        violations.push(`${path.relative(process.cwd(), file)}:${token}`);
      }
    }
  }

  return violations.sort();
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(absolutePath);
      }
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)
        ? [absolutePath]
        : [];
    }),
  );

  return nested.flat();
}
