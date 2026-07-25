import {
  CHANNEL_TYPES,
  type ChannelType,
} from "@/server/channels/manifests/catalog";

import type { ChannelAdapter } from "./adapter";
import type { AdapterDependencies } from "./types";
import { createDingTalkAdapter } from "../adapters/dingtalk";
import { createDiscordAdapter } from "../adapters/discord";
import { createFeishuAdapter } from "../adapters/feishu";
import { createMattermostAdapter } from "../adapters/mattermost";
import { createMatrixAdapter } from "../adapters/matrix";
import { createMqttAdapter } from "../adapters/mqtt";
import { createQQAdapter } from "../adapters/qq";
import { createSlackAdapter } from "../adapters/slack";
import { createTelegramAdapter } from "../adapters/telegram";
import { createWeComAdapter } from "../adapters/wecom";

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

  has(type: ChannelType): boolean {
    return this.#factories.has(type);
  }

  registeredTypes(): ChannelType[] {
    return CHANNEL_TYPES.filter((type) =>
      this.#factories.has(type)
    );
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

export function registerTelegramChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("telegram", (dependencies) =>
    createTelegramAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.http
        ? { http: dependencies.http }
        : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
      ...(dependencies.loadCursor
        ? {
            loadLastUpdateId: async (
              connectionId,
              scope,
            ) => {
              const cursor = await dependencies.loadCursor!(
                connectionId,
                scope,
                "telegram_update_id",
              );
              if (cursor === null) return null;
              const updateId = Number(cursor);
              return Number.isSafeInteger(updateId)
                && updateId >= 0
                ? updateId
                : null;
            },
          }
        : {}),
    })
  );
}

export function registerDiscordChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("discord", (dependencies) =>
    createDiscordAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
    })
  );
}

export function registerSlackChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("slack", (dependencies) =>
    createSlackAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? {
            acceptInbound: async (
              payload,
              context,
              scope,
              acknowledge,
            ) => {
              const result =
                await dependencies.acceptInbound!(
                  payload,
                  context,
                  scope,
                );
              await acknowledge();
              return result;
            },
          }
        : {}),
    })
  );
}

export function registerMattermostChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("mattermost", (dependencies) =>
    createMattermostAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
    })
  );
}

export function registerFeishuChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("feishu", (dependencies) =>
    createFeishuAdapter({
      now: dependencies.now,
      ...(dependencies.scope ? { scope: dependencies.scope } : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
    })
  );
}

export function registerDingTalkChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("dingtalk", (dependencies) =>
    createDingTalkAdapter({
      now: dependencies.now,
      ...(dependencies.scope ? { scope: dependencies.scope } : {}),
      ...(dependencies.acceptInbound
        ? {
            acceptInbound: async (
              payload,
              context,
              scope,
              acknowledge,
            ) => {
              const result =
                await dependencies.acceptInbound!(
                  payload,
                  context,
                  scope,
                );
              await acknowledge();
              return result;
            },
          }
        : {}),
    })
  );
}

export function registerQQChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("qq", (dependencies) =>
    createQQAdapter({
      now: dependencies.now,
      ...(dependencies.scope ? { scope: dependencies.scope } : {}),
      ...(dependencies.acceptInbound
        ? {
            acceptInbound: dependencies.acceptInbound,
          }
        : {}),
    })
  );
}

export function registerMqttChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("mqtt", (dependencies) =>
    createMqttAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
    })
  );
}

export function registerMatrixChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("matrix", (dependencies) =>
    createMatrixAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? { acceptInbound: dependencies.acceptInbound }
        : {}),
    })
  );
}

export function registerWeComChannelAdapter(
  registry: ChannelAdapterRegistry,
): void {
  registry.register("wecom", (dependencies) =>
    createWeComAdapter({
      now: dependencies.now,
      ...(dependencies.scope
        ? { scope: dependencies.scope }
        : {}),
      ...(dependencies.acceptInbound
        ? {
            acceptInbound: (
              payload,
              context,
              scope,
              _attachmentFetcher,
            ) => dependencies.acceptInbound!(
              payload,
              context,
              scope,
            ),
          }
        : {}),
    })
  );
}

export function registerStandardChannelAdapters(
  registry: ChannelAdapterRegistry,
): void {
  registerTelegramChannelAdapter(registry);
  registerDiscordChannelAdapter(registry);
  registerSlackChannelAdapter(registry);
  registerMattermostChannelAdapter(registry);
  registerFeishuChannelAdapter(registry);
  registerDingTalkChannelAdapter(registry);
  registerQQChannelAdapter(registry);
}
