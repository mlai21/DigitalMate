import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/run-e2e.mjs");

describe("E2E runner", () => {
  it.each([
    {
      args: [],
      expected: [
        { suite: "app", args: [] },
        { suite: "scroll", args: [] },
      ],
    },
    {
      args: ["tests/e2e/chat.spec.ts"],
      expected: [{ suite: "app", args: ["tests/e2e/chat.spec.ts"] }],
    },
    {
      args: ["tests/e2e/chat-scroll.spec.ts"],
      expected: [{ suite: "scroll", args: ["tests/e2e/chat-scroll.spec.ts"] }],
    },
  ])("routes $args to the matching Playwright suite", ({ args, expected }) => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", ...args], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });
});
