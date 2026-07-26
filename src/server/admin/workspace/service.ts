import packageJson from "../../../../package.json";
import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  AdminAgentProfileError,
  createAdminAgentProfileService,
  type AdminAgentProfileSnapshot,
} from "@/server/admin/agent-profile";
import {
  CHANNEL_TYPES,
} from "@/server/channels/manifests/catalog";
import {
  VIRTUAL_FILES,
  normalizeVirtualFilePath,
  parseAgentVirtualFile,
  parseProactivityVirtualFile,
  serializeAgentVirtualFile,
  serializeProactivityVirtualFile,
  type VirtualFilePath,
} from "@/server/admin/workspace/files";

export type AdminWorkspaceFile = Readonly<{
  filename: string;
  path: VirtualFilePath;
  size: number;
  created_time: string;
  modified_time: string;
  writable: boolean;
  source: string;
}>;

export type AdminWorkspaceFileContent = Readonly<{
  filename: string;
  path: VirtualFilePath;
  content: string;
  writable: boolean;
  source: string;
  revision: number;
}>;

export type AdminWorkspaceWriteInput = Readonly<{
  content: string;
  expectedRevision: number;
  operationId: string;
}>;

export type AdminWorkspaceService = Readonly<{
  list(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<readonly AdminWorkspaceFile[]>;
  read(
    scope: AgentScope,
    path: VirtualFilePath,
    signal?: AbortSignal,
  ): Promise<AdminWorkspaceFileContent>;
  write(
    scope: AgentScope,
    path: VirtualFilePath,
    input: AdminWorkspaceWriteInput,
    signal?: AbortSignal,
  ): Promise<AdminWorkspaceFileContent>;
  download(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    source: "database_projection";
    files: readonly Readonly<{
      path: VirtualFilePath;
      content: string;
      writable: boolean;
    }>[];
  }>>;
}>;

type WorkspaceChannelRow = Readonly<{
  channel_type: string;
  display_name: string;
  enabled: boolean;
  health_status: string;
  updated_at: Date;
}>;

type WorkspaceSnapshot = Readonly<{
  profile: AdminAgentProfileSnapshot;
  channels: readonly WorkspaceChannelRow[];
  createdAt: Date;
  modifiedAt: Date;
}>;

export class AdminWorkspaceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminWorkspaceError";
    this.status = status;
    this.code = code;
  }
}

