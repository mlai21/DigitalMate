import {
  createHmac,
  randomBytes,
} from "node:crypto";

const SIGN_TOKEN_PATH =
  "/api/v5/robotLogic/sign-token";
const TOKEN_REFRESH_MARGIN_MS = 300 * 1_000;
const SIGN_MAX_RETRIES = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type YuanbaoToken = Readonly<{
  botId: string;
  token: string;
  source: string;
  durationSeconds: number;
  product: string;
}>;

export type YuanbaoTokenManager = Readonly<{
  getToken(): Promise<YuanbaoToken>;
  forceRefresh(): Promise<YuanbaoToken>;
  getAuthHeaders(): Promise<
    Readonly<Record<string, string>>
  >;
  stop(): Promise<void>;
}>;

export class YuanbaoAuthError extends Error {
  readonly code:
    | "credential_invalid"
    | "network_unreachable"
    | "rate_limited"
    | "unknown";
  readonly retryable: boolean;
  readonly detail: string;

  constructor(input: Readonly<{
    code: YuanbaoAuthError["code"];
    retryable: boolean;
    detail: string;
  }>) {
    super(input.code);
    this.name = "YuanbaoAuthError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.detail = input.detail;
  }
}

export function generateYuanbaoSignature(
  input: Readonly<{
    nonce: string;
    timestamp: string;
    appId: string;
    appSecret: string;
  }>,
): string {
  return createHmac("sha256", input.appSecret)
    .update(
      input.nonce
      + input.timestamp
      + input.appId
      + input.appSecret,
      "utf8",
    )
    .digest("hex");
}

export function formatYuanbaoTimestamp(
  date = new Date(),
): string {
  if (!Number.isFinite(date.getTime())) {
    throw new Error("yuanbao_timestamp_invalid");
  }
  const beijing = new Date(
    date.getTime() + 8 * 60 * 60 * 1_000,
  );
  return `${beijing.toISOString().slice(0, 19)}+08:00`;
}

