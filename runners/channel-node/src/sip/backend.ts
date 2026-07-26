export type SipBackendKind = "dev" | "livekit";

export type SipIncomingCall = Readonly<{
  callId: string;
  fromUri: string;
  toUri: string;
}>;

export type SipBackendHandlers = Readonly<{
  onIncomingCall(
    call: SipIncomingCall,
  ): Promise<"accepted" | "busy" | "unavailable">;
  onCallReady(callId: string): Promise<void>;
  onPcm(callId: string, pcm16: Buffer): Promise<void>;
  onSpeechStart(callId: string): Promise<void>;
  onCallEnded(callId: string, cause: string): Promise<void>;
}>;

export interface SipBackend {
  readonly kind: SipBackendKind;
  readonly sampleRate: 8_000 | 24_000;
  start(handlers: SipBackendHandlers): Promise<void>;
  stop(): Promise<void>;
  playAudio(callId: string, frame: Buffer): Promise<boolean>;
  interruptAudio(callId: string): Promise<void>;
  rejectCall(callId: string, cause: "busy"): Promise<void>;
  hangup(callId: string, cause: string): Promise<void>;
}

export type SipBackendHarnessCall = Readonly<{
  playedFrames: readonly Buffer[];
  injectPcm(pcm16: Buffer): Promise<void>;
  speechStarted(): Promise<void>;
  end(cause?: string): Promise<void>;
}>;

export function createSipBackendHarness(input: Readonly<{
  kind: SipBackendKind;
  sampleRate: 8_000 | 24_000;
}>): SipBackend & Readonly<{
  injectIncomingCall(
    call: SipIncomingCall,
  ): Promise<SipBackendHarnessCall>;
}> {
  let handlers: SipBackendHandlers | null = null;
  const calls = new Map<
    string,
    { active: boolean; playedFrames: Buffer[] }
  >();
  return {
    kind: input.kind,
    sampleRate: input.sampleRate,
    async start(nextHandlers) {
      if (handlers) throw new Error("sip_backend_already_started");
      handlers = nextHandlers;
    },
    async stop() {
      handlers = null;
      calls.clear();
    },
    async playAudio(callId, frame) {
      const call = calls.get(callId);
      if (!call?.active) {
        throw new Error("sip_call_not_active");
      }
      call.playedFrames.push(Buffer.from(frame));
      return true;
    },
    async interruptAudio() {},
    async rejectCall(callId) {
      const call = calls.get(callId);
      if (call) call.active = false;
    },
    async hangup(callId, cause) {
      const call = calls.get(callId);
      if (!call?.active) return;
      call.active = false;
      await handlers?.onCallEnded(callId, cause);
    },
    async injectIncomingCall(callInput) {
      if (!handlers) throw new Error("sip_backend_not_started");
      const call = {
        active: true,
        playedFrames: [] as Buffer[],
      };
      calls.set(callInput.callId, call);
      const disposition =
        await handlers.onIncomingCall(callInput);
      if (disposition !== "accepted") call.active = false;
      else await handlers.onCallReady(callInput.callId);
      return {
        playedFrames: call.playedFrames,
        async injectPcm(pcm16) {
          if (!call.active) return;
          await handlers?.onPcm(
            callInput.callId,
            Buffer.from(pcm16),
          );
        },
        async speechStarted() {
          if (!call.active) return;
          await handlers?.onSpeechStart(callInput.callId);
        },
        async end(cause = "normal") {
          if (!call.active) return;
          call.active = false;
          await handlers?.onCallEnded(
            callInput.callId,
            cause,
          );
        },
      };
    },
  };
}

export interface SipDatagramSocket {
  onMessage(
    listener: (
      data: Buffer,
      address: SipAddress,
    ) => void,
  ): void;
  bind(port: number, host: string): Promise<void>;
  send(
    data: string | Buffer,
    port: number,
    host: string,
  ): Promise<void>;
  close(): Promise<void>;
}

type DevCall = {
  callId: string;
  invite: SipMessage;
  signalingAddress: SipAddress;
  remoteRtpAddress: SipAddress;
  localRtpPort: number;
  rtpSocket: SipDatagramSocket;
  response: string | null;
  rejected: boolean;
  ready: boolean;
  sequence: number;
  timestamp: number;
  ssrc: number;
  nextPlayoutAt: number | null;
  playbackGeneration: number;
  pendingPlayout: Readonly<{
    timer: ReturnType<typeof setTimeout>;
    resolve(ready: boolean): void;
  }> | null;
  dialog: Readonly<{
    localParty: string;
    remoteParty: string;
    remoteTarget: string;
    routeSet: readonly string[];
  }> & {
    localCSeq: number;
    remoteCSeq: number;
  } | null;
};

