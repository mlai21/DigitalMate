const RTP_HEADER_BYTES = 12;
const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32_635;

export type RtpPacket = Readonly<{
  payloadType: number;
  marker: boolean;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}>;

export function buildRtpPacket(input: RtpPacket): Buffer {
  assertUnsigned(input.payloadType, 7, "rtp_payload_type");
  assertUnsigned(input.sequence, 16, "rtp_sequence");
  assertUnsigned(input.timestamp, 32, "rtp_timestamp");
  assertUnsigned(input.ssrc, 32, "rtp_ssrc");
  const packet = Buffer.allocUnsafe(
    RTP_HEADER_BYTES + input.payload.byteLength,
  );
  packet[0] = 0x80;
  packet[1] =
    (input.marker ? 0x80 : 0)
    | input.payloadType;
  packet.writeUInt16BE(input.sequence, 2);
  packet.writeUInt32BE(input.timestamp, 4);
  packet.writeUInt32BE(input.ssrc, 8);
  input.payload.copy(packet, RTP_HEADER_BYTES);
  return packet;
}

export function parseRtpPacket(packet: Buffer): RtpPacket {
  if (packet.byteLength < RTP_HEADER_BYTES) {
    throw new Error("rtp_packet_too_short");
  }
  const version = packet[0]! >> 6;
  const padding = (packet[0]! & 0x20) !== 0;
  const extension = (packet[0]! & 0x10) !== 0;
  const csrcCount = packet[0]! & 0x0f;
  if (
    version !== 2
    || padding
    || extension
    || csrcCount !== 0
  ) {
    throw new Error("rtp_header_unsupported");
  }
  return {
    payloadType: packet[1]! & 0x7f,
    marker: (packet[1]! & 0x80) !== 0,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(RTP_HEADER_BYTES),
  };
}

export function encodeMuLaw(samples: Int16Array): Buffer {
  const result = Buffer.allocUnsafe(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    let sample = samples[index] ?? 0;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample, MU_LAW_CLIP) + MU_LAW_BIAS;
    let exponent = 7;
    for (
      let mask = 0x4000;
      exponent > 0 && (sample & mask) === 0;
      mask >>= 1
    ) {
      exponent -= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    result[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return result;
}

export function decodeMuLaw(encoded: Uint8Array): Int16Array {
  const result = new Int16Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    const value = ~(encoded[index] ?? 0) & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample =
      ((mantissa << 3) + MU_LAW_BIAS) << exponent;
    sample -= MU_LAW_BIAS;
    result[index] = sign ? -sample : sample;
  }
  return result;
}

export function pcm16LeToSamples(pcm16: Buffer): Int16Array {
  if (pcm16.byteLength % 2 !== 0) {
    throw new Error("sip_pcm16_alignment_invalid");
  }
  const samples = new Int16Array(pcm16.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm16.readInt16LE(index * 2);
  }
  return samples;
}

export class RtpPortAllocator {
  readonly #low: number;
  readonly #high: number;
  readonly #leased = new Set<number>();

  constructor(low: number, high: number) {
    if (
      !Number.isInteger(low)
      || !Number.isInteger(high)
      || low < 1_024
      || high > 65_535
      || low > high
    ) {
      throw new Error("sip_rtp_port_range_invalid");
    }
    this.#low = low % 2 === 0 ? low : low + 1;
    this.#high = high;
  }

  lease(): number {
    for (
      let port = this.#low;
      port <= this.#high;
      port += 2
    ) {
      if (this.#leased.has(port)) continue;
      this.#leased.add(port);
      return port;
    }
    throw new Error("sip_rtp_port_range_exhausted");
  }

  release(port: number): void {
    this.#leased.delete(port);
  }

  leasedCount(): number {
    return this.#leased.size;
  }
}

function assertUnsigned(
  value: number,
  bits: 7 | 16 | 32,
  name: string,
): void {
  const maximum = bits === 32
    ? 0xffffffff
    : 2 ** bits - 1;
  if (
    !Number.isInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new Error(`${name}_invalid`);
  }
}
