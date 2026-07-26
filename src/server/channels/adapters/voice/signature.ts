import twilio from "twilio";

export type TwilioSignatureInput = Readonly<{
  url: string;
  signature: string;
  params: Readonly<Record<string, string>>;
}>;

export function verifyTwilioSignature(
  input: TwilioSignatureInput,
  authToken: string,
): boolean {
  if (
    authToken.length === 0
    || input.signature.length === 0
    || !isPublicTwilioUrl(input.url)
  ) {
    return false;
  }
  try {
    return twilio.validateRequest(
      authToken,
      input.signature,
      input.url,
      { ...input.params },
    );
  } catch {
    return false;
  }
}

function isPublicTwilioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "wss:")
      && url.username.length === 0
      && url.password.length === 0
    );
  } catch {
    return false;
  }
}
