import type { AppEnv } from "@/server/config/env";
import { isRetriableLlmError, LlmProviderError } from "@/server/llm/errors";
import { getLlmClient, getLlmClientForModel, type LlmRouteConfig } from "@/server/llm/router";
import { collectStreamText, type LlmClient, type LlmStreamEvent, type LlmStreamInput } from "@/server/llm/types";

export type LlmFallbackEvent = Readonly<{
  from: string;
  to: string;
  code: string;
  status: number | null;
}>;

export type LlmCandidate = Readonly<{ client: LlmClient; model: string }>;

/**
 * Tries each candidate in order when the provider itself is unavailable, so a
 * gateway outage on the primary model degrades to another model instead of to
 * the "something went wrong" reply.
 *
 * Two rules keep this from breaking the single-visible-reply contract:
 * once the primary has emitted visible text or a tool call the turn is
 * committed to it and the error propagates; and the choice is sticky for the
 * rest of the turn, so a tool loop does not pay for the broken model on every
 * iteration.
 */
export function createFallbackLlmClient(input: Readonly<{
  candidates: readonly LlmCandidate[];
  onFallback?(event: LlmFallbackEvent): void;
}>): LlmCandidate {
  const candidates = input.candidates;
  if (candidates.length === 0) {
    throw new Error("llm_fallback_candidates_empty");
  }
  const primary = candidates[0]!;
  if (candidates.length === 1) return primary;

  let startIndex = 0;

  const client: LlmClient = {
    async *stream(streamInput: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
      for (let index = startIndex; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const isLast = index === candidates.length - 1;
        let emitted = false;
        try {
          for await (const event of candidate.client.stream({
            ...streamInput,
            model: candidate.model,
          })) {
            if (event.type === "text" && event.text.trim().length === 0 && !emitted) {
              continue;
            }
            emitted = true;
            startIndex = index;
            yield event;
          }
          streamInput.signal?.throwIfAborted();
          if (!emitted && !isLast) {
            startIndex = index + 1;
            input.onFallback?.({
              from: candidate.model,
              to: candidates[index + 1]!.model,
              code: "llm_empty_response",
              status: null,
            });
            continue;
          }
          startIndex = index;
          return;
        } catch (error) {
          if (
            emitted
            || isLast
            || streamInput.signal?.aborted === true
            || !isRetriableLlmError(error)
          ) {
            throw error;
          }
          startIndex = index + 1;
          input.onFallback?.({
            from: candidate.model,
            to: candidates[index + 1]!.model,
            code: error instanceof LlmProviderError ? error.code : "llm_unavailable",
            status: error instanceof LlmProviderError ? error.status : null,
          });
        }
      }
    },

    async completeText(completeInput): Promise<string> {
      return collectStreamText(client.stream(completeInput));
    },
  };

  return { client, model: primary.model };
}

/**
 * Builds the main-purpose client with its configured fallback chain.
 * `fallbackModels` must already be authorization-filtered for the scope, and
 * models whose provider has no credential are dropped rather than attempted.
 */
export function getMainLlmClientWithFallbacks(input: Readonly<{
  env: AppEnv;
  routeConfig: LlmRouteConfig;
  fallbackModels: readonly string[];
  onFallback?(event: LlmFallbackEvent): void;
}>): LlmCandidate {
  const primary = getLlmClient("main", input.env, input.routeConfig);
  const candidates: LlmCandidate[] = [primary];
  for (const model of input.fallbackModels) {
    if (model === primary.model) continue;
    const client = getLlmClientForModel(model, input.env);
    if (client) candidates.push({ client, model });
  }
  return createFallbackLlmClient({
    candidates,
    ...(input.onFallback ? { onFallback: input.onFallback } : {}),
  });
}