export function createYuanbaoTokenManager(
  config: Readonly<{
    appId: string;
    appSecret: string;
    apiDomain: string;
  }>,
  dependencies: Readonly<{
    fetchImpl?: typeof fetch;
    now?: () => Date;
    nonce?: () => string;
    sleep?: (milliseconds: number) => Promise<void>;
    scheduleRefresh?: boolean;
  }> = {},
): YuanbaoTokenManager {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const nonce = dependencies.nonce
    ?? (() => randomBytes(16).toString("hex"));
  const sleep = dependencies.sleep ?? defaultSleep;
  const scheduleRefresh =
    dependencies.scheduleRefresh !== false;
  const endpoint = signTokenEndpoint(config.apiDomain);
  let cached:
    | Readonly<{
        value: YuanbaoToken;
        expiresAtMs: number;
        refreshAtMs: number;
      }>
    | null = null;
  let pending: Promise<YuanbaoToken> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const lifecycle = new AbortController();

  return {
    async getToken() {
      assertRunning();
      const nowMs = now().getTime();
      if (cached && nowMs < cached.refreshAtMs) {
        return cached.value;
      }
      return refresh(false);
    },

    async forceRefresh() {
      assertRunning();
      cached = null;
      clearRefreshTimer();
      return refresh(true);
    },

    async getAuthHeaders() {
      const value = await this.getToken();
      return {
        "X-ID": value.botId,
        "X-Token": value.token,
        "X-Source": value.source,
      };
    },

    async stop() {
      stopped = true;
      cached = null;
      clearRefreshTimer();
      lifecycle.abort(new YuanbaoAuthError({
        code: "unknown",
        retryable: false,
        detail: "yuanbao_token_manager_stopped",
      }));
      await pending?.catch(() => undefined);
    },
  };

  function assertRunning(): void {
    if (stopped) {
      throw new YuanbaoAuthError({
        code: "unknown",
        retryable: false,
        detail: "yuanbao_token_manager_stopped",
      });
    }
  }

  function refresh(
    force: boolean,
  ): Promise<YuanbaoToken> {
    if (pending) return pending;
    if (!force && cached) {
      const currentMs = now().getTime();
      if (currentMs < cached.refreshAtMs) {
        return Promise.resolve(cached.value);
      }
    }
    pending = fetchToken().then((value) => {
      if (stopped) {
        throw new YuanbaoAuthError({
          code: "unknown",
          retryable: false,
          detail: "yuanbao_token_manager_stopped",
        });
      }
      const baseMs = now().getTime();
      const durationMs = value.durationSeconds * 1_000;
      const expiresAtMs = baseMs + durationMs;
      const minimumRefreshDelay = Math.min(
        60_000,
        Math.max(1_000, Math.floor(durationMs / 2)),
      );
      const refreshAtMs = baseMs + Math.max(
        durationMs - TOKEN_REFRESH_MARGIN_MS,
        minimumRefreshDelay,
      );
      cached = {
        value,
        expiresAtMs,
        refreshAtMs: Math.min(refreshAtMs, expiresAtMs),
      };
      schedule(refreshAtMs - baseMs);
      return value;
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  async function fetchToken(): Promise<YuanbaoToken> {
    for (
      let attempt = 0;
      attempt <= SIGN_MAX_RETRIES;
      attempt += 1
    ) {
      assertRunning();
      const requestTime = now();
      const requestNonce = nonce();
      if (!/^[a-f0-9]{32}$/i.test(requestNonce)) {
        throw new YuanbaoAuthError({
          code: "unknown",
          retryable: false,
          detail: "yuanbao_nonce_invalid",
        });
      }
      const timestamp =
        formatYuanbaoTimestamp(requestTime);
      const signature = generateYuanbaoSignature({
        nonce: requestNonce,
        timestamp,
        appId: config.appId,
        appSecret: config.appSecret,
      });
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          signal: lifecycle.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            app_key: config.appId,
            nonce: requestNonce,
            signature,
            timestamp,
          }),
        });
        if (!response.ok) {
          throw httpAuthError(response.status);
        }
        const text = await response.text();
        if (
          Buffer.byteLength(text, "utf8")
          > MAX_RESPONSE_BYTES
        ) {
          throw new YuanbaoAuthError({
            code: "unknown",
            retryable: false,
            detail: "yuanbao_sign_response_too_large",
          });
        }
        const payload = parseResponse(text);
        const code = integer(payload.code);
        if (code === 0) {
          return tokenFromResponse(
            asRecord(payload.data),
          );
        }
        if (code === 10099 && attempt < SIGN_MAX_RETRIES) {
          await sleepWithSignal(
            sleep,
            1_000,
            lifecycle.signal,
          );
          continue;
        }
        throw new YuanbaoAuthError({
          code: code === 10099
            ? "rate_limited"
            : "credential_invalid",
          retryable: code === 10099,
          detail: code === 10099
            ? "yuanbao_sign_retry_exhausted"
            : "yuanbao_credential_invalid",
        });
      } catch (error) {
        if (stopped || lifecycle.signal.aborted) {
          throw new YuanbaoAuthError({
            code: "unknown",
            retryable: false,
            detail: "yuanbao_token_manager_stopped",
          });
        }
        const mapped = mapAuthError(error);
        if (
          mapped.retryable
          && attempt < SIGN_MAX_RETRIES
        ) {
          await sleepWithSignal(
            sleep,
            1_000,
            lifecycle.signal,
          );
          continue;
        }
        throw mapped;
      }
    }
    throw new YuanbaoAuthError({
      code: "unknown",
      retryable: false,
      detail: "yuanbao_sign_retry_exhausted",
    });
  }

  function schedule(delayMs: number): void {
    clearRefreshTimer();
    if (!scheduleRefresh || stopped) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!stopped) {
        void refresh(true).catch(() => undefined);
      }
    }, Math.min(
      Math.max(1_000, delayMs),
      2_147_483_647,
    ));
    refreshTimer.unref?.();
  }

  function clearRefreshTimer(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function sleepWithSignal(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(
      signal.reason ?? new Error("aborted"),
    );
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    void sleep(milliseconds).then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}

function tokenFromResponse(
  data: Record<string, unknown>,
): YuanbaoToken {
  const botId = string(data.bot_id);
  const token = string(data.token);
  const source = string(data.source) || "bot";
  const durationSeconds = integer(data.duration);
  const product = string(data.product) || "yuanbao";
  if (
    !botId
    || !token
    || !Number.isSafeInteger(durationSeconds)
    || durationSeconds <= 0
    || durationSeconds > 7 * 24 * 60 * 60
  ) {
    throw new YuanbaoAuthError({
      code: "credential_invalid",
      retryable: false,
      detail: "yuanbao_sign_response_invalid",
    });
  }
  return {
    botId,
    token,
    source,
    durationSeconds,
    product,
  };
}

function signTokenEndpoint(apiDomain: string): string {
  const normalized = apiDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (
    !normalized
    || normalized.includes("/")
    || normalized.includes("@")
  ) {
    throw new Error("yuanbao_api_domain_invalid");
  }
  const url = new URL(`https://${normalized}${SIGN_TOKEN_PATH}`);
  if (
    url.protocol !== "https:"
    || url.port
    || url.username
    || url.password
  ) {
    throw new Error("yuanbao_api_domain_invalid");
  }
  return url.toString();
}

function parseResponse(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    throw new YuanbaoAuthError({
      code: "unknown",
      retryable: false,
      detail: "yuanbao_sign_response_invalid",
    });
  }
}

function httpAuthError(status: number): YuanbaoAuthError {
  if (status === 401 || status === 403) {
    return new YuanbaoAuthError({
      code: "credential_invalid",
      retryable: false,
      detail: "yuanbao_credential_invalid",
    });
  }
  if (status === 429) {
    return new YuanbaoAuthError({
      code: "rate_limited",
      retryable: true,
      detail: "yuanbao_rate_limited",
    });
  }
  return new YuanbaoAuthError({
    code: "network_unreachable",
    retryable: status >= 500,
    detail: "yuanbao_sign_http_failed",
  });
}

function mapAuthError(error: unknown): YuanbaoAuthError {
  if (error instanceof YuanbaoAuthError) return error;
  return new YuanbaoAuthError({
    code: "network_unreachable",
    retryable: true,
    detail: "yuanbao_sign_network_failed",
  });
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : -1;
}

async function defaultSleep(
  milliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
