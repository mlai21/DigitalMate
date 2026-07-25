import { describe, it } from "vitest";

import type { ChannelType } from "@/server/channels/manifests/catalog";
import type { NormalizedChannelEvent } from "@/server/channels/runtime/types";

type ContractAssertion = () => Promise<void> | void;

export type ChannelContractInput = Readonly<{
  type: ChannelType;
  assertConfig: ContractAssertion;
  assertLifecycle: ContractAssertion;
  assertInbound: ContractAssertion;
  assertStableIds: ContractAssertion;
  assertOutbound: ContractAssertion;
  assertHealth: ContractAssertion;
  assertShutdown: ContractAssertion;
}>;

export function defineChannelContract(input: ChannelContractInput): void {
  describe(`${input.type} ChannelAdapter contract`, () => {
    it(
      "validates config and never returns secret values",
      input.assertConfig,
    );
    it("starts and stops idempotently", input.assertLifecycle);
    it(
      "normalizes direct, group, mention and thread events",
      input.assertInbound,
    );
    it("uses stable external event ids", input.assertStableIds);
    it(
      "sends persisted deliveries and resolves recipients",
      input.assertOutbound,
    );
    it(
      "maps rate limit, auth, permission and network health",
      input.assertHealth,
    );
    it(
      "honors abort and closes sockets/timers",
      input.assertShutdown,
    );
  });
}

export async function assertStableExternalEventId(
  normalize: () => Promise<NormalizedChannelEvent | null>,
  attempts = 3,
): Promise<string> {
  if (!Number.isSafeInteger(attempts) || attempts < 2) {
    throw new Error("stable_event_id_attempts_invalid");
  }

  let expected: string | null = null;
  for (let index = 0; index < attempts; index += 1) {
    const event = await normalize();
    if (!event) {
      throw new Error("stable_event_id_missing_event");
    }
    if (!event.externalEventId) {
      throw new Error("stable_event_id_empty");
    }
    if (expected === null) {
      expected = event.externalEventId;
      continue;
    }
    if (event.externalEventId !== expected) {
      throw new Error("unstable_external_event_id");
    }
  }

  return expected!;
}
