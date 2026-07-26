import {
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const HEX_KEY = /^[0-9a-f]{32}$/i;

export function parseWechatAesKey(
  encoded: string,
): Buffer {
  const normalized = encoded.trim();
  if (HEX_KEY.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    throw new Error("wechat_aes_key_invalid");
  }
  if (decoded.byteLength === 16) return decoded;
  const decodedText = decoded.toString("ascii");
  if (
    decoded.byteLength === 32
    && HEX_KEY.test(decodedText)
  ) {
    return Buffer.from(decodedText, "hex");
  }
  throw new Error("wechat_aes_key_invalid");
}

export function encryptWechatMedia(
  plaintext: Uint8Array,
  encodedKey: string,
): Buffer {
  const cipher = createCipheriv(
    "aes-128-ecb",
    parseWechatAesKey(encodedKey),
    null,
  );
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
}

export function decryptWechatMedia(
  ciphertext: Uint8Array,
  encodedKey: string,
): Buffer {
  if (ciphertext.byteLength === 0
    || ciphertext.byteLength % 16 !== 0) {
    throw new Error("wechat_media_ciphertext_invalid");
  }
  const decipher = createDecipheriv(
    "aes-128-ecb",
    parseWechatAesKey(encodedKey),
    null,
  );
  decipher.setAutoPadding(true);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new Error("wechat_media_decryption_failed");
  }
}
