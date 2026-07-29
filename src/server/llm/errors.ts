const MAX_DETAIL_LENGTH = 200;

export type LlmProviderName = "anthropic" | "openai-compat";

/**
 * Carries the provider's HTTP status alongside the message so callers can tell
 * "the gateway is down" (retriable, worth another model) apart from "we sent a
 * bad request" (not retriable), and so the backstage trail keeps a stable code
 * instead of one generic failure bucket. The detail is provider text and stays
 * backstage — it must never reach a conversation.
 */
export class LlmProviderError extends Error {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly status: number;
  readonly detail: string;

  constructor(input: {
    provider: LlmProviderName;
    model: string;
    status: number;
    message: string;
    detail?: string;
  }) {
    super(input.message);
    this.name = "LlmProviderError";
    this.provider = input.provider;
    this.model = input.model;
    this.status = input.status;
    this.detail = (input.detail ?? "").slice(0, MAX_DETAIL_LENGTH);
  }

  /** Journal/log code, e.g. `llm_http_500`. */
  get code(): string {
    return `llm_http_${this.status}`;
  }

  /**
   * Gateway-side faults and throttling can succeed on another model; 4xx means
   * our own request is wrong and retrying it elsewhere would fail the same way.
   */
  get retriable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export function isRetriableLlmError(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retriable;
}

/**
 * The KIE gateway reports its own failures as HTTP 200 with `{"code":500,...}`
 * in the body, so the transport status alone hides outages. Reads that envelope
 * code, or an Anthropic-shaped `error.type`, when present.
 */
export function providerErrorStatus(body: string): number | null {
  let payload: {
    code?: unknown;
    error?: { type?: unknown };
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return null;
  }
  if (
    typeof payload.code === "number"
    && payload.code >= 400
    && payload.code <= 599
  ) {
    return payload.code;
  }
  switch (payload.error?.type) {
    case "overloaded_error":
      return 529;
    case "rate_limit_error":
      return 429;
    case "api_error":
      return 500;
    default:
      return null;
  }
}
