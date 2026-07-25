import {
  CHANNEL_TYPES,
  type ChannelType,
} from "@/server/channels/manifests/catalog";

import type { ChannelAdapter } from "./adapter";
import type { AdapterDependencies } from "./types";

export type ChannelAdapterFactory = (
  dependencies: AdapterDependencies,
) => ChannelAdapter<Record<string, unknown>>;

export class ChannelAdapterRegistry {
  readonly #factories = new Map<ChannelType, ChannelAdapterFactory>();

  register(type: ChannelType, factory: ChannelAdapterFactory): void {
    if (this.#factories.has(type)) {
      throw new Error(`duplicate_channel_adapter:${type}`);
    }
    this.#factories.set(type, factory);
  }

  assertComplete(): void {
    const missing = CHANNEL_TYPES.filter(
      (type) => !this.#factories.has(type),
    );
    if (missing.length > 0) {
      throw new Error(`channel_adapters_missing:${missing.join(",")}`);
    }
  }

  create(
    type: ChannelType,
    dependencies: AdapterDependencies,
  ): ChannelAdapter<Record<string, unknown>> {
    const factory = this.#factories.get(type);
    if (!factory) {
      throw new Error(`channel_adapter_not_registered:${type}`);
    }
    return factory(dependencies);
  }
}
