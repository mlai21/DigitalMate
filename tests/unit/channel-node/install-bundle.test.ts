import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encryptChannelNodeBundle,
} from "@/server/admin/channel-node-certificates";
import {
  installChannelNodeBundle,
} from "../../../runners/channel-node/src/install-bundle";

const directories: string[] = [];
const NODE_ID = "20000000-0000-4000-8000-000000000021";
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000022";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("channel-node encrypted bundle installer", () => {
  it("writes private material and node config with strict modes", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "channel-node-install-test-"),
    );
    directories.push(directory);
    const target = path.join(directory, "installed");
    const bundlePath = path.join(directory, "node.dmnode");
    const tokenPath = path.join(directory, "token");
    const token =
      "test-enrollment-token-with-at-least-thirty-two-bytes";
    const bundle = await encryptChannelNodeBundle(
      {
        version: 1,
        node: {
          id: NODE_ID,
          server_url:
            "wss://mate.example.com:9443/channel-node",
          connection_ids: [CONNECTION_ID],
        },
        files: {
          certificate_authority: "test-ca",
          certificate: "test-certificate",
          private_key: "test-private-key",
        },
      },
      token,
    );
    await writeFile(bundlePath, JSON.stringify(bundle));
    await writeFile(tokenPath, token, { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    const configPath = await installChannelNodeBundle({
      bundlePath,
      tokenPath,
      targetDirectory: target,
    });
    const config = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;

    expect(config).toMatchObject({
      nodeId: NODE_ID,
      serverUrl:
        "wss://mate.example.com:9443/channel-node",
      connectionIds: [CONNECTION_ID],
      keyPath: path.join(target, "node.key"),
    });
    expect(
      (await stat(path.join(target, "node.key"))).mode
      & 0o777,
    ).toBe(0o600);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(path.join(target, "ca.pem"))).mode
      & 0o777,
    ).toBe(0o644);
  });

  it("fails closed and removes a partial target for the wrong token", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "channel-node-install-test-"),
    );
    directories.push(directory);
    const target = path.join(directory, "installed");
    const bundlePath = path.join(directory, "node.dmnode");
    const tokenPath = path.join(directory, "token");
    const bundle = await encryptChannelNodeBundle(
      {
        version: 1,
        node: {
          id: NODE_ID,
          server_url:
            "wss://mate.example.com:9443/channel-node",
          connection_ids: [CONNECTION_ID],
        },
        files: {
          certificate_authority: "test-ca",
          certificate: "test-certificate",
          private_key: "test-private-key",
        },
      },
      "correct-token-with-at-least-thirty-two-bytes",
    );
    await writeFile(bundlePath, JSON.stringify(bundle));
    await writeFile(
      tokenPath,
      "wrong-token-with-at-least-thirty-two-bytes",
      { mode: 0o600 },
    );
    await chmod(tokenPath, 0o600);

    await expect(
      installChannelNodeBundle({
        bundlePath,
        tokenPath,
        targetDirectory: target,
      }),
    ).rejects.toThrow(
      "channel_node_bundle_decryption_failed",
    );
    await expect(stat(target)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
