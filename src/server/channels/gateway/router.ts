export const CHANNEL_GATEWAY_MAX_BODY_BYTES = 1024 * 1024;

const UUID_SEGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ONEBOT_PATH = new RegExp(
  `^/channel-gateway/onebot/(${UUID_SEGMENT})$`,
  "i",
);
const VOICE_RELAY_PATH = new RegExp(
  `^/channel-gateway/voice/(${UUID_SEGMENT})/relay$`,
  "i",
);
const VOICE_HTTP_PATH = new RegExp(
  `^/channel-gateway/voice/(${UUID_SEGMENT})/(incoming|status)$`,
  "i",
);

type GatewayHttpHandler = (
  request: Request,
  context: Readonly<{ connectionId: string }>,
) => Promise<Response>;

export type ChannelGatewayUpgradeRoute =
  | Readonly<{ type: "onebot"; connectionId: string }>
  | Readonly<{ type: "voice-relay"; connectionId: string }>;

export function createChannelGatewayRouter(
  handlers: Readonly<{
    onVoiceIncoming?: GatewayHttpHandler;
    onVoiceStatus?: GatewayHttpHandler;
  }> = {},
) {
  return {
    async dispatch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = VOICE_HTTP_PATH.exec(url.pathname);
      if (!match || request.method !== "POST") {
        return new Response("Not Found", { status: 404 });
      }
      const body = await readBoundedBody(request);
      if (body === null) {
        return new Response("Payload Too Large", { status: 413 });
      }
      const connectionId = match[1].toLowerCase();
      const handler = match[2].toLowerCase() === "incoming"
        ? handlers.onVoiceIncoming
        : handlers.onVoiceStatus;
      if (!handler) {
        return new Response("Channel gateway unavailable", {
          status: 503,
        });
      }
      return handler(
        recreateRequest(request, body),
        { connectionId },
      );
    },

    matchUpgrade(pathname: string): ChannelGatewayUpgradeRoute | null {
      const onebot = ONEBOT_PATH.exec(pathname);
      if (onebot) {
        return {
          type: "onebot",
          connectionId: onebot[1].toLowerCase(),
        };
      }
      const voiceRelay = VOICE_RELAY_PATH.exec(pathname);
      if (voiceRelay) {
        return {
          type: "voice-relay",
          connectionId: voiceRelay[1].toLowerCase(),
        };
      }
      return null;
    },
  };
}

async function readBoundedBody(
  request: Request,
): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > CHANNEL_GATEWAY_MAX_BODY_BYTES
    ) {
      return null;
    }
  }
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength <= CHANNEL_GATEWAY_MAX_BODY_BYTES
    ? body
    : null;
}

function recreateRequest(
  request: Request,
  body: Uint8Array,
): Request {
  const copiedBody = new Uint8Array(body).buffer;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: copiedBody,
    signal: request.signal,
  });
}
