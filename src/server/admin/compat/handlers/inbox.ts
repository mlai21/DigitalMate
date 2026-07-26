import { z } from "zod";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import type {
  AdminInboxService,
  AdminInboxStatus,
} from "@/server/admin/views/inbox";

export type { AdminInboxService } from "@/server/admin/views/inbox";

const approvalBodySchema = z
  .object({
    request_id: z.string().uuid(),
    session_id: z.string().min(1).max(200),
    revision: z.number().int().positive().optional(),
    scope: z.enum(["exact", "similar"]).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
const accessEntrySchema = z
  .object({
    channel: z.string().trim().min(1).max(100),
    user_id: z.string().trim().min(1).max(500),
    remark: z.string().trim().max(500).optional(),
    username: z.string().trim().max(200).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
const accessEntriesBodySchema = z
  .object({
    entries: z.array(accessEntrySchema).min(1).max(100),
  })
  .strict();
const accessMetadataBodySchema = z
  .object({
    channel: z.string().trim().min(1).max(100),
    user_id: z.string().trim().min(1).max(500),
    remark: z.string().trim().max(500).optional(),
    username: z.string().trim().max(200).optional(),
  })
  .strict();
const readEventsBodySchema = z
  .object({
    event_ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.all === true ||
      (value.event_ids !== undefined && value.event_ids.length > 0),
    "read_target_required",
  );

export function createApprovalCommandHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const action = context.params.action;
    if (action !== "approve" && action !== "deny") {
      throw new AdminCompatError(
        400,
        "invalid_request",
        "invalid_approval_action",
      );
    }
    const body = approvalBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    try {
      const result = await service.resolveApproval(
        context.scope,
        {
          id: body.request_id,
          action,
          expectedRevision: body.revision ?? null,
          approvalScope: body.scope ?? null,
          reason: body.reason ?? null,
          confirmationSourceId: body.request_id,
        },
        context.signal,
      );
      return {
        success: true,
        message:
          result.status === "approved" ? "approved" : "denied",
        revision: result.revision,
      };
    } catch (error) {
      throw mapInboxError(error);
    }
  };
}

export function createCheckCommandHandler(): AdminCompatHandler {
  return async (context) => {
    const body = z
      .object({ text: z.string().max(10_000) })
      .strict()
      .parse(await readAdminCompatJson(context.request));
    const skills =
      await context.resources.skills.listEnabledForAgent(
        context.scope,
      );
    return {
      is_control_command: /^\/(?:approve|deny)\b/iu.test(
        body.text.trim(),
      ),
      command_token: null,
      commands: skills.map((skill) => ({
        command: `/${toCommandName(skill.name)}`,
        name: skill.name,
        description: skill.trigger,
        skill_id: skill.id,
      })),
    };
  };
}

function toCommandName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || "skill";
}

export function createListInboxHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const status = url.searchParams.get("status");
    const limit = readIntegerQuery(url, "limit", 20, 1, 200);
    try {
      return await service.listInbox(
        context.scope,
        {
          ...(isInboxStatus(status) ? { status } : {}),
          cursor: url.searchParams.get("cursor"),
          limit,
        },
        context.signal,
      );
    } catch (error) {
      throw mapInboxError(error);
    }
  };
}

export function createGetPushMessagesHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const sessionId = url.searchParams.get("session_id");
    const pendingApprovals = await service.listPendingApprovals(
      context.scope,
      sessionId,
      context.signal,
    );
    return {
      messages: [],
      pending_approvals: pendingApprovals,
    };
  };
}

export function createListInboxEventsHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const events = await service.listEvents(
      context.scope,
      {
        ...(url.searchParams.get("status")
          ? { status: url.searchParams.get("status")! }
          : {}),
        unreadOnly:
          url.searchParams.get("unread_only") === "true",
        limit: readIntegerQuery(url, "limit", 50, 1, 200),
        offset: readIntegerQuery(url, "offset", 0, 0, 10_000),
      },
      context.signal,
    );
    return { events };
  };
}

export function createMarkInboxReadHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const body = readEventsBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    const updated = await service.markEventsRead(
      context.scope,
      body.all === true ? null : body.event_ids ?? [],
      context.signal,
    );
    return { updated };
  };
}

export function createDeleteInboxEventHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const eventId = context.params.eventId;
    if (!eventId) throw invalidRequest("event_id_required");
    const deleted = await service.dismissEvent(
      context.scope,
      eventId,
      context.signal,
    );
    if (!deleted) throw notFound("inbox_event_not_found");
    return { deleted: true, trace_deleted: false, run_id: eventId };
  };
}

