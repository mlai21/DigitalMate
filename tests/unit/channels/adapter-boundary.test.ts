import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ChannelAdapterRegistry,
  type ChannelAdapterFactory,
} from "@/server/channels/runtime/registry";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import { CHANNEL_TYPES } from "@/server/channels/manifests/catalog";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  createDeterministicClock,
  createFakeHttpClient,
  createFakeSocket,
} from "@/server/channels/testing/fixtures";

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

  it("detects unstable external event ids", async () => {
    let sequence = 0;

    await expect(
      assertStableExternalEventId(async () => ({
        ...normalizedFixture(),
        externalEventId: `message:${sequence += 1}`,
      })),
    ).rejects.toThrow("unstable_external_event_id");

    await expect(
      assertStableExternalEventId(async () => normalizedFixture()),
    ).resolves.toBe("message:stable-1");
  });

  it("provides deterministic clock, HTTP and socket fixtures", async () => {
    const clock = createDeterministicClock(
      new Date("2026-07-26T00:00:00.000Z"),
    );
    const http = createFakeHttpClient();
    const socket = createFakeSocket();

    http.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
    const response = await http.request({
      method: "POST",
      url: "https://platform.example/messages",
      headers: { authorization: "Bearer test" },
      body: { text: "hello" },
    });
    const received: unknown[] = [];
    socket.onMessage((payload) => received.push(payload));
    socket.open();
    socket.receive({ event: "message" });
    clock.advanceBy(1_500);

    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.headers).toEqual({
      authorization: "[REDACTED]",
    });
    expect(socket.state).toBe("open");
    expect(received).toEqual([{ event: "message" }]);
    expect(clock.now().toISOString()).toBe(
      "2026-07-26T00:00:01.500Z",
    );
  });

  it("exports the reusable seven-assertion contract", () => {
    expect(defineChannelContract).toBeTypeOf("function");
  });
});

function normalizedFixture() {
  const occurredAt = new Date("2026-07-26T00:00:00.000Z");
  return {
    connectionId: "connection-1",
    agentId: "agent-1",
    channelType: "telegram" as const,
    externalEventId: "message:stable-1",
    externalConversationId: "chat-1",
    externalSenderId: "user-1",
    chatType: "direct" as const,
    mentioned: false,
    text: "hello",
    thread: {},
    attachments: [],
    occurredAt,
    receivedAt: occurredAt,
    permission: {
      webSearch: false as const,
      backgroundNetwork: false as const,
      tools: false as const,
      skills: "none" as const,
      attachmentsPresent: false,
    },
    rawSummary: { updateId: "stable-1" },
  };
}

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
