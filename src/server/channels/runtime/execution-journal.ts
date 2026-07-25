import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";

const MAX_JOURNAL_OUTPUT_BYTES = 60 * 1024;
type Queryable = Pick<Pool | PoolClient, "query">;

export type ExecutionStepKind = "llm" | "search" | "tool";

export type ExecutionStep = Readonly<{
  key: string;
  kind: ExecutionStepKind;
  requestHash: string;
}>;

export type ExecutionStepAction = "run" | "reuse" | "ambiguous";

export interface ExecutionJournal {
  begin(step: ExecutionStep): Promise<ExecutionStepAction>;
  complete(stepKey: string, output: unknown): Promise<void>;
  fail(stepKey: string, code: string): Promise<void>;
  read<T>(stepKey: string): Promise<T | null>;
}

type ExecutionStepRow = {
  step_key: string;
  kind: ExecutionStepKind;
  request_hash: string;
  status: "started" | "completed" | "failed" | "ambiguous";
  output: unknown | null;
};

export function createExecutionJournal(
  database: Queryable,
  scope: AgentScope,
  eventId: string,
): ExecutionJournal {
  assertIdentifier(eventId, "channel_execution_event_id_invalid");

  return {
    async begin(step): Promise<ExecutionStepAction> {
      validateStep(step);
      const inserted = await database.query<ExecutionStepRow>(
        `INSERT INTO channel_execution_steps (
           user_id, agent_id, event_id, step_key, kind,
           request_hash, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'started')
         ON CONFLICT (event_id, step_key) DO NOTHING
         RETURNING step_key, kind, request_hash, status, output`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          step.key,
          step.kind,
          step.requestHash,
        ],
      );
      if (inserted.rows[0]) return "run";

      const madeAmbiguous = await database.query<ExecutionStepRow>(
        `UPDATE channel_execution_steps
         SET status = 'ambiguous',
             error_code = 'execution_outcome_unknown',
             completed_at = now()
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3
           AND step_key = $4
           AND kind = $5
           AND request_hash = $6
           AND status = 'started'
         RETURNING step_key, kind, request_hash, status, output`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          step.key,
          step.kind,
          step.requestHash,
        ],
      );
      if (madeAmbiguous.rows[0]) return "ambiguous";

      const existing = await readRow(database, scope, eventId, step.key);
      if (!existing) {
        throw new Error("channel_execution_step_missing");
      }
      if (
        existing.kind !== step.kind
        || existing.request_hash !== step.requestHash
      ) {
        throw new Error("channel_execution_step_conflict");
      }
      return existing.status === "completed" ? "reuse" : "ambiguous";
    },

    async complete(stepKey, output): Promise<void> {
      assertStepKey(stepKey);
      const serialized = serializeOutput(output);
      const result = await database.query<ExecutionStepRow>(
        `UPDATE channel_execution_steps
         SET status = 'completed',
             output = $5::jsonb,
             error_code = NULL,
             completed_at = now()
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3
           AND step_key = $4
           AND status = 'started'
         RETURNING step_key, kind, request_hash, status, output`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          stepKey,
          serialized,
        ],
      );
      if (result.rows[0]) return;

      const existing = await readRow(database, scope, eventId, stepKey);
      if (
        existing?.status === "completed"
        && canonicalJson(existing.output) === canonicalJson(output)
      ) {
        return;
      }
      throw new Error("channel_execution_step_not_runnable");
    },

    async fail(stepKey, code): Promise<void> {
      assertStepKey(stepKey);
      assertErrorCode(code);
      const result = await database.query(
        `UPDATE channel_execution_steps
         SET status = 'failed',
             error_code = $5,
             completed_at = now()
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3
           AND step_key = $4
           AND status = 'started'`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          stepKey,
          code,
        ],
      );
      if (result.rowCount === 1) return;

      const existing = await readRow(database, scope, eventId, stepKey);
      if (
        existing
        && (
          existing.status === "failed"
          || existing.status === "ambiguous"
          || existing.status === "completed"
        )
      ) {
        return;
      }
      throw new Error("channel_execution_step_not_runnable");
    },

    async read<T>(stepKey: string): Promise<T | null> {
      assertStepKey(stepKey);
      const existing = await readRow(
        database,
        scope,
        eventId,
        stepKey,
      );
      return existing?.status === "completed"
        ? existing.output as T
        : null;
    },
  };
}

export function hashExecutionRequest(value: unknown): string {
  return hashExecutionText(canonicalJson(value));
}

export function hashExecutionText(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function readRow(
  database: Queryable,
  scope: AgentScope,
  eventId: string,
  stepKey: string,
): Promise<ExecutionStepRow | null> {
  const result = await database.query<ExecutionStepRow>(
    `SELECT step_key, kind, request_hash, status, output
     FROM channel_execution_steps
     WHERE user_id = $1
       AND agent_id = $2
       AND event_id = $3
       AND step_key = $4`,
    [scope.userId, scope.agentId, eventId, stepKey],
  );
  return result.rows[0] ?? null;
}

function serializeOutput(output: unknown): string {
  const serialized = canonicalJson(output);
  if (
    serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_OUTPUT_BYTES
  ) {
    throw new Error("channel_execution_output_too_large");
  }
  return serialized;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function validateStep(step: ExecutionStep): void {
  assertStepKey(step.key);
  if (!["llm", "search", "tool"].includes(step.kind)) {
    throw new Error("channel_execution_step_kind_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(step.requestHash)) {
    throw new Error("channel_execution_request_hash_invalid");
  }
}

function assertStepKey(stepKey: string): void {
  if (
    stepKey.trim().length === 0
    || stepKey.length > 512
    || /[\u0000-\u001f\u007f]/.test(stepKey)
  ) {
    throw new Error("channel_execution_step_key_invalid");
  }
}

function assertErrorCode(code: string): void {
  if (
    code.trim().length === 0
    || code.length > 256
    || !/^[a-z0-9_:-]+$/i.test(code)
  ) {
    throw new Error("channel_execution_error_code_invalid");
  }
}

function assertIdentifier(value: string, code: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error(code);
  }
}
