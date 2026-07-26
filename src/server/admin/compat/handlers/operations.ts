import { z } from "zod";

import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import type {
  AdminDateRange,
  AdminOperationsService,
  AdminTokenUsageFilters,
} from "@/server/admin/views/stats";

export type { AdminOperationsService };

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u);
const filterSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}._:/-]+$/u);

export function createGetAgentStatsHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getAgentStats(
      context.scope,
      readDateRange(context.request),
      context.signal,
    );
}

export function createGetTokenUsageHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getTokenUsage(
      context.scope,
      readUsageFilters(context.request),
      context.signal,
    );
}

export function createGetTokenUsageDetailsHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getTokenUsageDetails(
      context.scope,
      readUsageFilters(context.request),
      context.signal,
    );
}

export function createGetEnvironmentHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getEnvironment(context.scope, context.signal);
}

export function createGetAgentHealthHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getAgentHealth(context.scope, context.signal);
}

export function createGetBackendDebugLogsHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) => {
    const rawLines = new URL(
      context.request.url,
    ).searchParams.get("lines");
    const lines =
      rawLines === null
        ? 200
        : z.coerce
            .number()
            .int()
            .min(1)
            .max(1_000)
            .parse(rawLines);
    return service.getDebugLogs(
      context.scope,
      lines,
      context.signal,
    );
  };
}

export function createGetVoiceOverviewHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) =>
    service.getVoiceOverview(context.scope, context.signal);
}

export function createGetAudioModeHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) => ({
    audio_mode: "auto",
    digitalmate: await service.getVoiceOverview(
      context.scope,
      context.signal,
    ),
  });
}

export function createGetTranscriptionProvidersHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) => ({
    providers: [],
    configured_provider_id: "",
    enabled: false,
    reason: "audio_attachment_not_supported",
    digitalmate: await service.getVoiceOverview(
      context.scope,
      context.signal,
    ),
  });
}

export function createGetTranscriptionProviderTypeHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) => {
    await service.getVoiceOverview(
      context.scope,
      context.signal,
    );
    return {
      transcription_provider_type: "disabled",
      enabled: false,
      reason: "audio_attachment_not_supported",
    };
  };
}

export function createGetLocalWhisperStatusHandler(
  service: AdminOperationsService,
): AdminCompatHandler {
  return async (context) => {
    await service.getVoiceOverview(
      context.scope,
      context.signal,
    );
    return {
      available: false,
      ffmpeg_installed: false,
      whisper_installed: false,
      enabled: false,
      reason: "local_models_disabled",
    };
  };
}

function readUsageFilters(
  request: Request,
): AdminTokenUsageFilters {
  const range = readDateRange(request);
  const searchParams = new URL(request.url).searchParams;
  const model = parseFilter(searchParams.get("model"));
  const provider = parseFilter(
    searchParams.get("provider"),
  );
  return {
    ...range,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function readDateRange(request: Request): AdminDateRange {
  const searchParams = new URL(request.url).searchParams;
  const today = new Date();
  const fallbackEnd = formatUtcDate(today);
  const fallbackStart = formatUtcDate(
    new Date(today.getTime() - 29 * 86_400_000),
  );
  const startDate = parseDate(
    searchParams.get("start_date") ?? fallbackStart,
  );
  const endDate = parseDate(
    searchParams.get("end_date") ?? fallbackEnd,
  );
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (
    start > end ||
    end - start > 366 * 86_400_000
  ) {
    throw new AdminCompatError(
      400,
      "invalid_date_range",
      "invalid_date_range",
    );
  }
  return { startDate, endDate };
}

function parseDate(value: string): string {
  const parsed = dateSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminCompatError(
      400,
      "invalid_date_range",
      "invalid_date_range",
    );
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    formatUtcDate(date) !== value
  ) {
    throw new AdminCompatError(
      400,
      "invalid_date_range",
      "invalid_date_range",
    );
  }
  return value;
}

function parseFilter(
  value: string | null,
): string | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = filterSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminCompatError(
      400,
      "invalid_filter",
      "invalid_filter",
    );
  }
  return parsed.data;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
