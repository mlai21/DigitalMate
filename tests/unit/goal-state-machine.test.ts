import { describe, expect, it } from "vitest";
import {
  GOAL_STATUSES,
  isTerminalGoalStatus,
  reduceGoalStatus,
  TERMINAL_GOAL_STATUSES,
  type GoalEvent,
  type GoalStatus,
} from "@/server/goals/state-machine";

function expectTransition(from: GoalStatus, event: GoalEvent, to: GoalStatus) {
  const result = reduceGoalStatus(from, event);
  expect(result).toEqual({ ok: true, status: to });
}

describe("goal state machine", () => {
  it("follows the designed happy path from draft to succeeded", () => {
    expectTransition("draft", { type: "contract_confirmed" }, "confirmed");
    expectTransition("confirmed", { type: "picked_up" }, "running");
    expectTransition("running", { type: "verified_success", evidenceRefs: ["https://example.com/a"] }, "succeeded");
  });

  it("supports pause and resume", () => {
    expectTransition("running", { type: "user_paused" }, "paused");
    expectTransition("paused", { type: "user_resumed" }, "running");
  });

  it("supports the needs_human escalation round trip", () => {
    expectTransition("running", { type: "escalated", prompt: "需要你决定 A 还是 B" }, "needs_human");
    expectTransition("needs_human", { type: "human_replied" }, "running");
    expectTransition("needs_human", { type: "user_cancelled" }, "cancelled");
  });

  it("stops on budget exhaustion and no-progress limit", () => {
    expectTransition("running", { type: "budget_exhausted" }, "failed_budget");
    expectTransition("running", { type: "no_progress_limit_reached" }, "failed_no_progress");
  });

  it("allows the user to cancel from every non-terminal status", () => {
    for (const status of GOAL_STATUSES) {
      if (isTerminalGoalStatus(status)) continue;
      expectTransition(status, { type: "user_cancelled" }, "cancelled");
    }
  });

  it("rejects verified_success without evidence references", () => {
    const result = reduceGoalStatus("running", { type: "verified_success", evidenceRefs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("evidence");
  });

  it("rejects events that are not allowed in the current status", () => {
    expect(reduceGoalStatus("draft", { type: "picked_up" }).ok).toBe(false);
    expect(reduceGoalStatus("confirmed", { type: "verified_success", evidenceRefs: ["x"] }).ok).toBe(false);
    expect(reduceGoalStatus("paused", { type: "budget_exhausted" }).ok).toBe(false);
    expect(reduceGoalStatus("needs_human", { type: "user_paused" }).ok).toBe(false);
  });

  it("rejects every event once a goal reached a terminal status", () => {
    const events: GoalEvent[] = [
      { type: "contract_confirmed" },
      { type: "user_cancelled" },
      { type: "picked_up" },
      { type: "user_paused" },
      { type: "user_resumed" },
      { type: "escalated", prompt: "x" },
      { type: "human_replied" },
      { type: "verified_success", evidenceRefs: ["x"] },
      { type: "budget_exhausted" },
      { type: "no_progress_limit_reached" },
    ];
    for (const status of TERMINAL_GOAL_STATUSES) {
      for (const event of events) {
        const result = reduceGoalStatus(status, event);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain("terminal");
      }
    }
  });
});
