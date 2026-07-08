import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";

describe("ConfirmSubmitButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for confirmation before allowing a destructive submit", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConfirmSubmitButton confirmMessage="确定删除这条记忆吗？">删除</ConfirmSubmitButton>);

    const clickAllowed = fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(clickAllowed).toBe(false);
    expect(confirm).toHaveBeenCalledWith("确定删除这条记忆吗？");
  });

  it("keeps the danger affordance for destructive actions", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConfirmSubmitButton confirmMessage="确定清空全部个人数据吗？">清空个人数据</ConfirmSubmitButton>);

    const button = screen.getByRole("button", { name: "清空个人数据" });

    expect(button).toHaveClass("danger-button");
    expect(button).toHaveAttribute("type", "submit");
    expect(fireEvent.click(button)).toBe(true);
    expect(confirm).toHaveBeenCalledWith("确定清空全部个人数据吗？");
  });
});
