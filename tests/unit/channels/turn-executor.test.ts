import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runAgent,
  type RunAgentInput,
} from "@/server/agent/run-agent";
import type { AgentScope } from "@/server/agents/types";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import {
  buildChannelTurnSecurityContext,
  downloadInboundAttachment,
  type InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import type {
  ChannelReaction,
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";
import type { ClaimedChannelEvent } from "@/server/channels/runtime/event-repository";
import type {
  ExecutionJournal,
  ExecutionStep,
} from "@/server/channels/runtime/execution-journal";
import {
  CHANNEL_INTERRUPTED_REPLY,
  createChannelTurnExecutor,
} from "@/server/channels/runtime/turn-executor";
import type { LlmClient } from "@/server/llm/types";

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

describe("channel turn execution contract", () => {
  it("runs the Agent once and persists the generated reply", async () => {
    const harness = turnHarness();

    const result = await harness.executor.execute(claimedEvent());

    expect(result).toMatchObject({
      assistantMessageId: "assistant-1",
      created: true,
      degraded: false,
    });
    expect(harness.messages.createIdempotentUserTurn).toHaveBeenCalledTimes(1);
    expect(harness.messages.claimClientTurnExecution).toHaveBeenCalledTimes(1);
    expect(harness.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(harness.persistReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "正常回复",
      }),
    );
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps platform typing active for the Agent execution lifecycle", async () => {
    const harness = turnHarness();
    let releaseAgent: (() => void) | undefined;
    harness.runAgentTurn.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        releaseAgent = () => resolve("正常回复");
      }),
    );

    const execution =
      harness.executor.execute(claimedEvent());
    await vi.waitFor(() => {
      expect(harness.typing).toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
    });
    expect(harness.typing).not.toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
    releaseAgent?.();
    await execution;

    expect(harness.typing.mock.calls.map(
      ([, active]) => active,
    )).toEqual([true, false]);
  });

  it("clears the platform indicator when the Agent fails", async () => {
    const harness = turnHarness();
    harness.runAgentTurn.mockRejectedValueOnce(
      new Error("agent_exploded"),
    );

    const result = await harness.executor.execute(claimedEvent());

    expect(result.degraded).toBe(true);
    expect(harness.typing.mock.calls.map(
      ([, active]) => active,
    )).toEqual([true, false]);
  });

  it("leaves no platform indicator when the turn is skipped", async () => {
    const harness = turnHarness({ skipReason: "not_mentioned" });

    const result = await harness.executor.execute(claimedEvent());

    expect(result).toMatchObject({ skipped: true });
    expect(harness.typing).not.toHaveBeenCalled();
    expect(harness.reaction).not.toHaveBeenCalled();
  });

  it("hands the busy reaction to delivery instead of withdrawing it", async () => {
    const harness = turnHarness({ chosenReaction: "good_question" });

    await harness.executor.execute(claimedEvent());

    expect(harness.reaction.mock.calls.map(
      ([, active]) => active,
    )).toEqual([true]);
    expect(harness.persistReply).toHaveBeenCalledWith(
      expect.objectContaining({
        reactionPlan: {
          platformMessageId: "platform-message-1",
          reaction: "good_question",
        },
      }),
    );
  });

  it("withdraws the busy reaction when no reply will be delivered", async () => {
    const harness = turnHarness();
    harness.persistReply.mockRejectedValueOnce(
      new Error("persist_exploded"),
    );

    await expect(
      harness.executor.execute(claimedEvent()),
    ).rejects.toThrowError("persist_exploded");

    expect(harness.reaction.mock.calls.map(
      ([, active]) => active,
    )).toEqual([true, false]);
  });

  it("still delivers when the reaction model is unavailable", async () => {
    const harness = turnHarness({
      chooseReactionError: new Error("light_model_down"),
    });

    const result = await harness.executor.execute(claimedEvent());

    expect(result).toMatchObject({ deliveryId: "delivery-1" });
    expect(harness.persistReply).toHaveBeenCalledWith(
      expect.objectContaining({
        reactionPlan: {
          platformMessageId: "platform-message-1",
          reaction: null,
        },
      }),
    );
  });

  it("picks the reaction while the Agent is still working", async () => {
    const harness = turnHarness({ chosenReaction: "acknowledged" });
    let releaseAgent: (() => void) | undefined;
    harness.runAgentTurn.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        releaseAgent = () => resolve("正常回复");
      }),
    );

    const execution = harness.executor.execute(claimedEvent());
    await vi.waitFor(() => {
      expect(harness.chooseReaction).toHaveBeenCalled();
    });
    expect(harness.persistReply).not.toHaveBeenCalled();
    releaseAgent?.();
    await execution;
  });

  it("does not rerun the Agent after execution was already claimed", async () => {
    const harness = turnHarness({ executionClaimed: false });

    const result = await harness.executor.execute(claimedEvent());

    expect(result.degraded).toBe(true);
    expect(harness.runAgentTurn).not.toHaveBeenCalled();
    expect(harness.persistReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: CHANNEL_INTERRUPTED_REPLY,
      }),
    );
    expect(CHANNEL_INTERRUPTED_REPLY).toContain("没能完整回复");
  });

  it("persists one degraded reply when the Agent returns a handled error", async () => {
    const harness = turnHarness();
    harness.runAgentTurn.mockRejectedValueOnce(
      new Error("provider_unavailable"),
    );

    const result = await harness.executor.execute(claimedEvent());

    expect(result.degraded).toBe(true);
    expect(harness.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(harness.persistReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("稍后再试"),
      }),
    );
  });

  it("completes a deterministic group skip before claiming Agent execution", async () => {
    const harness = turnHarness({ skipReason: "conversation_busy" });
    const claim = claimedEvent();

    const result = await harness.executor.execute({
      ...claim,
      normalizedEvent: {
        ...claim.normalizedEvent,
        chatType: "group",
      },
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: "conversation_busy",
      assistantMessageId: null,
      deliveryId: null,
    });
    expect(harness.messages.createIdempotentUserTurn)
      .toHaveBeenCalledWith(
        scope,
        expect.objectContaining({ memoryProcessed: true }),
      );
    expect(harness.messages.claimClientTurnExecution)
      .not.toHaveBeenCalled();
    expect(harness.runAgentTurn).not.toHaveBeenCalled();
    expect(harness.persistReply).not.toHaveBeenCalled();
    expect(harness.completeWithoutReply).toHaveBeenCalledOnce();
  });
});

