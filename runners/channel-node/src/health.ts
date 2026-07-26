export type ChannelNodeHealthState =
  | "disconnected"
  | "connecting"
  | "registered"
  | "stopped";

export type ChannelNodeHealthSnapshot = Readonly<{
  state: ChannelNodeHealthState;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
}>;

export class ChannelNodeHealth {
  private snapshot: ChannelNodeHealthSnapshot = {
    state: "disconnected",
    connectedAt: null,
    lastMessageAt: null,
    lastError: null,
  };

  setState(state: ChannelNodeHealthState): void {
    this.snapshot = {
      ...this.snapshot,
      state,
      ...(state === "registered"
        ? { connectedAt: new Date().toISOString() }
        : {}),
    };
  }

  recordMessage(): void {
    this.snapshot = {
      ...this.snapshot,
      lastMessageAt: new Date().toISOString(),
    };
  }

  recordError(code: string): void {
    this.snapshot = {
      ...this.snapshot,
      lastError: code,
    };
  }

  getSnapshot(): ChannelNodeHealthSnapshot {
    return { ...this.snapshot };
  }
}
