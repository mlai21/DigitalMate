import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createActiveAgentTickRunner } from "@/agent-service/active-agent-tick";

describe("active agent tick", () => {
  it("keeps reusable tick orchestration separate from the guarded CLI entrypoint", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/agent-service/index.ts"),
      "utf8",
    );

    expect(source).toContain('from "@/agent-service/active-agent-tick"');
    expect(source).toContain("isDirectAgentServiceEntry");
    expect(source).not.toMatch(/^main\(\)\.catch/m);
  });

  it("runs every active scope independently without sharing status or throttle state", async () => {
    let now = 1_000;
    const executed: string[] = [];
    const errors: string[] = [];
    const listActiveAgents = vi.fn(async () => [
      { id: "agent-a", userId: "user-1", status: "active" as const },
      { id: "agent-b", userId: "user-1", status: "active" as const },
      { id: "agent-disabled", userId: "user-1", status: "disabled" as const },
      { id: "agent-a", userId: "user-2", status: "active" as const },
    ]);
    const runTick = createActiveAgentTickRunner({
      listActiveAgents,
      throttleMs: 100,
      now: () => now,
      execute: async (scope) => {
        const key = `${scope.userId}:${scope.agentId}`;
        executed.push(key);
        if (key === "user-1:agent-a") throw new Error("agent-a-failed");
      },
      onError: async (error, scope) => {
        errors.push(`${scope.userId}:${scope.agentId}:${String(error)}`);
      },
    });

    await runTick();
    await runTick();
    now += 100;
    await runTick();

    expect(executed).toEqual([
      "user-1:agent-a",
      "user-1:agent-b",
      "user-2:agent-a",
      "user-1:agent-a",
      "user-1:agent-b",
      "user-2:agent-a",
    ]);
    expect(errors).toHaveLength(2);
    expect(executed).not.toContain("user-1:agent-disabled");
    expect(listActiveAgents).toHaveBeenCalledTimes(3);
  });

  it("continues with later agents when the asynchronous error reporter also rejects", async () => {
    const executed: string[] = [];
    const runTick = createActiveAgentTickRunner({
      listActiveAgents: async () => [
        { id: "agent-a", userId: "user-1", status: "active" as const },
        { id: "agent-b", userId: "user-1", status: "active" as const },
      ],
      execute: async (scope) => {
        executed.push(scope.agentId);
        if (scope.agentId === "agent-a") throw new Error("execute_failed");
      },
      onError: async () => {
        throw new Error("report_failed");
      },
    });

    await expect(runTick()).resolves.toBeUndefined();
    expect(executed).toEqual(["agent-a", "agent-b"]);
  });
});
