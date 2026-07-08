import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProactivityPresetForm } from "@/components/admin/proactivity-preset-form";

describe("ProactivityPresetForm", () => {
  it("renders a one-click low proactivity action", () => {
    render(<ProactivityPresetForm />);

    expect(screen.getByRole("button", { name: "降低主动程度" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("low")).toHaveAttribute("name", "proactivityPreset");
  });
});