export function createDevSipBackend(
  config: SipRunnerConfig,
  dependencies: Readonly<{
    createSocket?: () => SipDatagramSocket;
    monotonicNow?: () => number;
  }> = {},
): SipBackend {
  if (config.mode !== "dev") {
    throw new Error("sip_dev_config_required");
  }
  const createSocket =
    dependencies.createSocket ?? createNodeDatagramSocket;
  const monotonicNow =
    dependencies.monotonicNow ?? (() => performance.now());
  const allocator = new RtpPortAllocator(
    config.rtpPortLow,
    config.rtpPortHigh,
  );
  const calls = new Map<string, DevCall>();
  let handlers: SipBackendHandlers | null = null;
  let signalingSocket: SipDatagramSocket | null = null;
  let registration:
    | Readonly<{
        callId: string;
        cseq: number;
        branch: string;
        waiter: ReturnType<typeof deferred<SipMessage>>;
      }>
    | null = null;
  let registrationCallId: string | null = null;
  let registrationFromTag: string | null = null;
  let nextRegistrationCSeq = 1;
  let registrar:
    | ReturnType<typeof createSipRegistrarRouter>
    | null = null;
  let registrationTimer:
    | ReturnType<typeof setTimeout>
    | null = null;
  let registrationRefresh: Promise<number> | null = null;

  async function sendSignaling(
    message: string,
    target: SipAddress,
  ): Promise<void> {
    const socket = signalingSocket;
    if (!socket) throw new Error("sip_backend_not_started");
    await socket.send(message, target[1], target[0]);
  }

  async function handleSignaling(
    data: Buffer,
    address: SipAddress,
  ): Promise<void> {
    if (data.byteLength > 65_535) return;
    const source = data.toString("utf8");
    let message: SipMessage;
    try {
      message = parseSipMessage(source);
    } catch {
      return;
    }
    const callId = message.headers.get("call-id")!;
    if (
      message.kind === "response"
      && registration
      && callId === registration.callId
      && matchesCSeq(
        message.headers.get("cseq"),
        registration.cseq,
        "REGISTER",
      )
      && message.headerValues.get("via")?.[0]
        ?.includes(`branch=${registration.branch}`)
    ) {
      registration.waiter.resolve(message);
      return;
    }
    if (message.kind === "response") {
      registrar?.receive(source, address);
      return;
    }
    if (message.method === "INVITE") {
      const target = sipUser(message.requestUri ?? "");
      const localUser = config.username || "mate";
      if (target === localUser || calls.has(callId)) {
        await handleInvite(message, address);
        return;
      }
    }
    if (calls.has(callId)) {
      if (message.method === "ACK") {
        const call = calls.get(callId)!;
        if (
          !call.dialog
          || !matchesDialog(message, call.dialog)
          || !matchesCSeq(
            message.headers.get("cseq"),
            call.dialog.remoteCSeq,
            "ACK",
          )
        ) {
          return;
        }
        if (!call.ready) {
          call.ready = true;
          await handlers?.onCallReady(callId);
        }
        return;
      }
      if (message.method === "BYE") {
        const call = calls.get(callId)!;
        const remoteCSeq = cseqNumber(message);
        if (
          !call.dialog
          || !matchesDialog(message, call.dialog)
          || remoteCSeq <= call.dialog.remoteCSeq
          || !matchesCSeq(
            message.headers.get("cseq"),
            remoteCSeq,
            "BYE",
          )
        ) {
          await sendSignaling(
            buildSipResponse(
              message,
              481,
              "Call Transaction Does Not Exist",
            ),
            address,
          );
          return;
        }
        call.dialog.remoteCSeq = remoteCSeq;
        await sendSignaling(
          buildSipResponse(message, 200, "OK"),
          address,
        );
        await endCall(callId, "remote_bye", true);
      }
      return;
    }
    registrar?.receive(source, address);
  }

  async function handleInvite(
    invite: SipMessage,
    address: SipAddress,
  ): Promise<void> {
    const callId = invite.headers.get("call-id")!;
    const existing = calls.get(callId);
    if (existing) {
      if (existing.response) {
        await sendSignaling(existing.response, address);
      }
      return;
    }
    if (!handlers) return;
    let localRtpPort: number;
    try {
      localRtpPort = allocator.lease();
    } catch {
      await sendSignaling(
        buildSipResponse(invite, 486, "Busy Here"),
        address,
      );
      return;
    }
    const remoteRtpAddress = parseSdpAudioEndpoint(
      invite.body,
      address[0],
    );
    if (!remoteRtpAddress) {
      allocator.release(localRtpPort);
      await sendSignaling(
        buildSipResponse(
          invite,
          488,
          "Not Acceptable Here",
        ),
        address,
      );
      return;
    }
    const rtpSocket = createSocket();
    const call: DevCall = {
      callId,
      invite,
      signalingAddress: address,
      remoteRtpAddress,
      localRtpPort,
      rtpSocket,
      response: null,
      rejected: false,
      ready: false,
      sequence: randomBytes(2).readUInt16BE(0),
      timestamp: randomBytes(4).readUInt32BE(0),
      ssrc: randomBytes(4).readUInt32BE(0),
      nextPlayoutAt: null,
      playbackGeneration: 0,
      pendingPlayout: null,
      dialog: null,
    };
    calls.set(callId, call);
    rtpSocket.onMessage((packet, remote) => {
      if (
        remote[0] !== call.remoteRtpAddress[0]
        || remote[1] !== call.remoteRtpAddress[1]
        || packet.byteLength > 2_048
      ) {
        return;
      }
      try {
        const parsed = parseRtpPacket(packet);
        if (parsed.payloadType !== 0) return;
        const samples = decodeMuLaw(parsed.payload);
        const pcm16 = Buffer.allocUnsafe(samples.length * 2);
        for (
          let index = 0;
          index < samples.length;
          index += 1
        ) {
          pcm16.writeInt16LE(
            samples[index] ?? 0,
            index * 2,
          );
        }
        void handlers?.onPcm(callId, pcm16)
          .catch(() => undefined);
      } catch {
        // Malformed or unsupported RTP is dropped.
      }
    });
    try {
      await rtpSocket.bind(
        localRtpPort,
        config.bindHost,
      );
      await sendSignaling(
        buildSipResponse(invite, 180, "Ringing"),
        address,
      );
      const disposition = await handlers.onIncomingCall({
        callId,
        fromUri: invite.headers.get("from") ?? "unknown",
        toUri: invite.headers.get("to") ?? "",
      });
      if (disposition !== "accepted" || call.rejected) {
        call.response = buildSipResponse(
          invite,
          disposition === "unavailable" ? 480 : 486,
          disposition === "unavailable"
            ? "Temporarily Unavailable"
            : "Busy Here",
        );
        await sendSignaling(call.response, address);
        await endCall(callId, "busy", false);
        return;
      }
      const localHost = advertisedHost(config.bindHost);
      const sdp = buildSdp(localHost, localRtpPort);
      const localParty = withTag(
        invite.headers.get("to") ?? "",
        randomBytes(8).toString("hex"),
      );
      call.dialog = {
        localParty,
        remoteParty: invite.headers.get("from") ?? "",
        remoteTarget: extractSipUri(
          invite.headers.get("contact")
          ?? invite.headers.get("from")
          ?? "",
        ),
        routeSet:
          invite.headerValues.get("record-route") ?? [],
        localCSeq: cseqNumber(invite),
        remoteCSeq: cseqNumber(invite),
      };
      call.response = buildSipResponse(
        invite,
        200,
        "OK",
        {
          To: localParty,
          Contact:
            `<sip:${config.username || "mate"}@`
            + `${localHost}:${config.sipPort}>`,
          "Content-Type": "application/sdp",
        },
        sdp,
      );
      await sendSignaling(call.response, address);
    } catch (error) {
      if (!call.response) {
        await sendSignaling(
          buildSipResponse(
            invite,
            500,
            "Server Internal Error",
          ),
          address,
        ).catch(() => undefined);
      }
      await endCall(callId, "setup_failed", false);
      throw error;
    }
  }

  async function endCall(
    callId: string,
    cause: string,
    notify: boolean,
  ): Promise<void> {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    cancelPlayout(call);
    registrar?.closeTransaction(callId);
    allocator.release(call.localRtpPort);
    await call.rtpSocket.close().catch(() => undefined);
    if (notify) await handlers?.onCallEnded(callId, cause);
  }

  async function registerWithServer(
    requestedExpires = 300,
  ): Promise<number> {
    if (!config.sipServer) return 0;
    if (!config.username) {
      throw new Error("sip_username_required");
    }
    const server = parseServer(config.sipServer);
    if (!registrationCallId || !registrationFromTag) {
      throw new Error("sip_registration_lifecycle_missing");
    }
    const callId = registrationCallId;
    let authorization: Readonly<{
      headerName: "Authorization" | "Proxy-Authorization";
      value: string;
    }> | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const cseq = nextRegistrationCSeq;
      nextRegistrationCSeq += 1;
      const waiter = deferred<SipMessage>();
      const branch =
        `z9hG4bK-${randomBytes(8).toString("hex")}`;
      registration = { callId, cseq, branch, waiter };
      const request = buildRegister({
        config,
        server,
        callId,
        cseq,
        authorization,
        expires: requestedExpires,
        branch,
        fromTag: registrationFromTag,
      });
      await sendSignaling(request, server);
      const response = await withTimeout(
        waiter.promise,
        5_000,
        "sip_register_timeout",
      ).finally(() => {
        if (registration?.waiter === waiter) {
          registration = null;
        }
      });
      if (response.statusCode === 200) {
        registration = null;
        return registrationExpires(
          response,
          requestedExpires,
        );
      }
      if (
        attempt === 1
        && (response.statusCode === 401
          || response.statusCode === 407)
      ) {
        const challenge = response.statusCode === 407
          ? response.headers.get("proxy-authenticate")
          : response.headers.get("www-authenticate");
        if (!challenge || !config.password) {
          throw new Error("sip_register_auth_required");
        }
        authorization = {
          headerName: response.statusCode === 407
            ? "Proxy-Authorization"
            : "Authorization",
          value: buildDigestAuthorization({
            challenge,
            username: config.username,
            password: config.password,
            method: "REGISTER",
            uri: `sip:${server[0]}`,
          }),
        };
        continue;
      }
      throw new Error("sip_register_failed");
    }
    throw new Error("sip_register_failed");
  }

  async function refreshRegistration(): Promise<number> {
    if (!config.sipServer) return 0;
    if (registrationRefresh) return registrationRefresh;
    registrationRefresh = registerWithServer().finally(() => {
      registrationRefresh = null;
    });
    return registrationRefresh;
  }

  function scheduleRegistrationRefresh(
    expiresSeconds: number,
  ): void {
    if (registrationTimer) {
      clearTimeout(registrationTimer);
    }
    registrationTimer = null;
    if (!config.sipServer || expiresSeconds <= 0) return;
    const delayMilliseconds = Math.max(
      1_000,
      Math.floor(expiresSeconds * 800),
    );
    registrationTimer = setTimeout(() => {
      void refreshRegistration()
        .then(scheduleRegistrationRefresh)
        .catch(() => {
          scheduleRegistrationRefresh(30);
        });
    }, delayMilliseconds);
    registrationTimer.unref?.();
  }

  return {
    kind: "dev",
    sampleRate: 8_000,
    async start(nextHandlers) {
      if (handlers) throw new Error("sip_backend_already_started");
      handlers = nextHandlers;
      const socket = createSocket();
      signalingSocket = socket;
      registrar = createSipRegistrarRouter({
        send(message, target) {
          void sendSignaling(message, target)
            .catch(() => undefined);
        },
      });
      socket.onMessage((data, address) => {
        void handleSignaling(data, address)
          .catch(() => undefined);
      });
      try {
        registrationCallId = randomUUID();
        registrationFromTag =
          randomBytes(8).toString("hex");
        nextRegistrationCSeq = 1;
        await socket.bind(config.sipPort, config.bindHost);
        const expires = await refreshRegistration();
        scheduleRegistrationRefresh(expires);
      } catch (error) {
        handlers = null;
        signalingSocket = null;
        registrar = null;
        await socket.close().catch(() => undefined);
        throw error;
      }
    },
    async stop() {
      if (registrationTimer) {
        clearTimeout(registrationTimer);
      }
      registrationTimer = null;
      await Promise.allSettled(
        [...calls.values()].map(async (call) => {
          if (call.dialog) {
            await sendSignaling(
              buildBye(call, config),
              dialogNextHop(call.dialog),
            ).catch(() => undefined);
          }
          await endCall(call.callId, "stopped", false);
        }),
      );
      await registrationRefresh?.catch(() => undefined);
      if (config.sipServer && signalingSocket) {
        await registerWithServer(0).catch(() => undefined);
      }
      handlers = null;
      registration = null;
      registrationCallId = null;
      registrationFromTag = null;
      nextRegistrationCSeq = 1;
      const socket = signalingSocket;
      signalingSocket = null;
      registrar = null;
      await socket?.close();
    },
    async playAudio(callId, frame) {
      const call = calls.get(callId);
      if (!call) throw new Error("sip_call_not_active");
      if (frame.byteLength !== 160) {
        throw new Error("sip_dev_frame_size_invalid");
      }
      const generation = call.playbackGeneration;
      const now = monotonicNow();
      const target = call.nextPlayoutAt === null
        ? now
        : Math.max(call.nextPlayoutAt, now);
      call.nextPlayoutAt = target + 20;
      const ready = await waitForPlayout(
        call,
        Math.max(0, target - now),
        generation,
      );
      if (
        !ready
        || calls.get(callId) !== call
        || call.playbackGeneration !== generation
      ) {
        return false;
      }
      const packet = buildRtpPacket({
        payloadType: 0,
        marker: false,
        sequence: call.sequence,
        timestamp: call.timestamp,
        ssrc: call.ssrc,
        payload: frame,
      });
      call.sequence = (call.sequence + 1) & 0xffff;
      call.timestamp = (call.timestamp + 160) >>> 0;
      await call.rtpSocket.send(
        packet,
        call.remoteRtpAddress[1],
        call.remoteRtpAddress[0],
      );
      return true;
    },
    async interruptAudio(callId) {
      const call = calls.get(callId);
      if (!call) return;
      cancelPlayout(call);
    },
    async rejectCall(callId) {
      const call = calls.get(callId);
      if (call) call.rejected = true;
    },
    async hangup(callId, cause) {
      const call = calls.get(callId);
      if (!call) return;
      const request = buildBye(call, config);
      await sendSignaling(
        request,
        dialogNextHop(call.dialog!),
      ).catch(() => undefined);
      await endCall(callId, cause, true);
    },
  };

  function cancelPlayout(call: DevCall): void {
    call.playbackGeneration += 1;
    call.nextPlayoutAt = null;
    const pending = call.pendingPlayout;
    call.pendingPlayout = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
  }

  async function waitForPlayout(
    call: DevCall,
    delayMilliseconds: number,
    generation: number,
  ): Promise<boolean> {
    if (delayMilliseconds <= 0) return true;
    return new Promise<boolean>((resolve) => {
      const complete = (ready: boolean) => {
        if (call.pendingPlayout === pending) {
          call.pendingPlayout = null;
        }
        resolve(
          ready
          && call.playbackGeneration === generation,
        );
      };
      const timer = setTimeout(
        () => complete(true),
        delayMilliseconds,
      );
      const pending = { timer, resolve: complete };
      call.pendingPlayout = pending;
    });
  }
}

