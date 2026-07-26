import { randomBytes, randomInt } from "node:crypto";

import { Root } from "protobufjs";

import bizDescriptor from "./proto/biz.json";
import connDescriptor from "./proto/conn.json";

export const YUANBAO_CONNECTION_TYPES = Object.freeze({
  connMsg: "trpc.yuanbao.conn_common.ConnMsg",
  authBindRequest: "trpc.yuanbao.conn_common.AuthBindReq",
  authBindResponse: "trpc.yuanbao.conn_common.AuthBindRsp",
  pingRequest: "trpc.yuanbao.conn_common.PingReq",
  pingResponse: "trpc.yuanbao.conn_common.PingRsp",
  kickout: "trpc.yuanbao.conn_common.KickoutMsg",
});

const BIZ_PACKAGE =
  "trpc.yuanbao.yuanbao_conn.yuanbao_openclaw_proxy";

export const YUANBAO_BUSINESS_TYPES = Object.freeze({
  inboundMessage: `${BIZ_PACKAGE}.InboundMessagePush`,
  sendC2CRequest: `${BIZ_PACKAGE}.SendC2CMessageReq`,
  sendC2CResponse: `${BIZ_PACKAGE}.SendC2CMessageRsp`,
  sendGroupRequest: `${BIZ_PACKAGE}.SendGroupMessageReq`,
  sendGroupResponse: `${BIZ_PACKAGE}.SendGroupMessageRsp`,
  privateHeartbeatRequest:
    `${BIZ_PACKAGE}.SendPrivateHeartbeatReq`,
  groupHeartbeatRequest:
    `${BIZ_PACKAGE}.SendGroupHeartbeatReq`,
});

export const YUANBAO_COMMANDS = Object.freeze({
  authBind: "auth-bind",
  ping: "ping",
  kickout: "kickout",
  sendC2C: "send_c2c_message",
  sendGroup: "send_group_message",
  privateHeartbeat: "send_private_heartbeat",
  groupHeartbeat: "send_group_heartbeat",
});

export const YUANBAO_MODULES = Object.freeze({
  connection: "conn_access",
  business: "yuanbao_openclaw_proxy",
});

export const YUANBAO_COMMAND_TYPES = Object.freeze({
  request: 0,
  response: 1,
  push: 2,
  pushAck: 3,
});

export type YuanbaoConnectionHead = Readonly<{
  cmdType: number;
  cmd: string;
  seqNo: number;
  msgId: string;
  module: string;
  needAck: boolean;
  status: number;
}>;

export type YuanbaoDecodedFrame = Readonly<{
  head: YuanbaoConnectionHead;
  data: Uint8Array;
}>;

export type YuanbaoMessageElement = Readonly<{
  msgType: string;
  msgContent: Readonly<Record<string, unknown>>;
}>;

export type YuanbaoInboundMessage = Readonly<{
  callbackCommand: string;
  fromAccount: string;
  toAccount: string;
  senderNickname: string;
  groupCode: string;
  groupName: string;
  msgSeq: number;
  msgTime: number;
  msgKey: string;
  msgId: string;
  msgBody: readonly YuanbaoMessageElement[];
  cloudCustomData: Readonly<Record<string, unknown>>;
  botOwnerId: string;
  clawMsgType: number;
}>;

export type YuanbaoCodec = ReturnType<
  typeof createYuanbaoCodec
>;

