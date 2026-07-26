import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  installChannelNodeBundle,
} from "./install-bundle.js";

export async function runInstall(
  argv = process.argv.slice(2),
): Promise<string> {
  const argumentsByName = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name?.startsWith("--")
      || !value
      || value.startsWith("--")
    ) {
      throw new Error("channel_node_install_arguments_invalid");
    }
    argumentsByName.set(name.slice(2), value);
  }
  if (
    argumentsByName.size !== 3
    || !argumentsByName.has("bundle")
    || !argumentsByName.has("token-file")
    || !argumentsByName.has("target")
  ) {
    throw new Error("channel_node_install_arguments_invalid");
  }
  return installChannelNodeBundle({
    bundlePath: path.resolve(argumentsByName.get("bundle")!),
    tokenPath: path.resolve(
      argumentsByName.get("token-file")!,
    ),
    targetDirectory: path.resolve(
      argumentsByName.get("target")!,
    ),
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry
    && import.meta.url === pathToFileURL(entry).href,
  );
}

if (isDirectExecution()) {
  runInstall()
    .then((configPath) => {
      process.stdout.write(`${configPath}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${
          error instanceof Error
            ? error.message
            : "channel_node_install_failed"
        }\n`,
      );
      process.exitCode = 1;
    });
}