export function createNodeDatagramSocket():
SipDatagramSocket {
  const socket = dgram.createSocket("udp4");
  return {
    onMessage(listener) {
      socket.on("message", (data, remote) => {
        listener(data, [remote.address, remote.port]);
      });
    },
    bind(port, host) {
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
    },
    send(data, port, host) {
      return new Promise((resolve, reject) => {
        socket.send(data, port, host, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

function parseSdpAudioEndpoint(
  body: string,
  fallbackHost: string,
): SipAddress | null {
  const host =
    /^c=IN IP4 ([^\s]+)$/mu.exec(body)?.[1]
    ?? fallbackHost;
  const media =
    /^m=audio ([0-9]{1,5}) RTP\/AVP ([0-9 ]+)$/mu.exec(
      body,
    );
  const port = Number(media?.[1]);
  const payloads = media?.[2]?.split(/\s+/u) ?? [];
  if (
    !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !payloads.includes("0")
  ) {
    return null;
  }
  return [host, port];
}

function buildSdp(host: string, port: number): string {
  return [
    "v=0",
    `o=digitalmate 0 0 IN IP4 ${host}`,
    "s=DigitalMate SIP",
    `c=IN IP4 ${host}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP 0`,
    "a=rtpmap:0 PCMU/8000",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

function withTag(value: string, tag: string): string {
  return /;tag=/iu.test(value) ? value : `${value};tag=${tag}`;
}

function advertisedHost(host: string): string {
  if (host === "localhost") return "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("sip_advertised_host_required");
  }
  return host;
}

function sipUser(value: string): string {
  return /sip:([^@;>\s]+)@?/iu.exec(value)?.[1] ?? "";
}

function parseServer(value: string): SipAddress {
  const normalized = value
    .replace(/^sips?:\/\//iu, "")
    .replace(/^sips?:/iu, "")
    .split(/[;/]/u, 1)[0]!;
  const [host, portSource] = normalized.split(":");
  const port = portSource ? Number(portSource) : 5_060;
  if (
    !host
    || !/^[A-Za-z0-9.-]+$/u.test(host)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error("sip_server_invalid");
  }
  return [host, port];
}

function buildRegister(input: Readonly<{
  config: SipRunnerConfig;
  server: SipAddress;
  callId: string;
  cseq: number;
  authorization: Readonly<{
    headerName: "Authorization" | "Proxy-Authorization";
    value: string;
  }> | null;
  expires: number;
  branch: string;
  fromTag: string;
}>): string {
  const localHost = advertisedHost(input.config.bindHost);
  const uri = `sip:${input.server[0]}`;
  const from =
    `<sip:${input.config.username}@${input.server[0]}>`;
  const lines = [
    `REGISTER ${uri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${localHost}:${input.config.sipPort};branch=${input.branch}`,
    `From: ${from};tag=${input.fromTag}`,
    `To: ${from}`,
    `Call-ID: ${input.callId}`,
    `CSeq: ${input.cseq} REGISTER`,
    `Contact: <sip:${input.config.username}@${localHost}:${input.config.sipPort}>;expires=${input.expires}`,
    `Expires: ${input.expires}`,
    "Max-Forwards: 70",
  ];
  if (input.authorization) {
    lines.push(
      `${input.authorization.headerName}: `
      + input.authorization.value,
    );
  }
  lines.push("Content-Length: 0", "", "");
  return lines.join("\r\n");
}

function buildBye(
  call: DevCall,
  config: SipRunnerConfig,
): string {
  const dialog = call.dialog;
  if (!dialog) {
    throw new Error("sip_dialog_not_established");
  }
  const host = advertisedHost(config.bindHost);
  const route = dialogRoutePlan(dialog);
  dialog.localCSeq += 1;
  return [
    `BYE ${route.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${host}:${config.sipPort};branch=z9hG4bK-${randomBytes(8).toString("hex")}`,
    ...route.headers.map((value) => `Route: ${value}`),
    `From: ${dialog.localParty}`,
    `To: ${dialog.remoteParty}`,
    `Call-ID: ${call.callId}`,
    `CSeq: ${dialog.localCSeq} BYE`,
    `Contact: <sip:${config.username || "mate"}@${host}:${config.sipPort}>`,
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
}

function cseqNumber(message: SipMessage): number {
  const value = message.headers.get("cseq")?.split(/\s+/u)[0];
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed)
    || parsed < 0
    || parsed >= 0x7fff_ffff
  ) {
    throw new Error("sip_cseq_invalid");
  }
  return parsed;
}

function matchesDialog(
  message: SipMessage,
  dialog: NonNullable<DevCall["dialog"]>,
): boolean {
  return (
    sipTag(message.headers.get("from"))
      === sipTag(dialog.remoteParty)
    && sipTag(message.headers.get("to"))
      === sipTag(dialog.localParty)
  );
}

function sipTag(value: string | undefined): string | null {
  return /(?:^|;)\s*tag=([^;>\s]+)/iu.exec(
    value ?? "",
  )?.[1] ?? null;
}

function dialogNextHop(
  dialog: NonNullable<DevCall["dialog"]>,
): SipAddress {
  return parseSipTarget(dialogRoutePlan(dialog).nextHop);
}

function dialogRoutePlan(
  dialog: NonNullable<DevCall["dialog"]>,
): Readonly<{
  requestUri: string;
  headers: readonly string[];
  nextHop: string;
}> {
  const firstRoute = dialog.routeSet[0];
  if (!firstRoute) {
    return {
      requestUri: dialog.remoteTarget,
      headers: [],
      nextHop: dialog.remoteTarget,
    };
  }
  const firstUri = extractSipUri(firstRoute);
  if (hasLooseRouting(firstUri)) {
    return {
      requestUri: dialog.remoteTarget,
      headers: dialog.routeSet,
      nextHop: firstUri,
    };
  }
  return {
    requestUri: firstUri,
    headers: [
      ...dialog.routeSet.slice(1),
      `<${dialog.remoteTarget}>`,
    ],
    nextHop: firstUri,
  };
}

function hasLooseRouting(uri: string): boolean {
  return /(?:^|;)lr(?:[=;?]|$)/iu.test(uri);
}

function parseSipTarget(value: string): SipAddress {
  const uri = /<?sips?:([^@;>\s]+@)?([^;>\s]+)>?/iu
    .exec(value);
  const authority = uri?.[2] ?? "";
  const separator = authority.lastIndexOf(":");
  const hasPort =
    separator > 0
    && /^[0-9]{1,5}$/u.test(authority.slice(separator + 1));
  const host = hasPort
    ? authority.slice(0, separator)
    : authority;
  const port = hasPort
    ? Number(authority.slice(separator + 1))
    : 5_060;
  if (
    !host
    || !/^[A-Za-z0-9.-]+$/u.test(host)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error("sip_dialog_target_invalid");
  }
  return [host, port];
}

function matchesCSeq(
  value: string | undefined,
  expectedSequence: number,
  expectedMethod: string,
): boolean {
  const match = /^([0-9]+)\s+([A-Z]+)$/iu.exec(
    value?.trim() ?? "",
  );
  return (
    Number(match?.[1]) === expectedSequence
    && match?.[2]?.toUpperCase()
      === expectedMethod.toUpperCase()
  );
}

function registrationExpires(
  response: SipMessage,
  requestedExpires: number,
): number {
  const contact = response.headers.get("contact");
  const contactExpires = contact
    ? /(?:^|;)\s*expires=([0-9]{1,10})(?:;|$)/iu
        .exec(contact)?.[1]
    : undefined;
  const value =
    contactExpires ?? response.headers.get("expires");
  if (value === undefined) return requestedExpires;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed)
    || parsed < 0
    || parsed > 86_400
  ) {
    throw new Error("sip_register_expiration_invalid");
  }
  return parsed;
}

function extractSipUri(value: string): string {
  const bracketed = /<\s*(sips?:[^>]+)\s*>/iu.exec(value);
  if (bracketed?.[1]) return bracketed[1].trim();
  return /(?:^|\s)(sips?:\S+)/iu.exec(value)?.[1]
    ?.replace(/[,]+$/u, "")
    ?? "sip:unknown@invalid";
}

function buildDigestAuthorization(input: Readonly<{
  challenge: string;
  username: string;
  password: string;
  method: string;
  uri: string;
}>): string {
  const attributes = new Map<string, string>();
  for (const match of input.challenge.matchAll(
    /([a-z]+)=(?:"([^"]*)"|([^,\s]+))/giu,
  )) {
    attributes.set(
      match[1]!.toLowerCase(),
      match[2] ?? match[3] ?? "",
    );
  }
  const realm = attributes.get("realm");
  const nonce = attributes.get("nonce");
  const algorithm =
    (attributes.get("algorithm") ?? "MD5").toUpperCase();
  if (!realm || !nonce || algorithm !== "MD5") {
    throw new Error("sip_digest_challenge_unsupported");
  }
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const qop = attributes.get("qop")
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value === "auth");
  const ha1 = md5(
    `${input.username}:${realm}:${input.password}`,
  );
  const ha2 = md5(`${input.method}:${input.uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const fields = [
    `username="${input.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${input.uri}"`,
    `response="${response}"`,
    "algorithm=MD5",
  ];
  if (qop) {
    fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  return `Digest ${fields.join(", ")}`;
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(code)),
          milliseconds,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";

import type { SipRunnerConfig } from "./config.js";
import {
  buildSipResponse,
  createSipRegistrarRouter,
  parseSipMessage,
  type SipAddress,
  type SipMessage,
} from "./registrar.js";
import {
  buildRtpPacket,
  decodeMuLaw,
  parseRtpPacket,
  RtpPortAllocator,
} from "./rtp.js";
