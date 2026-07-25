export type FakeHttpRequest = Readonly<{
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  responseType?: "json" | "bytes";
  signal?: AbortSignal;
}>;

export type FakeHttpResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export function createDeterministicClock(initial: Date) {
  let timestamp = initial.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("deterministic_clock_invalid_date");
  }

  return {
    now: () => new Date(timestamp),
    advanceBy(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("deterministic_clock_advance_invalid");
      }
      timestamp += milliseconds;
    },
    set(next: Date) {
      const nextTimestamp = next.getTime();
      if (!Number.isFinite(nextTimestamp)) {
        throw new Error("deterministic_clock_invalid_date");
      }
      timestamp = nextTimestamp;
    },
  };
}

export function createFakeHttpClient() {
  const responses: FakeHttpResponse[] = [];
  const requests: Array<Omit<FakeHttpRequest, "signal">> = [];

  return {
    requests,
    enqueue(response: FakeHttpResponse) {
      responses.push(response);
    },
    async request(
      request: FakeHttpRequest,
    ): Promise<FakeHttpResponse> {
      request.signal?.throwIfAborted();
      requests.push({
        method: request.method,
        url: redactUrl(request.url),
        headers: redactHeaders(request.headers),
        body: redactBody(request.body),
        ...(request.responseType
          ? { responseType: request.responseType }
          : {}),
      });
      const response = responses.shift();
      if (!response) {
        throw new Error("fake_http_response_missing");
      }
      request.signal?.throwIfAborted();
      return response;
    },
  };
}

type SocketState = "connecting" | "open" | "closed";
type MessageListener = (payload: unknown) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = (code: number, reason: string) => void;

export function createFakeSocket() {
  let state: SocketState = "connecting";
  const messages = new Set<MessageListener>();
  const errors = new Set<ErrorListener>();
  const closes = new Set<CloseListener>();
  const sent: unknown[] = [];
  let detachAbort: (() => void) | null = null;

  return {
    get state(): SocketState {
      return state;
    },
    sent,
    open() {
      if (state !== "closed") {
        state = "open";
      }
    },
    send(payload: unknown) {
      if (state !== "open") {
        throw new Error("fake_socket_not_open");
      }
      sent.push(payload);
    },
    receive(payload: unknown) {
      if (state !== "open") return;
      for (const listener of messages) listener(payload);
    },
    ping(payload: unknown = "ping") {
      this.send(payload);
    },
    pong(payload: unknown = "pong") {
      this.send(payload);
    },
    fail(error: Error) {
      for (const listener of errors) listener(error);
    },
    close(code = 1000, reason = "closed") {
      if (state === "closed") return;
      state = "closed";
      detachAbort?.();
      detachAbort = null;
      for (const listener of closes) listener(code, reason);
    },
    bindAbort(signal: AbortSignal) {
      detachAbort?.();
      const onAbort = () => this.close(1000, "aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () =>
        signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    },
    onMessage(listener: MessageListener) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError(listener: ErrorListener) {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onClose(listener: CloseListener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
  };
}

function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      /authorization|cookie|secret|token/i.test(name)
        ? "[REDACTED]"
        : value,
    ]),
  );
}

function redactUrl(value: string): string {
  const botTokenRedacted = value.replace(
    /\/bot[^/?#]+/giu,
    "/bot[REDACTED]",
  );
  try {
    const url = new URL(botTokenRedacted);
    for (const name of url.searchParams.keys()) {
      if (/authorization|secret|token|password/i.test(name)) {
        url.searchParams.set(name, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return botTokenRedacted;
  }
}

function redactBody(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactBody);

  return Object.fromEntries(
    Object.entries(value).map(([name, nested]) => [
      name,
      /authorization|secret|token|password/i.test(name)
        ? "[REDACTED]"
        : redactBody(nested),
    ]),
  );
}