export function createGetInboxTraceHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) => {
    const runId = context.params.runId;
    if (!runId) throw invalidRequest("run_id_required");
    const trace = await service.getEventTrace(
      context.scope,
      runId,
      context.signal,
    );
    if (!trace) throw notFound("inbox_trace_not_found");
    return trace;
  };
}

export function createListAccessControlHandler(
  service: AdminInboxService,
  channelFromPath: boolean,
): AdminCompatHandler {
  return async (context) =>
    service.listAccessControl(
      context.scope,
      channelFromPath ? context.params.channel ?? null : null,
      context.signal,
    ).then((result) =>
      channelFromPath && context.params.channel
        ? result[context.params.channel] ?? {
            whitelist: {},
            blacklist: {},
            pending: [],
          }
        : result
    );
}

export function createListPendingAccessHandler(
  service: AdminInboxService,
): AdminCompatHandler {
  return async (context) =>
    service.listPendingAccess(context.scope, context.signal);
}

export function createMutateAccessRulesHandler(
  service: AdminInboxService,
  operation: "add" | "remove",
  effect: "allow" | "deny",
): AdminCompatHandler {
  return async (context) => {
    const body = accessEntriesBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    try {
      if (operation === "add") {
        await service.addAccessRules(
          context.scope,
          effect,
          body.entries,
          context.signal,
        );
      } else {
        await service.removeAccessRules(
          context.scope,
          effect,
          body.entries,
          context.signal,
        );
      }
      return { success: true };
    } catch (error) {
      throw mapInboxError(error);
    }
  };
}

export function createResolveAccessHandler(
  service: AdminInboxService,
  action: "approve" | "deny" | "dismiss",
): AdminCompatHandler {
  return async (context) => {
    const body = accessEntriesBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    try {
      await service.resolveAccessRequests(
        context.scope,
        action,
        body.entries,
        context.signal,
      );
      return { success: true };
    } catch (error) {
      throw mapInboxError(error);
    }
  };
}

export function createUpdateAccessMetadataHandler(
  service: AdminInboxService,
  field: "remark" | "username",
  pendingOnly: boolean,
): AdminCompatHandler {
  return async (context) => {
    const body = accessMetadataBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    const value = body[field];
    if (value === undefined) throw invalidRequest(`${field}_required`);
    try {
      await service.updateAccessMetadata(
        context.scope,
        {
          channel: body.channel,
          userId: body.user_id,
          field,
          value,
          pendingOnly,
        },
        context.signal,
      );
      return { success: true };
    } catch (error) {
      throw mapInboxError(error);
    }
  };
}

function mapInboxError(error: unknown): unknown {
  if (
    error instanceof Error &&
    Reflect.get(error, "code") === "revision_conflict"
  ) {
    const currentRevision = Reflect.get(error, "currentRevision");
    return new AdminCompatError(
      409,
      "config_revision_conflict",
      "revision_conflict",
      typeof currentRevision === "number"
        ? { current_revision: currentRevision }
        : undefined,
    );
  }
  if (
    error instanceof Error &&
    Reflect.get(error, "code") === "inbox_item_not_found"
  ) {
    return notFound("inbox_item_not_found");
  }
  if (
    error instanceof Error &&
    Reflect.get(error, "code") === "channel_not_found"
  ) {
    return notFound("channel_not_found");
  }
  if (
    error instanceof Error &&
    Reflect.get(error, "code") === "channel_connection_ambiguous"
  ) {
    return new AdminCompatError(
      409,
      "config_revision_conflict",
      "channel_connection_ambiguous",
    );
  }
  if (
    error instanceof Error &&
    (
      error.message === "invalid_inbox_cursor" ||
      error.message === "invalid_session_cursor"
    )
  ) {
    return invalidRequest("invalid_cursor");
  }
  return error;
}

function isInboxStatus(value: string | null): value is AdminInboxStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "dismissed"
  );
}

function readIntegerQuery(
  url: URL,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidRequest(`invalid_${key}`);
  }
  return value;
}

function invalidRequest(message: string): AdminCompatError {
  return new AdminCompatError(400, "invalid_request", message);
}

function notFound(message: string): AdminCompatError {
  return new AdminCompatError(404, "not_found", message);
}
