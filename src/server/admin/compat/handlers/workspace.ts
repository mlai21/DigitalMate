import { z } from "zod";

import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  normalizeVirtualFilePath,
  readVirtualFileRevision,
} from "@/server/admin/workspace/files";
import {
  AdminWorkspaceError,
  type AdminWorkspaceService,
} from "@/server/admin/workspace/service";

export type { AdminWorkspaceService } from "@/server/admin/workspace/service";

const canonicalUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const workspaceWriteSchema = z
  .object({
    content: z.string().min(1).max(32_000),
    operation_id: canonicalUuidSchema,
  })
  .strict();

export function createListWorkspaceFilesHandler(
  service: AdminWorkspaceService,
): AdminCompatHandler {
  return async (context) => {
    try {
      return await service.list(
        context.scope,
        context.signal,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  };
}

export function createGetWorkspaceFileHandler(
  service: AdminWorkspaceService,
): AdminCompatHandler {
  return async (context) => {
    try {
      return await service.read(
        context.scope,
        readPath(context.params.fileName),
        context.signal,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  };
}

export function createPutWorkspaceFileHandler(
  service: AdminWorkspaceService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const path = readPath(context.params.fileName);
      const body = workspaceWriteSchema.parse(
        await readAdminCompatJson(context.request),
      );
      const expectedRevision = readVirtualFileRevision(
        path,
        body.content,
      );
      return await service.write(
        context.scope,
        path,
        {
          content: body.content,
          expectedRevision,
          operationId: body.operation_id,
        },
        context.signal,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  };
}

export function createDownloadWorkspaceHandler(
  service: AdminWorkspaceService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const payload = await service.download(
        context.scope,
        context.signal,
      );
      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition":
            'attachment; filename="digitalmate-workspace.json"',
        },
      });
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  };
}

export function createGetWorkspacePromptFilesHandler(): AdminCompatHandler {
  return async () => ["AGENT.md", "PROACTIVITY.md"];
}

export function createWatchWorkspaceHandler(
  service: AdminWorkspaceService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const files = await service.list(
        context.scope,
        context.signal,
      );
      const event = JSON.stringify({
        type: "snapshot",
        files: files.map((file) => ({
          path: file.path,
          modified_time: file.modified_time,
        })),
      });
      return new Response(
        `event: snapshot\ndata: ${event}\n\n`,
        {
          status: 200,
          headers: {
            "content-type":
              "text/event-stream; charset=utf-8",
          },
        },
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  };
}

function readPath(value: string | undefined) {
  try {
    return normalizeVirtualFilePath(value ?? "");
  } catch {
    throw new AdminCompatError(
      404,
      "not_found",
      "virtual_file_not_found",
    );
  }
}

function mapWorkspaceError(error: unknown): unknown {
  if (error instanceof AdminCompatError) return error;
  if (
    error instanceof Error &&
    error.message === "virtual_file_invalid_format"
  ) {
    return new AdminCompatError(
      400,
      "invalid_request",
      "virtual_file_invalid_format",
    );
  }
  if (
    error instanceof Error &&
    error.message === "virtual_file_read_only"
  ) {
    return new AdminCompatError(
      405,
      "method_not_allowed",
      "virtual_file_read_only",
    );
  }
  if (error instanceof AdminWorkspaceError) {
    return new AdminCompatError(
      error.status,
      workspacePublicCode(error),
      error.code,
    );
  }
  return error;
}

function workspacePublicCode(
  error: AdminWorkspaceError,
): string {
  switch (error.status) {
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    default:
      return error.code;
  }
}
