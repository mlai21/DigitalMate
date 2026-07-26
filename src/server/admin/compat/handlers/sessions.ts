import { z } from "zod";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import type { AdminSessionsService } from "@/server/admin/views/sessions";

export type { AdminSessionsService } from "@/server/admin/views/sessions";

const sessionIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100);
const batchArchiveSchema = z
  .object({ chat_ids: sessionIdsSchema })
  .strict();
const updateSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.pinned !== undefined,
    "session_update_required",
  );

export function createListSessionsHandler(
  service: AdminSessionsService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const archived = readOptionalBoolean(url, "archived");
    try {
      const page = await service.listSessions(
        context.scope,
        {
          cursor: url.searchParams.get("cursor"),
          limit: readLimit(url),
          ...(url.searchParams.get("channel")
            ? { channel: url.searchParams.get("channel")! }
            : {}),
          ...(archived !== undefined ? { archived } : {}),
        },
        context.signal,
      );
      return page.items;
    } catch (error) {
      throw mapSessionError(error);
    }
  };
}

export function createGetSessionHandler(
  service: AdminSessionsService,
): AdminCompatHandler {
  return async (context) => {
    const sessionId = readSessionId(context.params.chatId);
    const session = await service.getSession(
      context.scope,
      sessionId,
      context.signal,
    );
    if (!session) throw sessionNotFound();
    return session;
  };
}

export function createUpdateSessionHandler(
  service: AdminSessionsService,
): AdminCompatHandler {
  return async (context) => {
    const sessionId = readSessionId(context.params.chatId);
    const body = updateSessionSchema.parse(
      await readAdminCompatJson(context.request),
    );
    const updated = await service.updateSession(
      context.scope,
      sessionId,
      body,
      context.signal,
    );
    if (!updated) throw sessionNotFound();
    return updated;
  };
}

export function createDeleteSessionHandler(
  service: AdminSessionsService,
): AdminCompatHandler {
  return async (context) => {
    const sessionId = readSessionId(context.params.chatId);
    const deleted = await service.deleteSession(
      context.scope,
      sessionId,
      context.signal,
    );
    if (!deleted) throw sessionNotFound();
    return {
      success: true,
      chat_id: sessionId,
    };
  };
}

export function createBatchDeleteSessionsHandler(
  service: AdminSessionsService,
): AdminCompatHandler {
  return async (context) => {
    const sessionIds = sessionIdsSchema.parse(
      await readAdminCompatJson(context.request),
    );
    const deleted = await service.batchDeleteSessions(
      context.scope,
      sessionIds,
      context.signal,
    );
    return {
      success: true,
      deleted_count: deleted,
    };
  };
}

export function createSetSessionArchivedHandler(
  service: AdminSessionsService,
  archived: boolean,
): AdminCompatHandler {
  return async (context) => {
    const sessionId = readSessionId(context.params.chatId);
    const updated = await service.setArchived(
      context.scope,
      sessionId,
      archived,
      context.signal,
    );
    if (!updated) throw sessionNotFound();
    return updated;
  };
}

export function createBatchSetSessionsArchivedHandler(
  service: AdminSessionsService,
  archived: boolean,
): AdminCompatHandler {
  return async (context) => {
    const body = batchArchiveSchema.parse(
      await readAdminCompatJson(context.request),
    );
    return service.batchSetArchived(
      context.scope,
      body.chat_ids,
      archived,
      context.signal,
    );
  };
}

function readSessionId(value: string | undefined): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "session_id_required",
    );
  }
  return result.data;
}

function readOptionalBoolean(
  url: URL,
  key: string,
): boolean | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AdminCompatError(
    400,
    "invalid_request",
    `invalid_${key}`,
  );
}

function readLimit(url: URL): number {
  const value = url.searchParams.get("limit");
  if (value === null) return 1_000;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 1_000
  ) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_limit",
    );
  }
  return parsed;
}

function mapSessionError(error: unknown): unknown {
  if (
    error instanceof Error &&
    error.message === "invalid_session_cursor"
  ) {
    return new AdminCompatError(
      400,
      "invalid_request",
      "invalid_cursor",
    );
  }
  return error;
}

function sessionNotFound(): AdminCompatError {
  return new AdminCompatError(
    404,
    "not_found",
    "session_not_found",
  );
}
