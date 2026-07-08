import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillStatusActions, ToolRegistrationStatusActions } from "@/components/admin/status-actions";

describe("admin status actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for explicit confirmation before enabling pending capabilities", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <SkillStatusActions skillId="skill-1" status="pending" />
        <ToolRegistrationStatusActions toolId="tool-1" status="pending" />
      </>,
    );

    const enableButtons = screen.getAllByRole("button", { name: "启用" });

    expect(fireEvent.click(enableButtons[0])).toBe(false);
    expect(fireEvent.click(enableButtons[1])).toBe(false);
    expect(confirm).toHaveBeenNthCalledWith(1, "确定启用这个 Skill 吗？启用后 DigitalMate 会在后续对话中参考它。");
    expect(confirm).toHaveBeenNthCalledWith(2, "确定启用这个工具吗？启用后 Agent 可在后台调用它。");
  });

  it("lets enabled Skills and tools be disabled from the admin UI", () => {
    render(
      <>
        <SkillStatusActions skillId="skill-1" status="enabled" />
        <ToolRegistrationStatusActions toolId="tool-1" status="enabled" />
      </>,
    );

    expect(screen.getAllByRole("button", { name: "停用" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "停用" })[0]).toHaveAttribute("name", "status");
    expect(screen.getAllByRole("button", { name: "停用" })[0]).toHaveAttribute("value", "disabled");
  });

  it("lets disabled Skills and tools be re-enabled", () => {
    render(
      <>
        <SkillStatusActions skillId="skill-1" status="disabled" />
        <ToolRegistrationStatusActions toolId="tool-1" status="disabled" />
      </>,
    );

    expect(screen.getAllByRole("button", { name: "重新启用" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "重新启用" })[0]).toHaveAttribute("value", "enabled");
  });
});
