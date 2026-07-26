export const ONEBOT_ACTIONS = [
  "send_private_msg",
  "send_group_msg",
  "get_image",
  "get_file",
] as const;

export type OneBotAction = (typeof ONEBOT_ACTIONS)[number];

export type OneBotActionResponse = Readonly<{
  status: "ok" | "failed";
  retcode: number;
  data: Readonly<Record<string, unknown>>;
  wording?: string;
}>;

export function isOneBotAction(value: unknown): value is OneBotAction {
  return typeof value === "string"
    && ONEBOT_ACTIONS.includes(value as OneBotAction);
}

export function parseOneBotActionResponse(
  value: unknown,
): (OneBotActionResponse & { echo: string }) | null {
  const record = asRecord(value);
  const status = record.status;
  const retcode = record.retcode;
  const echo = record.echo;
  if (
    (status !== "ok" && status !== "failed")
    || typeof retcode !== "number"
    || !Number.isSafeInteger(retcode)
    || typeof echo !== "string"
    || echo.length === 0
    || echo.length > 128
  ) {
    return null;
  }
  return {
    status,
    retcode,
    data: asRecord(record.data),
    echo,
    ...(typeof record.wording === "string"
      ? { wording: record.wording.slice(0, 512) }
      : {}),
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
