#!/usr/bin/env node

import {
  lstat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function renderLaunchdPlist(input) {
  const label = input.label ?? "com.digitalmate.channel-node";
  const values = [
    ["Label", label],
    ["ProgramArguments", [
      process.execPath,
      input.runnerPath,
    ]],
    ["KeepAlive", true],
    ["RunAtLoad", true],
    ["StandardOutPath", path.join(input.logDirectory, "channel-node.log")],
    ["StandardErrorPath", path.join(input.logDirectory, "channel-node.error.log")],
    ["EnvironmentVariables", {
      CHANNEL_NODE_CONFIG_PATH: input.configPath,
    }],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
      + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...values.flatMap(([key, value]) => [
      `  <key>${escapeXml(key)}</key>`,
      ...renderValue(value, 1),
    ]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function writeLaunchdPlist(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const outputPath = path.resolve(cwd, input.output);
  if (path.dirname(outputPath) !== cwd) {
    throw new Error("channel_node_plist_output_must_be_in_cwd");
  }
  for (const [name, value] of [
    ["runner", input.runnerPath],
    ["config", input.configPath],
    ["logs", input.logDirectory],
  ]) {
    if (!path.isAbsolute(value)) {
      throw new Error(`channel_node_${name}_path_must_be_absolute`);
    }
  }
  const logMetadata = await lstat(input.logDirectory);
  if (
    !logMetadata.isDirectory()
    || (logMetadata.mode & 0o077) !== 0
  ) {
    throw new Error("channel_node_log_directory_not_private");
  }
  const plist = renderLaunchdPlist(input);
  await writeFile(outputPath, plist, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return outputPath;
}

function renderValue(value, depth) {
  const indent = "  ".repeat(depth + 1);
  if (typeof value === "string") {
    return [`${indent}<string>${escapeXml(value)}</string>`];
  }
  if (typeof value === "boolean") {
    return [`${indent}<${value ? "true" : "false"}/>`];
  }
  if (Array.isArray(value)) {
    return [
      `${indent}<array>`,
      ...value.flatMap((item) => renderValue(item, depth + 1)),
      `${indent}</array>`,
    ];
  }
  return [
    `${indent}<dict>`,
    ...Object.entries(value).flatMap(([key, item]) => [
      `${indent}  <key>${escapeXml(key)}</key>`,
      ...renderValue(item, depth + 1),
    ]),
    `${indent}</dict>`,
  ];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("channel_node_launchd_arguments_invalid");
    }
    parsed[name.slice(2)] = value;
  }
  return {
    runnerPath: parsed.runner,
    configPath: parsed.config,
    logDirectory: parsed.logs,
    output: parsed.output ?? "com.digitalmate.channel-node.plist",
    ...(parsed.label ? { label: parsed.label } : {}),
  };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(
    path.resolve(process.argv[1]),
  ).href
) {
  writeLaunchdPlist(parseArguments(process.argv.slice(2)))
    .then((outputPath) => {
      process.stdout.write(`${outputPath}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
