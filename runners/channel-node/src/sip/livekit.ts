import {
  AccessToken,
  RoomServiceClient,
  SipClient,
} from "livekit-server-sdk";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from "@livekit/rtc-node";

import type {
  SipBackend,
  SipBackendHandlers,
} from "./backend.js";
import type { SipRunnerConfig } from "./config.js";
import { pcm16LeToSamples } from "./rtp.js";

type LiveKitRoomState = {
  roomName: string;
  room: Room;
  source: AudioSource;
  track: LocalAudioTrack;
  participantIdentity: string | null;
  pendingParticipantIdentity: string | null;
  pendingCallId: string | null;
  callId: string | null;
  generation: number;
  privacyBlocked: boolean;
  preflightComplete: boolean;
  disposeTask: Promise<void> | null;
  remoteDeletionRequested: boolean;
  remoteDeleted: boolean;
  trackPublished: boolean;
  publishTrackTask: Promise<void> | null;
  remoteParticipants: Map<string, RemoteParticipant>;
  readTasks: Set<Promise<void>>;
  readTracks: WeakSet<object>;
  cancelReaders: Set<() => Promise<void>>;
  disconnectedIdentities: Set<string>;
};

export type LiveKitSipBackendDependencies = Readonly<{
  roomService?: Pick<
    RoomServiceClient,
    | "listRooms"
    | "listParticipants"
    | "removeParticipant"
    | "deleteRoom"
  >;
  sipService?: Pick<
    SipClient,
    "listSipInboundTrunk" | "listSipDispatchRule"
  >;
  createRoom?: () => Room;
  createAudioSource?: () => AudioSource;
  createAudioTrack?: (
    source: AudioSource,
  ) => LocalAudioTrack;
  createAudioStream?: (
    track: RemoteTrack,
  ) => AudioStream;
  createAudioFrame?: (
    samples: Int16Array,
  ) => AudioFrame;
  createToken?: (roomName: string) => Promise<string>;
}>;