export function createYuanbaoCodec(
  options: Readonly<{
    nextSequence?: () => number;
    nextMessageId?: () => string;
    randomUint32?: () => number;
  }> = {},
) {
  const root = descriptorRoot();
  let sequence = 0;
  const nextSequence = options.nextSequence ?? (() => {
    sequence = (sequence + 1) % 2 ** 31;
    return sequence;
  });
  const nextMessageId = options.nextMessageId
    ?? (() => randomBytes(16).toString("hex"));
  const randomUint32 = options.randomUint32
    ?? (() => randomInt(0, 2 ** 32));

  return {
    encodeAuthBind(input: Readonly<{
      bizId: string;
      uid: string;
      source: string;
      token: string;
      routeEnv?: string;
    }>): Uint8Array {
      const data = encode(
        root,
        YUANBAO_CONNECTION_TYPES.authBindRequest,
        {
          bizId: input.bizId,
          authInfo: {
            uid: input.uid,
            source: input.source,
            token: input.token,
          },
          deviceInfo: {
            instanceId: "16",
          },
          ...(input.routeEnv
            ? { envName: input.routeEnv }
            : {}),
        },
      );
      return encodeFrame(root, {
        cmdType: YUANBAO_COMMAND_TYPES.request,
        cmd: YUANBAO_COMMANDS.authBind,
        seqNo: nextSequence(),
        msgId: nextMessageId(),
        module: YUANBAO_MODULES.connection,
      }, data);
    },

    decodeAuthBindResponse(raw: Uint8Array): Readonly<{
      head: YuanbaoConnectionHead;
      response: Readonly<{
        code: number;
        message: string;
        connectId: string;
        timestamp: string;
        clientIp: string;
      }>;
    }> {
      const frame = decodeFrame(root, raw);
      return {
        head: frame.head,
        response: normalizeAuthResponse(
          decode(
            root,
            YUANBAO_CONNECTION_TYPES.authBindResponse,
            frame.data,
          ),
        ),
      };
    },

    encodePing(): Uint8Array {
      const data = encode(
        root,
        YUANBAO_CONNECTION_TYPES.pingRequest,
        {},
      );
      return encodeFrame(root, {
        cmdType: YUANBAO_COMMAND_TYPES.request,
        cmd: YUANBAO_COMMANDS.ping,
        seqNo: nextSequence(),
        msgId: nextMessageId(),
        module: YUANBAO_MODULES.connection,
      }, data);
    },

    decodePingResponse(raw: Uint8Array): Readonly<{
      head: YuanbaoConnectionHead;
      heartInterval: number;
      timestamp: string;
    }> {
      const frame = decodeFrame(root, raw);
      const response = asRecord(decode(
        root,
        YUANBAO_CONNECTION_TYPES.pingResponse,
        frame.data,
      ));
      return {
        head: frame.head,
        heartInterval: safeInteger(response.heartInterval),
        timestamp: safeLong(response.timestamp),
      };
    },

    decodeKickout(raw: Uint8Array): Readonly<{
      head: YuanbaoConnectionHead;
      status: number;
      reason: string;
    }> {
      const frame = decodeFrame(root, raw);
      const response = asRecord(decode(
        root,
        YUANBAO_CONNECTION_TYPES.kickout,
        frame.data,
      ));
      return {
        head: frame.head,
        status: safeInteger(response.status),
        reason: safeString(response.reason),
      };
    },

    decodeFrame(raw: Uint8Array): YuanbaoDecodedFrame {
      return decodeFrame(root, raw);
    },

    encodePushAcknowledgement(
      original: YuanbaoConnectionHead,
    ): Uint8Array {
      return encodeFrame(root, {
        cmdType: YUANBAO_COMMAND_TYPES.pushAck,
        cmd: original.cmd,
        seqNo: nextSequence(),
        msgId: original.msgId,
        module: original.module,
      });
    },

    decodeInbound(data: Uint8Array): YuanbaoInboundMessage {
      const text = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(data);
      const parsed = JSON.parse(text) as unknown;
      return normalizeInbound(asRecord(parsed));
    },

    encodeC2CText(input: Readonly<{
      toAccount: string;
      fromAccount: string;
      text: string;
      groupCode?: string;
    }>): Readonly<{
      raw: Uint8Array;
      correlationId: string;
    }> {
      const correlationId = nextMessageId();
      const data = encode(
        root,
        YUANBAO_BUSINESS_TYPES.sendC2CRequest,
        {
          toAccount: input.toAccount,
          fromAccount: input.fromAccount,
          msgRandom: randomUint32(),
          msgBody: [textElement(input.text)],
          ...(input.groupCode
            ? { groupCode: input.groupCode }
            : {}),
        },
      );
      return {
        raw: encodeFrame(root, {
          cmdType: YUANBAO_COMMAND_TYPES.request,
          cmd: YUANBAO_COMMANDS.sendC2C,
          seqNo: nextSequence(),
          msgId: correlationId,
          module: YUANBAO_MODULES.business,
        }, data),
        correlationId,
      };
    },

    encodeGroupText(input: Readonly<{
      groupCode: string;
      fromAccount: string;
      text: string;
    }>): Readonly<{
      raw: Uint8Array;
      correlationId: string;
    }> {
      const correlationId = nextMessageId();
      const data = encode(
        root,
        YUANBAO_BUSINESS_TYPES.sendGroupRequest,
        {
          groupCode: input.groupCode,
          fromAccount: input.fromAccount,
          random: String(randomUint32()),
          msgBody: [textElement(input.text)],
        },
      );
      return {
        raw: encodeFrame(root, {
          cmdType: YUANBAO_COMMAND_TYPES.request,
          cmd: YUANBAO_COMMANDS.sendGroup,
          seqNo: nextSequence(),
          msgId: correlationId,
          module: YUANBAO_MODULES.business,
        }, data),
        correlationId,
      };
    },

    encodeTyping(input: Readonly<{
      fromAccount: string;
      toAccount: string;
      groupCode?: string;
      heartbeat: 1 | 2;
      sendTime?: number;
    }>): Readonly<{
      raw: Uint8Array;
      correlationId: string;
    }> {
      const group = Boolean(input.groupCode);
      const correlationId = nextMessageId();
      const data = encode(
        root,
        group
          ? YUANBAO_BUSINESS_TYPES.groupHeartbeatRequest
          : YUANBAO_BUSINESS_TYPES.privateHeartbeatRequest,
        {
          fromAccount: input.fromAccount,
          toAccount: input.toAccount,
          heartbeat: input.heartbeat,
          ...(input.groupCode
            ? {
                groupCode: input.groupCode,
                sendTime: input.sendTime ?? 0,
              }
            : {}),
        },
      );
      return {
        raw: encodeFrame(root, {
          cmdType: YUANBAO_COMMAND_TYPES.request,
          cmd: group
            ? YUANBAO_COMMANDS.groupHeartbeat
            : YUANBAO_COMMANDS.privateHeartbeat,
          seqNo: nextSequence(),
          msgId: correlationId,
          module: YUANBAO_MODULES.business,
        }, data),
        correlationId,
      };
    },

    decodeSendResponse(
      raw: Uint8Array,
    ): Readonly<{
      head: YuanbaoConnectionHead;
      response: Readonly<{
        code: number;
        message: string;
      }>;
    }> {
      const frame = decodeFrame(root, raw);
      const typeName = frame.head.cmd
        === YUANBAO_COMMANDS.sendGroup
        ? YUANBAO_BUSINESS_TYPES.sendGroupResponse
        : YUANBAO_BUSINESS_TYPES.sendC2CResponse;
      const response = asRecord(
        decode(root, typeName, frame.data),
      );
      return {
        head: frame.head,
        response: {
          code: safeInteger(response.code),
          message: safeString(response.message),
        },
      };
    },

    encodeConnectionFrame(input: Readonly<{
      head: Partial<YuanbaoConnectionHead>
        & Pick<YuanbaoConnectionHead, "cmdType" | "cmd">;
      typeName?: string;
      body?: Readonly<Record<string, unknown>>;
      data?: Uint8Array;
    }>): Uint8Array {
      const data = input.data
        ?? (
          input.typeName
            ? encode(root, input.typeName, input.body ?? {})
            : undefined
        );
      return encodeFrame(root, {
        seqNo: input.head.seqNo ?? nextSequence(),
        msgId: input.head.msgId ?? nextMessageId(),
        module: input.head.module ?? YUANBAO_MODULES.connection,
        ...input.head,
      }, data);
    },
  };
}

