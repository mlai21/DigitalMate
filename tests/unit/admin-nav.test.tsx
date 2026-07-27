import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminNav } from "@/components/admin/admin-nav";

describe("AdminNav", () => {
  it("keeps legacy navigation isolated and links back to the new Console", () => {
    render(<AdminNav />);

    expect(screen.getByRole("link", { name: "概览" })).toHaveAttribute(
      "href",
      "/admin-legacy",
    );
    expect(screen.getByRole("link", { name: "插话决策" })).toHaveAttribute(
      "href",
      "/admin-legacy/interjections",
    );
    expect(screen.getByRole("link", { name: "返回新控制台" })).toHaveAttribute(
      "href",
      "/admin",
    );
  });
});
