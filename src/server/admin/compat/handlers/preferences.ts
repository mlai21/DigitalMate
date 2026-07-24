import { z } from "zod";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";

export const supportedConsoleLanguages = [
  "en",
  "zh",
  "ja",
  "ru",
  "pt-BR",
  "id",
  "vi",
] as const;

const revisionSchema = z.number().int().positive().optional();
const languageBodySchema = z
  .object({
    language: z.enum(supportedConsoleLanguages),
    revision: revisionSchema,
  })
  .strict();
const timezoneBodySchema = z
  .object({
    timezone: z.string().trim().min(1).max(128),
    revision: revisionSchema,
  })
  .strict();

export const getLanguage: AdminCompatHandler = async ({
  resources,
  scope,
}) => {
  const preferences = await resources.userPreferences.get(scope.userId);
  return {
    language: preferences.language,
    revision: preferences.revision,
  };
};

export const putLanguage: AdminCompatHandler = async ({
  request,
  resources,
  scope,
}) => {
  const input = languageBodySchema.parse(await readJson(request));
  const current = await resources.userPreferences.get(scope.userId);
  const updated = await resources.userPreferences.update(scope.userId, {
    language: input.language,
    timezone: current.timezone,
    expectedRevision: input.revision ?? current.revision,
  });
  return {
    language: updated.language,
    revision: updated.revision,
  };
};

export const getUserTimezone: AdminCompatHandler = async ({
  resources,
  scope,
}) => {
  const preferences = await resources.userPreferences.get(scope.userId);
  return {
    timezone: preferences.timezone,
    revision: preferences.revision,
  };
};

export const putUserTimezone: AdminCompatHandler = async ({
  request,
  resources,
  scope,
}) => {
  const input = timezoneBodySchema.parse(await readJson(request));
  const timezone = normalizeIanaTimezone(input.timezone);
  if (!timezone) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_timezone",
    );
  }
  const current = await resources.userPreferences.get(scope.userId);
  const updated = await resources.userPreferences.update(scope.userId, {
    language: current.language,
    timezone,
    expectedRevision: input.revision ?? current.revision,
  });
  return {
    timezone: updated.timezone,
    revision: updated.revision,
  };
};

export function normalizeIanaTimezone(value: string): string | null {
  const timezone = value.trim();
  if (
    timezone !== "UTC" &&
    !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_.+-]+)+$/.test(timezone)
  ) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_json",
    );
  }
}
