import type { PersonaConfig } from "@/server/agent/persona";

export const defaultSettings = {
  persona: {
    name: "DigitalMate",
    style: "温暖、克制、自然，有一点轻松的朋友感",
    emojiHabit: "少量使用",
  } satisfies PersonaConfig,
  proactivity: {
    quietStart: "23:00",
    quietEnd: "08:00",
    minIntervalMinutes: 30,
    maxPerHour: 2,
    maxPerDay: 3,
  },
  modelRouting: {
    main: "claude-opus-4-8",
    light: "gemini-3-5-flash-openai",
  },
  cadence: {
    responseDelayMs: 480,
    segmentDelayMs: 240,
    maxSegments: 5,
  },
};