function descriptorRoot(): Root {
  const root = new Root();
  root.addJSON(connDescriptor.nested);
  root.addJSON(bizDescriptor.nested);
  root.resolveAll();
  return root;
}

function encode(
  root: Root,
  typeName: string,
  value: Readonly<Record<string, unknown>>,
): Uint8Array {
  const type = root.lookupType(typeName);
  const message = type.fromObject(value);
  const error = type.verify(message);
  if (error) {
    throw new Error(`yuanbao_protobuf_encode_invalid:${error}`);
  }
  return type.encode(message).finish();
}

function decode(
  root: Root,
  typeName: string,
  bytes: Uint8Array,
): Record<string, unknown> {
  const type = root.lookupType(typeName);
  const decoded = type.decode(bytes);
  return type.toObject(decoded, {
    defaults: false,
    enums: Number,
    longs: String,
    bytes: Array,
  }) as Record<string, unknown>;
}

function encodeFrame(
  root: Root,
  head: Readonly<{
    cmdType: number;
    cmd: string;
    seqNo: number;
    msgId: string;
    module: string;
    needAck?: boolean;
    status?: number;
  }>,
  data?: Uint8Array,
): Uint8Array {
  return encode(root, YUANBAO_CONNECTION_TYPES.connMsg, {
    head: {
      cmdType: head.cmdType,
      cmd: head.cmd,
      seqNo: head.seqNo,
      msgId: head.msgId,
      module: head.module,
      ...(head.needAck ? { needAck: true } : {}),
      ...(head.status ? { status: head.status } : {}),
    },
    ...(data && data.byteLength > 0 ? { data } : {}),
  });
}

