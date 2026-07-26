import { z } from "zod";

import type { AgentScope } from "@/server/agents/types";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import type { AdminCompatHandler } from "@/server/admin/compat/types";
import {
  CHANNEL_TYPES,
  type ChannelType,
} from "@/server/channels/manifests/catalog";

const uuidSchema = z.string().uuid();
const enrollmentSchema = z.object({
  display_name: z.string().trim().min(1).max(128),
  supported_channel_types: z
    .array(z.enum(CHANNEL_TYPES))
    .min(1)
    .max(CHANNEL_TYPES.length)
    .refine(
      (values) => new Set(values).size === values.length,
      "duplicate_channel_type",
    ),
  connection_ids: z
    .array(uuidSchema)
    .min(1)
    .max(256)
    .refine(
      (values) => new Set(values).size === values.length,
      "duplicate_connection_id",
    )
    .optional(),
}).strict();
const bindingSchema = z.object({
  connection_id: uuidSchema,
}).strict();

export type AdminChannelNodeSummary = Readonly<{
  id: string;
  display_name: string;
  status: "connected" | "disconnected" | "revoked";
  supported_channel_types: readonly ChannelType[];
  bound_connection_ids: readonly string[];
  client_version: string | null;
  certificate_expires_at: string | null;
  last_heartbeat_at: string | null;
  outbox: Readonly<{
    pending_items: number;
    pending_bytes: number;
  }>;
}>;

export type AdminChannelNodeEncryptedBundle = Readonly<{
  format: "digitalmate-channel-node-v1";
  algorithm: "A256GCM";
  salt: string;
  iv: string;
  ciphertext: string;
  auth_tag: string;
}>;

export type AdminChannelNodeEnrollment = Readonly<{
  enrollment_id: string;
  node_id: string;
  token: string;
  expires_at: string;
  bundle: AdminChannelNodeEncryptedBundle;
}>;

export type AdminChannelNodeScopeInput = Readonly<{
  scope: AgentScope;
  nodeId: string;
}>;

export type AdminChannelNodeBindingInput =
  AdminChannelNodeScopeInput & Readonly<{
    connectionId: string;
  }>;

export type AdminChannelNodeService = Readonly<{
  list(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<readonly AdminChannelNodeSummary[]>;
  createEnrollment(
    input: Readonly<{
      scope: AgentScope;
      displayName: string;
      supportedChannelTypes: readonly ChannelType[];
      connectionIds?: readonly string[];
    }>,
    signal?: AbortSignal,
  ): Promise<AdminChannelNodeEnrollment>;
  bind(
    input: AdminChannelNodeBindingInput,
    signal?: AbortSignal,
  ): Promise<void>;
  unbind(
    input: AdminChannelNodeBindingInput,
    signal?: AbortSignal,
  ): Promise<void>;
  rotateCertificate(
    input: AdminChannelNodeScopeInput,
    signal?: AbortSignal,
  ): Promise<AdminChannelNodeEnrollment>;
  revoke(
    input: AdminChannelNodeScopeInput,
    signal?: AbortSignal,
  ): Promise<void>;
}>;

export function createListChannelNodesHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) =>
    service.list(context.scope, context.signal);
}

export function createChannelNodeEnrollmentHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) => {
    const body = enrollmentSchema.parse(
      await readAdminCompatJson(context.request),
    );
    return service.createEnrollment(
      {
        scope: context.scope,
        displayName: body.display_name,
        supportedChannelTypes:
          body.supported_channel_types as readonly ChannelType[],
        ...(body.connection_ids
          ? { connectionIds: body.connection_ids }
          : {}),
      },
      context.signal,
    );
  };
}

export function createBindChannelNodeHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) => {
    const nodeId = uuidSchema.parse(context.params.nodeId);
    const body = bindingSchema.parse(
      await readAdminCompatJson(context.request),
    );
    await service.bind(
      {
        scope: context.scope,
        nodeId,
        connectionId: body.connection_id,
      },
      context.signal,
    );
    return { updated: true };
  };
}

export function createUnbindChannelNodeHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) => {
    const nodeId = uuidSchema.parse(context.params.nodeId);
    const connectionId = uuidSchema.parse(
      context.params.connectionId,
    );
    // DELETE requests may carry an empty object from the Console, but it
    // is intentionally ignored: both scope identifiers live in the path.
    await service.unbind(
      { scope: context.scope, nodeId, connectionId },
      context.signal,
    );
    return { updated: true };
  };
}

export function createRotateChannelNodeCertificateHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) =>
    service.rotateCertificate(
      {
        scope: context.scope,
        nodeId: uuidSchema.parse(context.params.nodeId),
      },
      context.signal,
    );
}

export function createRevokeChannelNodeHandler(
  service: AdminChannelNodeService,
): AdminCompatHandler {
  return async (context) => {
    await service.revoke(
      {
        scope: context.scope,
        nodeId: uuidSchema.parse(context.params.nodeId),
      },
      context.signal,
    );
    return { updated: true };
  };
}
