import type { createRepositories } from "@/server/db/repositories";
import type { AgentScope } from "@/server/agents/types";

export type AdminCompatResources = ReturnType<typeof createRepositories>;

export type AdminCompatErrorBody = Readonly<{
  error: Readonly<{
    code: string;
    message: string;
    details?: unknown;
  }>;
}>;

export type AdminCompatContext = Readonly<{
  request: Request;
  params: Readonly<Record<string, string>>;
  scope: AgentScope;
  csrfVerified: boolean;
  resources: AdminCompatResources;
  signal: AbortSignal;
}>;

export type AdminCompatHandler = (
  context: AdminCompatContext,
) => Promise<Response | unknown>;

export type AdminCompatSessionContext = Readonly<{
  request: Request;
  params: Readonly<Record<string, string>>;
  userId: string;
  csrfVerified: boolean;
}>;

export type AdminCompatSessionHandler = (
  context: AdminCompatSessionContext,
) => Promise<Response | unknown>;

export type AdminCompatStatusHandler = (
  request: Request,
) => Promise<Response | unknown>;

export class AdminCompatError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    publicMessage: string,
    details?: unknown,
  ) {
    super(code);
    this.name = "AdminCompatError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}
