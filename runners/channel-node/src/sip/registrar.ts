import dgram, {
  type RemoteInfo,
  type Socket,
} from "node:dgram";

export type SipAddress = readonly [string, number];
const MAX_REGISTRATIONS = 256;
const MAX_TRANSACTIONS = 1_024;

export type SipMessage = Readonly<{
  kind: "request" | "response";
  method: string | null;
  requestUri: string | null;
  statusCode: number | null;
  reason: string | null;
  startLine: string;
  headers: ReadonlyMap<string, string>;
  headerValues: ReadonlyMap<string, readonly string[]>;
  body: string;
  source: string;
}>;

export function parseSipMessage(source: string): SipMessage {
  if (!source.includes("\r\n")) {
    throw new Error("sip_crlf_required");
  }
  const separatorIndex = source.indexOf("\r\n\r\n");
  if (separatorIndex < 0) {
    throw new Error("sip_message_terminator_required");
  }
  const head = source.slice(0, separatorIndex);
  const body = source.slice(separatorIndex + 4);
  const lines = head.split("\r\n");
  const startLine = lines.shift() ?? "";
  const headers = new Map<string, string>();
  const headerValues = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("sip_header_invalid");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name) {
      throw new Error("sip_header_invalid");
    }
    const existing = headerValues.get(name);
    if (
      existing
      && !["via", "route", "record-route"].includes(name)
    ) {
      throw new Error("sip_header_invalid");
    }
    if (existing) existing.push(value);
    else {
      headers.set(name, value);
      headerValues.set(name, [value]);
    }
  }
  for (const required of [
    "via",
    "from",
    "to",
    "call-id",
    "cseq",
  ]) {
    if (!headers.has(required)) {
      throw new Error(`sip_${required}_required`);
    }
  }
  if (startLine.startsWith("SIP/2.0 ")) {
    const match = /^SIP\/2\.0 ([1-6][0-9]{2}) (.+)$/u.exec(
      startLine,
    );
    if (!match) throw new Error("sip_status_line_invalid");
    return {
      kind: "response",
      method: null,
      requestUri: null,
      statusCode: Number(match[1]),
      reason: match[2] ?? null,
      startLine,
      headers,
      headerValues,
      body,
      source,
    };
  }
  const match =
    /^([A-Z]+) (sip:[^\s]+) SIP\/2\.0$/u.exec(startLine);
  if (!match) throw new Error("sip_request_line_invalid");
  return {
    kind: "request",
    method: match[1] ?? null,
    requestUri: match[2] ?? null,
    statusCode: null,
    reason: null,
    startLine,
    headers,
    headerValues,
    body,
    source,
  };
}

export function buildSipResponse(
  request: SipMessage,
  statusCode: number,
  reason: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
  body = "",
): string {
  if (
    request.kind !== "request"
    || !Number.isInteger(statusCode)
    || statusCode < 100
    || statusCode > 699
    || !/^[A-Za-z][A-Za-z ]{0,63}$/u.test(reason)
  ) {
    throw new Error("sip_response_invalid");
  }
  const overrideHeaders = new Map(
    Object.entries(additionalHeaders).map(
      ([name, value]) => [name.toLowerCase(), value],
    ),
  );
  const lines = [`SIP/2.0 ${statusCode} ${reason}`];
  for (const name of ["Via", "From", "To", "Call-ID", "CSeq"]) {
    const override = overrideHeaders.get(name.toLowerCase());
    const values = override
      ? [override]
      : request.headerValues.get(name.toLowerCase())
        ?? [];
    if (values.length === 0) {
      throw new Error("sip_transaction_header_required");
    }
    for (const value of values) {
      lines.push(`${name}: ${value}`);
    }
  }
  for (const [name, value] of Object.entries(additionalHeaders)) {
    if (
      ["via", "from", "to", "call-id", "cseq", "content-length"]
        .includes(name.toLowerCase())
    ) {
      continue;
    }
    if (
      !/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(name)
      || /[\r\n]/u.test(value)
    ) {
      throw new Error("sip_response_header_invalid");
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push(
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  );
  return lines.join("\r\n");
}

export function createSipRegistrarRouter(input: Readonly<{
  send(message: string, target: SipAddress): void;
}>) {
  const registrations = new Map<string, SipAddress>();
  const transactions = new Map<string, Readonly<{
    origin: SipAddress;
    destination: SipAddress;
  }>>();
  return {
    receive(source: string, address: SipAddress): void {
      let message: SipMessage;
      try {
        message = parseSipMessage(source);
      } catch {
        return;
      }
      const callId = message.headers.get("call-id")!;
      if (
        message.kind === "request"
        && message.method === "REGISTER"
      ) {
        const user = sipUser(message.headers.get("to") ?? "");
        if (!user) return;
        if (
          !registrations.has(user)
          && registrations.size >= MAX_REGISTRATIONS
        ) {
          input.send(
            buildSipResponse(
              message,
              503,
              "Service Unavailable",
            ),
            address,
          );
          return;
        }
        registrations.set(user, address);
        input.send(
          buildSipResponse(message, 200, "OK"),
          address,
        );
        return;
      }
      if (message.kind === "request") {
        const user = sipUser(message.requestUri ?? "");
        const destination = registrations.get(user);
        if (!destination) {
          if (message.method === "INVITE") {
            input.send(
              buildSipResponse(message, 404, "Not Found"),
              address,
            );
          }
          return;
        }
        if (
          !transactions.has(callId)
          && transactions.size >= MAX_TRANSACTIONS
        ) {
          if (message.method === "INVITE") {
            input.send(
              buildSipResponse(
                message,
                503,
                "Service Unavailable",
              ),
              address,
            );
          }
          return;
        }
        transactions.set(callId, {
          origin: address,
          destination,
        });
        input.send(source, destination);
        return;
      }
      const transaction = transactions.get(callId);
      if (!transaction) return;
      const destination = sameAddress(
        address,
        transaction.destination,
      )
        ? transaction.origin
        : transaction.destination;
      input.send(source, destination);
    },
    closeTransaction(callId: string): void {
      transactions.delete(callId);
    },
    snapshot(): Readonly<{
      registrations: number;
      transactions: number;
    }> {
      return {
        registrations: registrations.size,
        transactions: transactions.size,
      };
    },
  };
}

export function createMiniSipRegistrar(input: Readonly<{
  host: string;
  port: number;
  createSocket?: () => Socket;
}>) {
  let socket: Socket | null = null;
  return {
    async start(): Promise<void> {
      if (socket) throw new Error("sip_registrar_already_started");
      const nextSocket =
        input.createSocket?.() ?? dgram.createSocket("udp4");
      const router = createSipRegistrarRouter({
        send(message, target) {
          nextSocket.send(message, target[1], target[0]);
        },
      });
      nextSocket.on(
        "message",
        (data: Buffer, remote: RemoteInfo) => {
          if (data.byteLength > 65_535) return;
          router.receive(
            data.toString("utf8"),
            [remote.address, remote.port],
          );
        },
      );
      await bindSocket(nextSocket, input.port, input.host);
      socket = nextSocket;
    },
    async stop(): Promise<void> {
      const current = socket;
      socket = null;
      if (!current) return;
      await closeSocket(current);
    },
  };
}

function sipUser(value: string): string {
  return /sip:([^@;>\s]+)@?/iu.exec(value)?.[1] ?? "";
}

function sameAddress(
  left: SipAddress,
  right: SipAddress,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function bindSocket(
  socket: Socket,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, host);
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.close(() => resolve());
  });
}