describe("runAgent execution journal", () => {
  it("reuses a completed LLM round without invoking the model again", async () => {
    const journal = memoryJournal();
    const firstStream = vi.fn(async function* () {
      yield { type: "text" as const, text: "第一次回复" };
    });
    const first = await collectAgentReply({
      journal,
      stream: firstStream,
    });
    const recoveryStream = vi.fn(async function* () {
      yield { type: "text" as const, text: "不应调用" };
    });

    const recovered = await collectAgentReply({
      journal,
      stream: recoveryStream,
    });

    expect(first).toBe("第一次回复");
    expect(recovered).toBe("第一次回复");
    expect(firstStream).toHaveBeenCalledTimes(1);
    expect(recoveryStream).not.toHaveBeenCalled();
    expect(journal.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "llm:0",
        kind: "llm",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("does not replay an ambiguous search side effect", async () => {
    const search = vi.fn(async () => ({
      summary: "不会真的搜索",
      results: [],
    }));
    const journal = memoryJournal({
      ambiguous: (step) => step.kind === "search",
    });
    let turn = 0;
    const stream = vi.fn(async function* () {
      if (turn++ === 0) {
        yield {
          type: "tool_call" as const,
          toolCall: {
            id: "call-1",
            name: "web_search",
            arguments: '{"query":"今天新闻"}',
          },
        };
        return;
      }
      yield { type: "text" as const, text: "稍后再试" };
    });

    await expect(collectAgentReply({
      journal,
      stream,
      search,
    })).resolves.toBe("稍后再试");

    expect(search).not.toHaveBeenCalled();
    expect(journal.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(
          /^search:0:[0-9a-f]{64}$/,
        ),
        kind: "search",
      }),
    );
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

function claimedEvent(): ClaimedChannelEvent {
  return {
    id: "event-1",
    scope,
    connectionId: "20000000-0000-4000-8000-000000000001",
    normalizedEvent: {
      connectionId: "20000000-0000-4000-8000-000000000001",
      agentId: scope.agentId,
      channelType: "telegram",
      externalEventId: "external-event-1",
      externalConversationId: "external-conversation-1",
      externalSenderId: "external-sender-1",
      chatType: "direct",
      mentioned: false,
      text: "你好",
      thread: {},
      attachments: [],
      occurredAt: new Date("2026-07-26T00:00:00.000Z"),
      receivedAt: new Date("2026-07-26T00:00:01.000Z"),
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: false,
      },
      rawSummary: {
        eventType: "message",
        platformMessageId: "platform-message-1",
      },
    },
    clientTurnId: "30000000-0000-4000-8000-000000000001",
    payloadHash: "a".repeat(64),
    status: "running",
    claimOwner: "worker-1",
    claimExpiresAt: new Date("2026-07-26T00:01:00.000Z"),
    attempts: 1,
    failureCode: null,
    assistantMessageId: null,
    completedAt: null,
  };
}

function turnHarness(options: {
  executionClaimed?: boolean;
  skipReason?: string;
  chosenReaction?: ChannelReaction | null;
  chooseReactionError?: Error;
} = {}) {
  const releaseLock = vi.fn(async () => undefined);
  const messages = {
    createIdempotentUserTurn: vi.fn(async () => ({
      message: { id: "user-message-1" },
      attachments: [],
      created: true,
    })),
    acquireClientTurnExecutionLock: vi.fn(async () => releaseLock),
    findByClientTurn: vi.fn(async () => null),
    claimClientTurnExecution: vi.fn(
      async () => options.executionClaimed ?? true,
    ),
  };
  const runAgentTurn = vi.fn(async () => "正常回复");
  const persistReply = vi.fn(async () => ({
    assistantMessageId: "assistant-1",
    deliveryId: "delivery-1",
    created: true,
  }));
  const completeWithoutReply = vi.fn(async () => undefined);
  const typing = vi.fn<(
    claim: ClaimedChannelEvent,
    active: boolean,
  ) => Promise<void>>(async () => undefined);
  const reaction = vi.fn<(
    claim: ClaimedChannelEvent,
    active: boolean,
  ) => Promise<void>>(async () => undefined);
  const chooseReaction = vi.fn<(
    claim: ClaimedChannelEvent,
  ) => Promise<ChannelReaction | null>>(async () => {
    if (options.chooseReactionError) throw options.chooseReactionError;
    return options.chosenReaction ?? null;
  });
  const executor = createChannelTurnExecutor({
    messages,
    resolveConversationId: vi.fn(async () => "conversation-1"),
    resolveAttachmentIds: vi.fn(async () => []),
    createJournal: vi.fn(() => memoryJournal()),
    decideTurn: options.skipReason
      ? vi.fn(async () => ({
          kind: "skip" as const,
          reason: options.skipReason!,
        }))
      : undefined,
    runAgentTurn,
    persistReply,
    completeWithoutReply,
    typing,
    reaction,
    chooseReaction,
  });
  return {
    executor,
    messages,
    runAgentTurn,
    persistReply,
    completeWithoutReply,
    typing,
    reaction,
    chooseReaction,
    releaseLock,
  };
}

function memoryJournal(options: {
  ambiguous?: (step: ExecutionStep) => boolean;
} = {}): ExecutionJournal & {
  begin: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, unknown>();
  const states = new Map<
    string,
    "started" | "completed" | "failed" | "ambiguous"
  >();
  const begin = vi.fn(async (step: ExecutionStep) => {
    if (options.ambiguous?.(step)) {
      states.set(step.key, "ambiguous");
      return "ambiguous" as const;
    }
    const state = states.get(step.key);
    if (state === "completed") return "reuse" as const;
    if (state) return "ambiguous" as const;
    states.set(step.key, "started");
    return "run" as const;
  });
  return {
    begin,
    complete: vi.fn(async (stepKey: string, output: unknown) => {
      values.set(stepKey, output);
      states.set(stepKey, "completed");
    }),
    fail: vi.fn(async (stepKey: string) => {
      states.set(stepKey, "failed");
    }),
    read: async <T>(stepKey: string): Promise<T | null> =>
      (values.get(stepKey) as T | undefined) ?? null,
  };
}

async function collectAgentReply(input: {
  journal: ExecutionJournal;
  stream: LlmClient["stream"];
  search?: RunAgentInput["search"]["run"];
}): Promise<string> {
  let reply = "";
  for await (const chunk of runAgent({
    userId: scope.userId,
    agentId: scope.agentId,
    conversationId: "conversation-1",
    message: "请回答",
    history: [],
    persona: { name: "DigitalMate", style: "温暖、克制" },
    llm: {
      stream: input.stream,
      completeText: vi.fn(async () => ""),
    },
    model: "mock-main",
    repositories: {
      memories: { findRelevant: vi.fn(async () => []) },
      toolLogs: { create: vi.fn(async () => undefined) },
    },
    search: {
      run: input.search ?? vi.fn(async () => ({
        summary: "",
        results: [],
      })),
    },
    searchGate: {
      evaluate: vi.fn(async () => ({
        allowed: true as const,
        method: "explicit" as const,
        reason: "用户明确要求",
      })),
    },
    executionJournal: input.journal,
  })) {
    reply += chunk;
  }
  return reply;
}