export function createLiveKitSipBackend(
  config: SipRunnerConfig,
  dependencies: LiveKitSipBackendDependencies = {},
): SipBackend {
  if (config.mode !== "livekit" || !config.liveKit) {
    throw new Error("sip_livekit_config_required");
  }
  const liveKit = config.liveKit;
  const serviceUrl = liveKit.url
    .replace(/^ws:/u, "http:")
    .replace(/^wss:/u, "https:")
    .replace(/\/$/u, "");
  const roomService =
    dependencies.roomService
    ?? new RoomServiceClient(
      serviceUrl,
      liveKit.apiKey,
      liveKit.apiSecret,
    );
  const sipService =
    dependencies.sipService
    ?? new SipClient(
      serviceUrl,
      liveKit.apiKey,
      liveKit.apiSecret,
    );
  const rooms = new Map<string, LiveKitRoomState>();
  const calls = new Map<string, LiveKitRoomState>();
  const pendingCallIds = new Set<string>();
  let handlers: SipBackendHandlers | null = null;
  let backendGeneration = 0;
  let discoveryTimer: ReturnType<typeof setInterval> | null =
    null;
  let discovery: Promise<void> | null = null;
  let activeDispatchRuleId: string | null = null;

  async function connectRoom(roomName: string): Promise<void> {
    if (!handlers || rooms.has(roomName)) return;
    const token = dependencies.createToken
      ? await dependencies.createToken(roomName)
      : await createRoomToken(config, roomName);
    const room = dependencies.createRoom?.() ?? new Room();
    const source =
      dependencies.createAudioSource?.()
      ?? new AudioSource(
        liveKit.sampleRate,
        1,
        250,
      );
    const track =
      dependencies.createAudioTrack?.(source)
      ?? LocalAudioTrack.createAudioTrack(
        "digitalmate-sip-tts",
        source,
      );
    const state: LiveKitRoomState = {
      roomName,
      room,
      source,
      track,
      participantIdentity: null,
      pendingParticipantIdentity: null,
      pendingCallId: null,
      callId: null,
      generation: 0,
      privacyBlocked: false,
      preflightComplete: false,
      disposeTask: null,
      remoteDeletionRequested: false,
      remoteDeleted: false,
      trackPublished: false,
      publishTrackTask: null,
      remoteParticipants: new Map(),
      readTasks: new Set(),
      readTracks: new WeakSet(),
      cancelReaders: new Set(),
      disconnectedIdentities: new Set(),
    };
    room.on(
      RoomEvent.ParticipantConnected,
      (participant) => {
        state.remoteParticipants.set(
          participant.identity,
          participant,
        );
        if (state.preflightComplete) {
          void prepareParticipant(state, participant)
            .catch(() => undefined);
        }
      },
    );
    room.on(
      RoomEvent.ParticipantDisconnected,
      (participant) => {
        state.remoteParticipants.delete(participant.identity);
        void endParticipant(state, participant)
          .catch(() => undefined);
      },
    );
    room.on(
      RoomEvent.TrackSubscribed,
      (remoteTrack, _publication, participant) => {
        if (
          state.participantIdentity === participant.identity
          && state.callId
        ) {
          startAudioRead(
            state,
            remoteTrack,
            participant.identity,
            state.callId,
            state.generation,
          );
        }
      },
    );
    room.on(RoomEvent.Disconnected, () => {
      if (!state.disposeTask) {
        void handleRoomDisconnected(state)
          .catch(() => undefined);
      }
    });
    rooms.set(roomName, state);
    try {
      await room.connect(liveKit.url, token);
      if (!handlers || rooms.get(roomName) !== state) {
        await disposeRoom(state, false);
        return;
      }
      if (!room.localParticipant) {
        throw new Error(
          "sip_livekit_local_participant_unavailable",
        );
      }
      for (const participant of room.remoteParticipants.values()) {
        state.remoteParticipants.set(
          participant.identity,
          participant,
        );
      }
      const existingParticipants =
        [...state.remoteParticipants.values()];
      if (existingParticipants.length === 0) {
        await disposeRoom(state, true);
        return;
      }
      if (existingParticipants.length > 1) {
        state.privacyBlocked = true;
        await quarantineRoom(
          state,
          existingParticipants[1]!.identity,
        );
        return;
      }
      state.preflightComplete = true;
      void prepareParticipant(
        state,
        existingParticipants[0]!,
      ).catch(() => undefined);
    } catch (error) {
      if (rooms.get(roomName) === state) {
        rooms.delete(roomName);
      }
      await Promise.allSettled([
        room.disconnect(),
        track.close(true),
      ]);
      throw error;
    }
  }

  async function prepareParticipant(
    state: LiveKitRoomState,
    participant: RemoteParticipant,
  ): Promise<void> {
    if (
      state.privacyBlocked
      || state.remoteParticipants.size !== 1
      || participant.kind !== ParticipantKind.SIP
      || !matchesDispatchParticipant(
        participant.kind,
        participant.attributes,
      )
      || (
        state.participantIdentity
        && state.participantIdentity !== participant.identity
      )
      || (
        state.pendingParticipantIdentity
        && state.pendingParticipantIdentity
          !== participant.identity
      )
    ) {
      state.privacyBlocked = true;
      state.source.clearQueue();
      await quarantineRoom(state, participant.identity);
      return;
    }
    try {
      await ensureTrackPublished(state);
      if (
        state.privacyBlocked
        || rooms.get(state.roomName) !== state
      ) {
        return;
      }
      await acceptParticipant(state, participant);
    } catch {
      state.privacyBlocked = true;
      await quarantineRoom(state, participant.identity);
    }
  }

  async function ensureTrackPublished(
    state: LiveKitRoomState,
  ): Promise<void> {
    if (state.trackPublished) return;
    if (state.publishTrackTask) {
      return state.publishTrackTask;
    }
    const participant = state.room.localParticipant;
    if (!participant) {
      throw new Error(
        "sip_livekit_local_participant_unavailable",
      );
    }
    state.publishTrackTask = participant.publishTrack(
      state.track,
      new TrackPublishOptions({
        source: TrackSource.SOURCE_MICROPHONE,
      }),
    ).then(() => {
      state.trackPublished = true;
    }).finally(() => {
      state.publishTrackTask = null;
    });
    return state.publishTrackTask;
  }

  async function acceptParticipant(
    state: LiveKitRoomState,
    participant: RemoteParticipant,
  ): Promise<void> {
    const activeHandlers = handlers;
    const admissionGeneration = backendGeneration;
    if (
      !activeHandlers
      || participant.kind !== ParticipantKind.SIP
      || rooms.get(state.roomName) !== state
    ) {
      return;
    }
    if (
      state.privacyBlocked
      || (state.participantIdentity
        && state.participantIdentity !== participant.identity)
      || (state.pendingParticipantIdentity
        && state.pendingParticipantIdentity
          !== participant.identity)
    ) {
      state.privacyBlocked = true;
      state.source.clearQueue();
      await quarantineRoom(state, participant.identity);
      return;
    }
    if (state.participantIdentity === participant.identity) {
      return;
    }
    if (
      state.pendingParticipantIdentity
        === participant.identity
    ) {
      return;
    }
    const callId = normalizedCallId(participant);
    if (
      calls.has(callId)
      || pendingCallIds.has(callId)
    ) {
      await roomService.removeParticipant(
        state.roomName,
        participant.identity,
      );
      await disposeRoom(state, true);
      return;
    }
    state.pendingParticipantIdentity = participant.identity;
    state.pendingCallId = callId;
    pendingCallIds.add(callId);
    try {
      const disposition = await activeHandlers.onIncomingCall({
        callId,
        fromUri:
          participant.attributes["sip.phoneNumber"]
          ?? participant.identity,
        toUri:
          participant.attributes["sip.trunkPhoneNumber"]
          ?? liveKit.sipTrunkId,
      });
      if (
        handlers !== activeHandlers
        || backendGeneration !== admissionGeneration
        || rooms.get(state.roomName) !== state
      ) {
        if (disposition === "accepted") {
          await activeHandlers.onCallEnded(
            callId,
            "backend_stopped",
          );
        }
        return;
      }
      if (disposition !== "accepted") {
        await roomService.removeParticipant(
          state.roomName,
          participant.identity,
        );
        await disposeRoom(state, true);
        return;
      }
      if (
        participant.disconnectReason !== undefined
        || state.disconnectedIdentities.has(
          participant.identity,
        )
      ) {
        await activeHandlers.onCallEnded(
          callId,
          "participant_disconnected",
        );
        await disposeRoom(state, true);
        return;
      }
      if (
        state.participantIdentity
        || calls.has(callId)
      ) {
        await activeHandlers.onCallEnded(
          callId,
          "admission_conflict",
        );
        await roomService.removeParticipant(
          state.roomName,
          participant.identity,
        );
        await disposeRoom(state, true);
        return;
      }
      state.participantIdentity = participant.identity;
      state.callId = callId;
      state.generation += 1;
      const generation = state.generation;
      calls.set(callId, state);
      for (
        const publication
        of participant.trackPublications.values()
      ) {
        if (
          publication.track
          && publication.track.kind === TrackKind.KIND_AUDIO
        ) {
          startAudioRead(
            state,
            publication.track as RemoteTrack,
            participant.identity,
            callId,
            generation,
          );
        }
      }
      try {
        await activeHandlers.onCallReady(callId);
      } catch {
        calls.delete(callId);
        state.callId = null;
        state.participantIdentity = null;
        state.generation += 1;
        state.source.clearQueue();
        await cancelRoomReaders(state);
        await activeHandlers.onCallEnded(
          callId,
          "media_initialization_failed",
        );
        await roomService.removeParticipant(
          state.roomName,
          participant.identity,
        );
        await disposeRoom(state, true);
      }
    } finally {
      pendingCallIds.delete(callId);
      if (
        state.pendingParticipantIdentity
          === participant.identity
      ) {
        state.pendingParticipantIdentity = null;
      }
      if (state.pendingCallId === callId) {
        state.pendingCallId = null;
      }
      state.disconnectedIdentities.delete(
        participant.identity,
      );
    }
  }

  function startAudioRead(
    state: LiveKitRoomState,
    track: RemoteTrack,
    participantIdentity: string,
    callId: string,
    generation: number,
  ): void {
    if (
      track.kind !== TrackKind.KIND_AUDIO
      || state.readTracks.has(track)
    ) {
      return;
    }
    state.readTracks.add(track);
    const task = readAudioTrack(
      state,
      track,
      participantIdentity,
      callId,
      generation,
    )
      .catch(() => undefined)
      .finally(() => {
        state.readTasks.delete(task);
      });
    state.readTasks.add(task);
  }

  async function endParticipant(
    state: LiveKitRoomState,
    participant: RemoteParticipant,
  ): Promise<void> {
    if (
      participant.identity
        === state.pendingParticipantIdentity
    ) {
      state.disconnectedIdentities.add(
        participant.identity,
      );
      return;
    }
    if (
      !state.callId
      || participant.identity !== state.participantIdentity
    ) {
      return;
    }
    const callId = state.callId;
    calls.delete(callId);
    state.callId = null;
    state.participantIdentity = null;
    state.generation += 1;
    state.source.clearQueue();
    await cancelRoomReaders(state);
    await handlers?.onCallEnded(
      callId,
      "participant_disconnected",
    );
    await disposeRoom(state, true);
  }

  async function readAudioTrack(
    state: LiveKitRoomState,
    track: RemoteTrack,
    participantIdentity: string,
    callId: string,
    generation: number,
  ): Promise<void> {
    const stream =
      dependencies.createAudioStream?.(track)
      ?? new AudioStream(track, {
        sampleRate: liveKit.sampleRate,
        numChannels: 1,
        frameSizeMs: 20,
    });
    const reader = stream.getReader();
    const cancel = async () => {
      await reader.cancel().catch(() => undefined);
    };
    state.cancelReaders.add(cancel);
    try {
      while (
        handlers
        && state.callId === callId
        && state.participantIdentity === participantIdentity
        && state.generation === generation
      ) {
        const next = await reader.read();
        if (next.done) break;
        const frame = next.value;
        const pcm16 = Buffer.allocUnsafe(
          frame.data.length * 2,
        );
        for (
          let index = 0;
          index < frame.data.length;
          index += 1
        ) {
          pcm16.writeInt16LE(
            frame.data[index] ?? 0,
            index * 2,
          );
        }
        const activeHandlers = handlers;
        if (
          !activeHandlers
          || state.callId !== callId
          || state.participantIdentity !== participantIdentity
          || state.generation !== generation
        ) {
          break;
        }
        await activeHandlers.onPcm(callId, pcm16);
      }
    } finally {
      state.cancelReaders.delete(cancel);
      reader.releaseLock();
    }
  }

  async function discoverRooms(): Promise<void> {
    if (!handlers || discovery) return discovery ?? undefined;
    discovery = (async () => {
      const activeRooms = await roomService.listRooms();
      const matchingNames = activeRooms
        .map((room) => room.name)
        .filter((name) =>
          name !== liveKit.roomName
          && name.startsWith(liveKit.roomName)
        )
        .sort();
      let overflowHandled = false;
      for (const roomName of matchingNames) {
        if (rooms.has(roomName)) continue;
        if (!await isOwnedDispatchRoom(roomName)) continue;
        if (
          rooms.size >= config.maxCalls
          && overflowHandled
        ) {
          await roomService.deleteRoom(roomName)
            .catch(() => undefined);
          continue;
        }
        if (rooms.size >= config.maxCalls) {
          overflowHandled = true;
        }
        await connectRoom(roomName);
      }
    })().finally(() => {
      discovery = null;
    });
    return discovery;
  }

  return {
    kind: "livekit",
    sampleRate: 24_000,
    async start(nextHandlers) {
      if (handlers) throw new Error("sip_backend_already_started");
      const trunks = await sipService.listSipInboundTrunk({
        trunkIds: [liveKit.sipTrunkId],
      });
      if (
        trunks.length !== 1
        || trunks[0]?.sipTrunkId !== liveKit.sipTrunkId
      ) {
        throw new Error("sip_livekit_trunk_unavailable");
      }
      const dispatchRules =
        await sipService.listSipDispatchRule({
          trunkIds: [liveKit.sipTrunkId],
        });
      const matchingRules = dispatchRules.filter((item) => {
        const rule = item.rule?.rule;
        return (
          rule?.case === "dispatchRuleIndividual"
          && rule.value.roomPrefix === liveKit.roomName
          && !rule.value.noRandomness
          && (
            item.trunkIds.length === 0
            || item.trunkIds.includes(liveKit.sipTrunkId)
          )
        );
      });
      if (
        dispatchRules.length !== 1
        || matchingRules.length !== 1
      ) {
        throw new Error(
          "sip_livekit_individual_dispatch_required",
        );
      }
      const dispatchRuleId =
        matchingRules[0]?.sipDispatchRuleId;
      if (!dispatchRuleId) {
        throw new Error(
          "sip_livekit_dispatch_rule_id_required",
        );
      }
      backendGeneration += 1;
      activeDispatchRuleId = dispatchRuleId;
      handlers = nextHandlers;
      try {
        await discoverRooms();
      } catch (error) {
        backendGeneration += 1;
        handlers = null;
        activeDispatchRuleId = null;
        const states = [...rooms.values()];
        rooms.clear();
        await Promise.allSettled(
          states.map((state) => disposeRoom(state, false)),
        );
        throw error;
      }
      discoveryTimer = setInterval(() => {
        void discoverRooms().catch(() => undefined);
      }, 2_000);
      discoveryTimer.unref?.();
    },
    async stop() {
      backendGeneration += 1;
      handlers = null;
      if (discoveryTimer) clearInterval(discoveryTimer);
      discoveryTimer = null;
      calls.clear();
      const states = [...rooms.values()];
      rooms.clear();
      await Promise.allSettled(
        states.map((state) => disposeRoom(state, true)),
      );
      activeDispatchRuleId = null;
    },
    async playAudio(callId, frame) {
      const state = calls.get(callId);
      if (!state || state.privacyBlocked) {
        throw new Error("sip_call_not_active");
      }
      if (frame.byteLength !== 960) {
        throw new Error("sip_livekit_frame_size_invalid");
      }
      const samples = pcm16LeToSamples(frame);
      const audioFrame = dependencies.createAudioFrame
        ? dependencies.createAudioFrame(samples)
        : new AudioFrame(
          samples,
          liveKit.sampleRate,
          1,
          samples.length,
      );
      await state.source.captureFrame(audioFrame);
      return true;
    },
    async interruptAudio(callId) {
      calls.get(callId)?.source.clearQueue();
    },
    async rejectCall(callId) {
      const state = calls.get(callId);
      if (!state?.participantIdentity) return;
      await roomService.removeParticipant(
        state.roomName,
        state.participantIdentity,
      );
      await disposeRoom(state, true);
    },
    async hangup(callId) {
      const state = calls.get(callId);
      if (!state?.participantIdentity) return;
      await roomService.removeParticipant(
        state.roomName,
        state.participantIdentity,
      );
      await disposeRoom(state, true);
    },
  };

  async function disposeRoom(
    state: LiveKitRoomState,
    deleteRemote: boolean,
  ): Promise<void> {
    if (deleteRemote) state.remoteDeletionRequested = true;
    if (state.disposeTask) {
      await state.disposeTask;
      await deleteRemoteRoomIfRequested(state);
      return;
    }
    const task = (async () => {
      rooms.delete(state.roomName);
      if (state.callId) calls.delete(state.callId);
      if (state.pendingCallId) {
        pendingCallIds.delete(state.pendingCallId);
      }
      state.callId = null;
      state.participantIdentity = null;
      state.pendingParticipantIdentity = null;
      state.pendingCallId = null;
      state.remoteParticipants.clear();
      state.generation += 1;
      state.source.clearQueue();
      await cancelRoomReaders(state);
      await Promise.allSettled([
        ...state.readTasks,
        ...(state.publishTrackTask
          ? [state.publishTrackTask]
          : []),
        state.room.disconnect(),
        state.track.close(true),
      ]);
      await deleteRemoteRoomIfRequested(state);
    })();
    state.disposeTask = task;
    return task;
  }

  async function deleteRemoteRoomIfRequested(
    state: LiveKitRoomState,
  ): Promise<void> {
    if (
      !state.remoteDeletionRequested
      || state.remoteDeleted
    ) {
      return;
    }
    state.remoteDeleted = true;
    await roomService.deleteRoom(state.roomName)
      .catch(() => {
        state.remoteDeleted = false;
      });
  }

  async function quarantineRoom(
    state: LiveKitRoomState,
    unexpectedIdentity: string,
  ): Promise<void> {
    state.privacyBlocked = true;
    state.source.clearQueue();
    const callId = state.callId;
    if (callId) {
      calls.delete(callId);
      await handlers?.onCallEnded(
        callId,
        "room_isolation_violation",
      );
    }
    await roomService.removeParticipant(
      state.roomName,
      unexpectedIdentity,
    ).catch(() => undefined);
    await disposeRoom(state, true);
  }

  async function handleRoomDisconnected(
    state: LiveKitRoomState,
  ): Promise<void> {
    const callId = state.callId;
    if (callId) {
      calls.delete(callId);
      await handlers?.onCallEnded(
        callId,
        "livekit_room_disconnected",
      );
    }
    await disposeRoom(state, false);
  }

  async function cancelRoomReaders(
    state: LiveKitRoomState,
  ): Promise<void> {
    const cancellations = [...state.cancelReaders];
    state.cancelReaders.clear();
    await Promise.allSettled(
      cancellations.map((cancel) => cancel()),
    );
  }

  async function isOwnedDispatchRoom(
    roomName: string,
  ): Promise<boolean> {
    const dispatchRuleId = activeDispatchRuleId;
    if (!dispatchRuleId) return false;
    const participants = await roomService
      .listParticipants(roomName)
      .catch(() => []);
    return (
      participants.length > 0
      && participants.every((participant) =>
        matchesDispatchParticipant(
          participant.kind,
          participant.attributes,
        )
      )
    );
  }

  function matchesDispatchParticipant(
    kind: number,
    attributes: Readonly<Record<string, string>>,
  ): boolean {
    return (
      kind === ParticipantKind.SIP
      && attributes["sip.trunkID"] === liveKit.sipTrunkId
      && attributes["sip.ruleID"] === activeDispatchRuleId
    );
  }
}

async function createRoomToken(
  config: SipRunnerConfig,
  roomName: string,
): Promise<string> {
  if (!config.liveKit) {
    throw new Error("sip_livekit_config_required");
  }
  const token = new AccessToken(
    config.liveKit.apiKey,
    config.liveKit.apiSecret,
    {
      identity:
        `digitalmate-sip-${config.connectionId.slice(0, 8)}`,
      ttl: 10 * 60,
    },
  );
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}

function normalizedCallId(
  participant: RemoteParticipant,
): string {
  const value =
    participant.attributes["sip.callID"]
    ?? participant.attributes["sip.callId"]
    ?? participant.identity;
  if (
    !value
    || value.length > 900
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("sip_livekit_call_id_invalid");
  }
  return value;
}
