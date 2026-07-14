export const CHAT_BOTTOM_THRESHOLD_PX = 80;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isNearChatBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ScrollMetrics): boolean {
  return scrollHeight - scrollTop - clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
}

export function collectUnreadMessageIds(
  current: ReadonlySet<string>,
  ids: string[],
): Set<string> {
  return new Set([...current, ...ids]);
}