function decodeFrame(
  root: Root,
  raw: Uint8Array,
): YuanbaoDecodedFrame {
  const decoded = decode(
    root,
    YUANBAO_CONNECTION_TYPES.connMsg,
    raw,
  );
  const head = asRecord(decoded.head);
  const data = decoded.data;
  if (
    !(data instanceof Uint8Array)
    && !Array.isArray(data)
  ) {
    return {
      head: normalizeHead(head),
      data: new Uint8Array(),
    };
  }
  return {
    head: normalizeHead(head),
    data: data instanceof Uint8Array
      ? data
      : Uint8Array.from(data),
  };
}

function normalizeHead(
  head: Record<string, unknown>,
): YuanbaoConnectionHead {
  return {
    cmdType: safeInteger(head.cmdType),
    cmd: safeString(head.cmd),
    seqNo: safeInteger(head.seqNo),
    msgId: safeString(head.msgId),
    module: safeString(head.module),
    needAck: head.needAck === true,
    status: safeInteger(head.status),
  };
}

function normalizeAuthResponse(
  response: Record<string, unknown>,
) {
  return {
    code: safeInteger(response.code),
    message: safeString(response.message),
    connectId: safeString(response.connectId),
    timestamp: safeLong(response.timestamp),
    clientIp: safeString(response.clientIp),
  };
}

function normalizeInbound(
  value: Record<string, unknown>,
): YuanbaoInboundMessage {
  const rawBody = Array.isArray(value.msg_body)
    ? value.msg_body
    : Array.isArray(value.msgBody)
      ? value.msgBody
      : [];
  const msgBody = rawBody.map((rawElement) => {
    const element = asRecord(rawElement);
    const rawContent =
      element.msg_content ?? element.msgContent;
    return {
      msgType: safeString(
        element.msg_type ?? element.msgType,
      ),
      msgContent: normalizeMessageContent(rawContent),
    };
  });
  return {
    callbackCommand: safeString(
      value.callback_command ?? value.callbackCommand,
    ),
    fromAccount: safeString(
      value.from_account ?? value.fromAccount,
    ),
    toAccount: safeString(
      value.to_account ?? value.toAccount,
    ),
    senderNickname: safeString(
      value.sender_nickname ?? value.senderNickname,
    ),
    groupCode: safeString(
      value.group_code ?? value.groupCode,
    ),
    groupName: safeString(
      value.group_name ?? value.groupName,
    ),
    msgSeq: safeInteger(value.msg_seq ?? value.msgSeq),
    msgTime: safeInteger(value.msg_time ?? value.msgTime),
    msgKey: safeString(value.msg_key ?? value.msgKey),
    msgId: safeString(value.msg_id ?? value.msgId),
    msgBody,
    cloudCustomData: normalizeJsonRecord(
      value.cloud_custom_data ?? value.cloudCustomData,
    ),
    botOwnerId: safeString(
      value.bot_owner_id ?? value.botOwnerId,
    ),
    clawMsgType: safeInteger(
      value.claw_msg_type ?? value.clawMsgType,
    ),
  };
}

function textElement(text: string) {
  return {
    msgType: "TIMTextElem",
    msgContent: {
      text,
    },
  };
}

function normalizeMessageContent(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return { text: value };
    }
  }
  return asRecord(value);
}

function normalizeJsonRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    if (!value) return {};
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return asRecord(value);
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

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (
    typeof value === "string"
    && /^\d{1,15}$/.test(value)
  ) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

function safeLong(value: unknown): string {
  return typeof value === "string"
    ? value
    : Number.isSafeInteger(value)
      ? String(value)
      : "0";
}
