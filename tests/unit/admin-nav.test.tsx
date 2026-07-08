import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminNav } from "@/components/admin/admin-nav";

describe("AdminNav", () => {
  it("links to interjection decision logs", () => {
    render(<AdminNav />);

    expect(screen.getByRole("link", { name: "插话决策" })).toHaveAttribute("href", "/admin/interjections");
  });
});
