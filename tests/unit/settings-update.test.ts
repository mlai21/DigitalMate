import { describe, expect, it } from "vitest";
import { buildSettingsUpdate } from "@/server/settings/update";

describe("buildSettingsUpdate", () => {
  it("applies a low proactivity preset without resetting unrelated settings", () => {
    const current = {
      persona: { name: "Mate", style: "自然", emojiHabit: "少量" },
      proactivity: {
        quietStart: "23:00",
        quietEnd: "08:00",
        maxPerDay: 5,
        maxPerHour: 3,
        minIntervalMinutes: 30,
      },
      modelRouting: { main: "custom-main", light: "custom-light" },
      cadence: { responseDelayMs: 400, segmentDelayMs: 120, maxSegments: 4 },
      search: { aggressiveness: "conservative" as const },
    };
    const form = new FormData();
    form.set("proactivityPreset", "low");

    expect(buildSettingsUpdate(current, form)).toEqual({
      ...current,
      proactivity: {
        quietStart: "22:30",
        quietEnd: "09:00",
        maxPerDay: 1,
        maxPerHour: 1,
        minIntervalMinutes: 180,
      },
      search: {
        aggressiveness: "conservative",
      },
    });
  });

  it("updates the channel first-response delay with other cadence settings", () => {
    const current = {
      persona: { name: "Mate", style: "自然", emojiHabit: "少量" },
      proactivity: {
        quietStart: "23:00",
        quietEnd: "08:00",
        maxPerDay: 5,
        maxPerHour: 3,
        minIntervalMinutes: 30,
      },
      modelRouting: { main: "custom-main", light: "custom-light" },
      cadence: { responseDelayMs: 400, segmentDelayMs: 120, maxSegments: 4 },
      search: { aggressiveness: "conservative" as const },
    };
    const form = new FormData();
    form.set("responseDelayMs", "650");
    form.set("segmentDelayMs", "180");
    form.set("maxSegments", "3");

    expect(buildSettingsUpdate(current, form).cadence).toEqual({
      responseDelayMs: 650,
      segmentDelayMs: 180,
      maxSegments: 3,
    });
  });

  it("updates the search aggressiveness tier and rejects unknown values", () => {
    const current = {
      persona: { name: "Mate", style: "自然", emojiHabit: "少量" },
      proactivity: {
        quietStart: "23:00",
        quietEnd: "08:00",
        maxPerDay: 5,
        maxPerHour: 3,
        minIntervalMinutes: 30,
      },
      modelRouting: { main: "custom-main", light: "custom-light" },
      cadence: { responseDelayMs: 400, segmentDelayMs: 120, maxSegments: 4 },
      search: { aggressiveness: "conservative" as const },
    };

    const offForm = new FormData();
    offForm.set("searchAggressiveness", "off");
    expect(buildSettingsUpdate(current, offForm).search).toEqual({ aggressiveness: "off" });

    const bogusForm = new FormData();
    bogusForm.set("searchAggressiveness", "yolo");
    expect(buildSettingsUpdate(current, bogusForm).search).toEqual({ aggressiveness: "conservative" });
  });
});
