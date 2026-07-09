import { normalizeSearchAggressiveness } from "@/server/agent/search-gate";
import { defaultSettings } from "@/server/settings/defaults";

export type AppSettings = typeof defaultSettings;

type ProactivityPreset = "low";

export function buildSettingsUpdate(current: AppSettings, form: FormData): AppSettings {
  const preset = String(form.get("proactivityPreset") ?? "");

  return {
    persona: {
      name: fieldString(form, "name", current.persona.name),
      style: fieldString(form, "style", current.persona.style),
      emojiHabit: fieldString(form, "emojiHabit", current.persona.emojiHabit ?? ""),
    },
    proactivity: preset
      ? applyProactivityPreset(current.proactivity, preset as ProactivityPreset)
      : {
          quietStart: fieldString(form, "quietStart", current.proactivity.quietStart),
          quietEnd: fieldString(form, "quietEnd", current.proactivity.quietEnd),
          maxPerDay: fieldNumber(form, "maxPerDay", current.proactivity.maxPerDay),
          maxPerHour: fieldNumber(form, "maxPerHour", current.proactivity.maxPerHour),
          minIntervalMinutes: fieldNumber(form, "minIntervalMinutes", current.proactivity.minIntervalMinutes),
        },
    modelRouting: {
      main: fieldString(form, "modelMain", current.modelRouting.main),
      light: fieldString(form, "modelLight", current.modelRouting.light),
    },
    cadence: {
      responseDelayMs: fieldNumber(form, "responseDelayMs", current.cadence.responseDelayMs),
      segmentDelayMs: fieldNumber(form, "segmentDelayMs", current.cadence.segmentDelayMs),
      maxSegments: fieldNumber(form, "maxSegments", current.cadence.maxSegments),
    },
    search: {
      aggressiveness: normalizeSearchAggressiveness(
        fieldString(form, "searchAggressiveness", current.search?.aggressiveness ?? "conservative"),
      ),
    },
  };
}

function applyProactivityPreset(current: AppSettings["proactivity"], preset: ProactivityPreset): AppSettings["proactivity"] {
  if (preset === "low") {
    return {
      ...current,
      quietStart: "22:30",
      quietEnd: "09:00",
      maxPerDay: 1,
      maxPerHour: 1,
      minIntervalMinutes: 180,
    };
  }
  return current;
}

function fieldString(form: FormData, name: string, fallback: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value;
}

function fieldNumber(form: FormData, name: string, fallback: number): number {
  const raw = form.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