export function createPostgresAdminWorkspaceService(
  pool: Pool,
): AdminWorkspaceService {
  const profileService = createAdminAgentProfileService(pool);

  async function loadSnapshot(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    signal?.throwIfAborted();
    try {
      const [profile, metadata, channels] = await Promise.all([
        profileService.read(scope, signal),
        pool.query<{
          created_at: Date;
          modified_at: Date;
        }>(
          `SELECT digital_agents.created_at,
                  GREATEST(
                    digital_agents.updated_at,
                    agent_settings.updated_at
                  ) AS modified_at
           FROM digital_agents
           JOIN agent_settings
             ON agent_settings.user_id = digital_agents.user_id
            AND agent_settings.agent_id = digital_agents.id
           WHERE digital_agents.user_id = $1
             AND digital_agents.id = $2
             AND digital_agents.status = 'active'`,
          [scope.userId, scope.agentId],
        ),
        pool.query<WorkspaceChannelRow>(
          `SELECT channel_type, display_name, enabled,
                  health_status, updated_at
           FROM channel_connections
           WHERE user_id = $1
             AND agent_id = $2
             AND deleted_at IS NULL
           ORDER BY channel_type, display_name, id`,
          [scope.userId, scope.agentId],
        ),
      ]);
      signal?.throwIfAborted();
      const now = new Date();
      return {
        profile,
        channels: channels.rows,
        createdAt: metadata.rows[0]?.created_at ?? now,
        modifiedAt: maxDate([
          metadata.rows[0]?.modified_at,
          ...channels.rows.map((row) => row.updated_at),
        ]) ?? now,
      };
    } catch (error) {
      throw mapProfileError(error);
    }
  }

  return {
    async list(scope, signal) {
      const snapshot = await loadSnapshot(scope, signal);
      return (Object.keys(VIRTUAL_FILES) as VirtualFilePath[]).map(
        (path) => {
          const content = renderVirtualFile(path, snapshot);
          const definition = VIRTUAL_FILES[path];
          return {
            filename: definition.filename,
            path,
            size: Buffer.byteLength(content, "utf8"),
            created_time: snapshot.createdAt.toISOString(),
            modified_time: snapshot.modifiedAt.toISOString(),
            writable: definition.writable,
            source: definition.source,
          };
        },
      );
    },

    async read(scope, path, signal) {
      const normalized = normalizeVirtualFilePath(path);
      const snapshot = await loadSnapshot(scope, signal);
      return projectContent(normalized, snapshot);
    },

    async write(scope, path, input, signal) {
      const normalized = normalizeVirtualFilePath(path);
      const definition = VIRTUAL_FILES[normalized];
      if (!definition.writable) {
        throw new AdminWorkspaceError(
          405,
          "virtual_file_read_only",
        );
      }
      signal?.throwIfAborted();
      const profile = await profileService
        .read(scope, signal)
        .catch((error) => {
          throw mapProfileError(error);
        });

      try {
        if (normalized === "/AGENT.md") {
          const parsed = parseAgentVirtualFile(input.content);
          if (parsed.revision !== input.expectedRevision) {
            throw new AdminWorkspaceError(
              409,
              "revision_conflict",
            );
          }
          await profileService.update(
            {
              scope,
              operationId: input.operationId,
              expectedRevision: input.expectedRevision,
              displayName: parsed.displayName,
              persona: parsed.persona,
              settings: {
                proactivity: profile.proactivity,
                cadence: profile.cadence,
                search: profile.search,
              },
            },
            signal,
          );
        } else {
          const parsed = parseProactivityVirtualFile(
            input.content,
          );
          if (parsed.revision !== input.expectedRevision) {
            throw new AdminWorkspaceError(
              409,
              "revision_conflict",
            );
          }
          await profileService.update(
            {
              scope,
              operationId: input.operationId,
              expectedRevision: input.expectedRevision,
              displayName: profile.displayName,
              persona: profile.persona,
              settings: {
                proactivity: parsed.proactivity,
                cadence: profile.cadence,
                search: profile.search,
              },
            },
            signal,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "virtual_file_invalid_format"
        ) {
          throw new AdminWorkspaceError(
            400,
            "virtual_file_invalid_format",
          );
        }
        throw mapProfileError(error);
      }
      return projectContent(
        normalized,
        await loadSnapshot(scope, signal),
      );
    },

    async download(scope, signal) {
      const snapshot = await loadSnapshot(scope, signal);
      return {
        source: "database_projection",
        files: (
          Object.keys(VIRTUAL_FILES) as VirtualFilePath[]
        ).map((path) => ({
          path,
          content: renderVirtualFile(path, snapshot),
          writable: VIRTUAL_FILES[path].writable,
        })),
      };
    },
  };
}

function projectContent(
  path: VirtualFilePath,
  snapshot: WorkspaceSnapshot,
): AdminWorkspaceFileContent {
  const definition = VIRTUAL_FILES[path];
  return {
    filename: definition.filename,
    path,
    content: renderVirtualFile(path, snapshot),
    writable: definition.writable,
    source: definition.source,
    revision: snapshot.profile.revision,
  };
}

function renderVirtualFile(
  path: VirtualFilePath,
  snapshot: WorkspaceSnapshot,
): string {
  switch (path) {
    case "/AGENT.md":
      return serializeAgentVirtualFile({
        revision: snapshot.profile.revision,
        displayName: snapshot.profile.displayName,
        persona: snapshot.profile.persona,
      });
    case "/PROACTIVITY.md":
      return serializeProactivityVirtualFile({
        revision: snapshot.profile.revision,
        proactivity: snapshot.profile.proactivity,
      });
    case "/CHANNELS.md":
      return renderChannels(snapshot.channels);
    case "/RUNTIME.json":
      return JSON.stringify(
        {
          product: "DigitalMate",
          version: packageJson.version,
          agent_id: snapshot.profile.id,
          active_agents: 1,
          workspace_source: "database_projection",
          memory_source: "postgresql_pgvector",
          p2_execution: "frozen",
          channels_supported: CHANNEL_TYPES.length,
        },
        null,
        2,
      );
  }
}

function renderChannels(
  channels: readonly WorkspaceChannelRow[],
): string {
  const rows = channels.map((channel) =>
    [
      escapeMarkdownCell(channel.channel_type),
      escapeMarkdownCell(channel.display_name),
      channel.enabled ? "enabled" : "disabled",
      escapeMarkdownCell(channel.health_status),
    ].join(" | "),
  );
  return [
    "# DigitalMate Channels",
    "",
    "This file is a read-only database projection. Credentials and raw configuration are never included.",
    "",
    "type | name | state | health",
    "--- | --- | --- | ---",
    ...(rows.length > 0
      ? rows
      : ["- | No configured channels | disabled | disabled"]),
    "",
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\|/gu, "\\|")
    .slice(0, 200);
}

function maxDate(
  values: readonly (Date | null | undefined)[],
): Date | null {
  const timestamps = values
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime())
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps));
}

function mapProfileError(error: unknown): unknown {
  if (error instanceof AdminWorkspaceError) return error;
  if (error instanceof AdminAgentProfileError) {
    return new AdminWorkspaceError(error.status, error.code);
  }
  return error;
}
