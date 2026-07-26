import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UPSTREAM } from "./sync.mjs";
import {
  readChecksums,
  renderChecksums,
  verifySnapshot,
} from "./verify-upstream.mjs";

const EXPECTED_UPSTREAM = Object.freeze({
  tag: "v2.0.0.post3",
  commit: "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
});
const CONFIG_FILES = Object.freeze([
  "reference/src/qwenpaw/config/config.py",
  "reference/src/qwenpaw/app/routers/config.py",
]);
const LEDGER_START = "<!-- qwenpaw-channel-parity-ledger:start -->";
const LEDGER_END = "<!-- qwenpaw-channel-parity-ledger:end -->";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");

export const STANDARD_CHANNEL_AUDIT = Object.freeze({
  telegram: Object.freeze({
    upstreamDirectory: "telegram",
    configClass: "TelegramConfig",
    upstreamUnitTest: "test_telegram.py",
    upstreamContractTest: "test_telegram_contract.py",
  }),
  discord: Object.freeze({
    upstreamDirectory: "discord_",
    configClass: "DiscordConfig",
    upstreamUnitTest: "test_discord.py",
    upstreamContractTest: "test_discord_contract.py",
  }),
  slack: Object.freeze({
    upstreamDirectory: "slack",
    configClass: "SlackConfig",
    upstreamUnitTest: "test_slack.py",
    upstreamContractTest: "test_slack_contract.py",
  }),
  mattermost: Object.freeze({
    upstreamDirectory: "mattermost",
    configClass: "MattermostConfig",
    upstreamUnitTest: "test_mattermost.py",
    upstreamContractTest: "test_mattermost_contract.py",
  }),
  feishu: Object.freeze({
    upstreamDirectory: "feishu",
    configClass: "FeishuConfig",
    upstreamUnitTest: "test_feishu.py",
    upstreamContractTest: "test_feishu_contract.py",
  }),
  dingtalk: Object.freeze({
    upstreamDirectory: "dingtalk",
    configClass: "DingTalkConfig",
    upstreamUnitTest: "test_dingtalk.py",
    upstreamContractTest: "test_dingtalk_contract.py",
  }),
  qq: Object.freeze({
    upstreamDirectory: "qq",
    configClass: "QQConfig",
    upstreamUnitTest: "test_qq.py",
    upstreamContractTest: "test_qq_contract.py",
  }),
  mqtt: Object.freeze({
    upstreamDirectory: "mqtt",
    configClass: "MQTTConfig",
    upstreamUnitTest: "test_mqtt.py",
    upstreamContractTest: "test_mqtt_contract.py",
    localSecretFields: Object.freeze(["password", "tls_keyfile"]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/mqtt.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
  matrix: Object.freeze({
    upstreamDirectory: "matrix",
    configClass: "MatrixConfig",
    upstreamUnitTest: "test_matrix.py",
    upstreamContractTest: "test_matrix_contract.py",
    localSecretFields: Object.freeze(["access_token", "password"]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/matrix.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
  wecom: Object.freeze({
    upstreamDirectory: "wecom",
    configClass: "WecomConfig",
    upstreamUnitTest: "test_wecom.py",
    upstreamContractTest: "test_wecom_contract.py",
    localSecretFields: Object.freeze(["secret"]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/wecom.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
  xiaoyi: Object.freeze({
    upstreamDirectory: "xiaoyi",
    configClass: "XiaoYiConfig",
    upstreamUnitTest: "test_xiaoyi.py",
    upstreamContractTest: "test_xiaoyi_contract.py",
    localSecretFields: Object.freeze(["sk"]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/xiaoyi.test.ts",
      "tests/integration/channels/event-claim.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
  yuanbao: Object.freeze({
    upstreamDirectory: "yuanbao",
    configClass: "YuanbaoConfig",
    upstreamUnitTest: "test_yuanbao.py",
    upstreamContractTest: "test_yuanbao_contract.py",
    localSecretFields: Object.freeze(["app_secret"]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/yuanbao.test.ts",
      "tests/integration/channels/event-claim.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
  wechat: Object.freeze({
    upstreamDirectory: "wechat",
    configClass: "WeChatConfig",
    upstreamUnitTest: "test_wechat.py",
    upstreamContractTest: "test_wechat_contract.py",
    localSecretFields: Object.freeze([
      "bot_token",
      "bot_token_file",
    ]),
    localTests: Object.freeze([
      "tests/unit/channels/adapters/wechat.test.ts",
      "tests/unit/admin-compat-channels.test.ts",
      "tests/integration/channels/event-claim.test.ts",
      "tests/unit/channels/runtime-start.test.ts",
    ]),
  }),
});

const STANDARD_CHANNELS = Object.freeze(
  Object.keys(STANDARD_CHANNEL_AUDIT),
);

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function assertNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const strings = value.map((item, index) =>
    assertNonEmptyString(item, `${label}[${index}]`),
  );
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} contains duplicate evidence`);
  }
  return strings;
}

function assertExactArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the fixed snapshot`);
  }
}

function validateRequiredChannels(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("required channels must not be empty");
  }
  const channels = value.map((channel, index) =>
    assertNonEmptyString(channel, `required channels[${index}]`),
  );
  if (new Set(channels).size !== channels.length) {
    throw new Error("duplicate required channel");
  }
  for (const channel of channels) {
    if (!STANDARD_CHANNELS.includes(channel)) {
      throw new Error(`unknown required channel:${channel}`);
    }
  }
  return channels;
}

async function assertRealPathWithin(root, target, label) {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ]);
  const relative = path.relative(realRoot, realTarget);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes its evidence root`);
  }
}

function parseClassFields(source, className) {
  const lines = source.split(/\r?\n/);
  const classStart = lines.findIndex((line) =>
    new RegExp(`^class ${className}\\b`).test(line),
  );
  if (classStart === -1) {
    throw new Error(`upstream config class missing:${className}`);
  }

  const fields = [];
  let inTripleQuotedString = false;
  for (let index = classStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^class \w+/.test(line)) {
      break;
    }
    const tripleQuotes = line.match(/"""|'''/g) ?? [];
    if (inTripleQuotedString || tripleQuotes.length > 0) {
      if (tripleQuotes.length % 2 === 1) {
        inTripleQuotedString = !inTripleQuotedString;
      }
      continue;
    }
    const match = /^    ([a-z][a-z0-9_]*):\s*[^=]+(?:=|$)/i.exec(line);
    if (match) {
      fields.push(match[1]);
    }
  }
  if (fields.length === 0) {
    throw new Error(`upstream config fields missing:${className}`);
  }
  return fields;
}

function effectiveConfigFields(source, className) {
  const merged = new Map();
  for (const field of parseClassFields(source, "BaseChannelConfig")) {
    merged.set(field, field);
  }
  for (const field of parseClassFields(source, className)) {
    merged.set(field, field);
  }
  return [...merged.values()];
}

async function listRegularFiles(root, relativeRoot) {
  const absoluteRoot = path.join(
    root,
    ...relativeRoot.split("/"),
  );
  const rootEntry = await lstat(absoluteRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(`evidence directory invalid:${relativeRoot}`);
  }
  await assertRealPathWithin(
    root,
    absoluteRoot,
    `evidence directory:${relativeRoot}`,
  );

  const files = [];
  async function walk(absoluteDirectory, relativeDirectory) {
    const entries = await readdir(absoluteDirectory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic link evidence rejected:${relativePath}`);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`non-regular evidence rejected:${relativePath}`);
      }
    }
  }

  await walk(absoluteRoot, relativeRoot);
  return files.sort(comparePaths);
}

async function assertRegularFile(root, relativePath) {
  const entry = await lstat(
    path.join(root, ...relativePath.split("/")),
  ).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`local evidence missing:${relativePath}`);
    }
    throw error;
  });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`local evidence invalid:${relativePath}`);
  }
  await assertRealPathWithin(
    root,
    path.join(root, ...relativePath.split("/")),
    `local evidence:${relativePath}`,
  );
}

function expectedUpstreamTest(checksums, directory, fileName) {
  const relativePath = `reference/tests/${directory}/channels/${fileName}`;
  return checksums.has(relativePath)
    ? [relativePath]
    : ["missing_upstream"];
}

function sourceCollectionHash(sourceFiles, checksums) {
  const entries = sourceFiles.map((relativePath) => {
    const sha256 = checksums.get(relativePath);
    if (!sha256) {
      throw new Error(`snapshot checksum evidence missing:${relativePath}`);
    }
    return { path: relativePath, sha256 };
  });
  return createHash("sha256")
    .update(renderChecksums(entries))
    .digest("hex");
}

function extractLedger(markdown) {
  const startCount = markdown.split(LEDGER_START).length - 1;
  const endCount = markdown.split(LEDGER_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("channel parity ledger markers must be unique");
  }
  const start = markdown.indexOf(LEDGER_START) + LEDGER_START.length;
  const end = markdown.indexOf(LEDGER_END);
  if (end <= start) {
    throw new Error("channel parity ledger markers are invalid");
  }
  const fenced = markdown.slice(start, end).trim();
  const match = /^```json\s*\n([\s\S]+)\n```$/.exec(fenced);
  if (!match) {
    throw new Error("channel parity ledger JSON block missing");
  }
  const parsed = JSON.parse(match[1]);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("channel parity ledger must not be empty");
  }
  return parsed;
}

function parseRequiredChannels(argv) {
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require") {
      if (value !== undefined || index + 1 >= argv.length) {
        throw new Error("invalid --require argument");
      }
      value = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--require=")) {
      if (value !== undefined) {
        throw new Error("duplicate --require argument");
      }
      value = argument.slice("--require=".length);
    } else {
      throw new Error(`unknown argument:${argument}`);
    }
  }

  const channels = (value ?? STANDARD_CHANNELS.join(","))
    .split(",")
    .map((channel) => channel.trim());
  return validateRequiredChannels(channels);
}

async function collectExpectedEvidence(repositoryRoot, checksumMap) {
  const snapshotRoot = path.join(
    repositoryRoot,
    "vendor/qwenpaw-console",
  );
  const configSource = await readFile(
    path.join(
      snapshotRoot,
      "reference/src/qwenpaw/config/config.py",
    ),
    "utf8",
  );
  const evidence = {};

  for (const channel of STANDARD_CHANNELS) {
    const definition = STANDARD_CHANNEL_AUDIT[channel];
    const sourceRoot =
      `reference/src/qwenpaw/app/channels/${definition.upstreamDirectory}`;
    const sourceFiles = await listRegularFiles(snapshotRoot, sourceRoot);
    evidence[channel] = {
      sourceFiles,
      sourceSha256: sourceCollectionHash(sourceFiles, checksumMap),
      configFields: effectiveConfigFields(
        configSource,
        definition.configClass,
      ),
      unitTests: expectedUpstreamTest(
        checksumMap,
        "unit",
        definition.upstreamUnitTest,
      ),
      contractTests: expectedUpstreamTest(
        checksumMap,
        "contract",
        definition.upstreamContractTest,
      ),
      adapterFiles: await listRegularFiles(
        repositoryRoot,
        `src/server/channels/adapters/${channel}`,
      ),
      localTests: definition.localTests ?? [
        "tests/unit/channels/adapter-boundary.test.ts",
        `tests/unit/channels/adapters/${channel}.test.ts`,
        "tests/integration/channels/end-to-end.test.ts",
      ],
      localSecretFields: definition.localSecretFields,
      localDocument: `docs/channels/${channel}.md`,
    };
  }
  return evidence;
}

async function validateEntry(
  entry,
  expected,
  repositoryRoot,
) {
  const channel = assertNonEmptyString(entry.channel, "channel");
  const upstream = assertPlainObject(
    entry.upstream,
    `${channel}.upstream`,
  );
  const digitalMate = assertPlainObject(
    entry.digitalmate,
    `${channel}.digitalmate`,
  );

  assertExactArray(
    assertNonEmptyStringArray(
      upstream.source_files,
      `${channel}.upstream.source_files`,
    ),
    expected.sourceFiles,
    `${channel}.upstream.source_files`,
  );
  if (
    assertNonEmptyString(
      upstream.source_sha256,
      `${channel}.upstream.source_sha256`,
    ) !== expected.sourceSha256
  ) {
    throw new Error(`${channel}.upstream.source_sha256 mismatch`);
  }
  assertExactArray(
    assertNonEmptyStringArray(
      upstream.config_files,
      `${channel}.upstream.config_files`,
    ),
    CONFIG_FILES,
    `${channel}.upstream.config_files`,
  );
  assertExactArray(
    assertNonEmptyStringArray(
      upstream.config_fields,
      `${channel}.upstream.config_fields`,
    ),
    expected.configFields,
    `${channel}.upstream.config_fields`,
  );
  assertExactArray(
    assertNonEmptyStringArray(
      upstream.unit_tests,
      `${channel}.upstream.unit_tests`,
    ),
    expected.unitTests,
    `${channel}.upstream.unit_tests`,
  );
  assertExactArray(
    assertNonEmptyStringArray(
      upstream.contract_tests,
      `${channel}.upstream.contract_tests`,
    ),
    expected.contractTests,
    `${channel}.upstream.contract_tests`,
  );

  const manifest = assertNonEmptyString(
    digitalMate.manifest,
    `${channel}.digitalmate.manifest`,
  );
  if (manifest !== "src/server/channels/manifests/catalog.ts") {
    throw new Error(`${channel}.digitalmate.manifest mismatch`);
  }
  assertExactArray(
    assertNonEmptyStringArray(
      digitalMate.adapter_files,
      `${channel}.digitalmate.adapter_files`,
    ),
    expected.adapterFiles,
    `${channel}.digitalmate.adapter_files`,
  );
  const localTests = assertNonEmptyStringArray(
    digitalMate.tests,
    `${channel}.digitalmate.tests`,
  );
  assertExactArray(
    localTests,
    expected.localTests,
    `${channel}.digitalmate.tests`,
  );
  const localDocument = assertNonEmptyString(
    digitalMate.document,
    `${channel}.digitalmate.document`,
  );
  if (localDocument !== expected.localDocument) {
    throw new Error(`${channel}.digitalmate.document mismatch`);
  }

  const decisions = assertPlainObject(
    digitalMate.config_decisions,
    `${channel}.digitalmate.config_decisions`,
  );

  if (expected.localSecretFields) {
    assertExactArray(
      assertNonEmptyStringArray(
        digitalMate.secret_fields,
        `${channel}.digitalmate.secret_fields`,
      ),
      expected.localSecretFields,
      `${channel}.digitalmate.secret_fields`,
    );
  }
  assertNonEmptyString(
    decisions.default,
    `${channel}.digitalmate.config_decisions.default`,
  );
  const decisionExceptions = assertPlainObject(
    decisions.exceptions,
    `${channel}.digitalmate.config_decisions.exceptions`,
  );
  for (const field of Object.keys(decisionExceptions)) {
    if (!expected.configFields.includes(field)) {
      throw new Error(
        `${channel}.digitalmate.config_decisions has unknown field:${field}`,
      );
    }
    assertNonEmptyString(
      decisionExceptions[field],
      `${channel}.digitalmate.config_decisions.exceptions.${field}`,
    );
  }

  assertNonEmptyStringArray(
    entry.intentional_differences,
    `${channel}.intentional_differences`,
  );
  const status = assertNonEmptyString(entry.status, `${channel}.status`);
  if (status !== "automated_verified") {
    throw new Error(`${channel}.status must be automated_verified`);
  }

  for (const relativePath of [
    manifest,
    ...expected.adapterFiles,
    ...localTests,
    localDocument,
  ]) {
    await assertRegularFile(repositoryRoot, relativePath);
  }
}

export async function auditChannelParity(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  );
  const snapshotRoot = path.join(
    repositoryRoot,
    "vendor/qwenpaw-console",
  );
  await verifySnapshot(snapshotRoot);
  if (
    UPSTREAM.tag !== EXPECTED_UPSTREAM.tag ||
    UPSTREAM.commit !== EXPECTED_UPSTREAM.commit
  ) {
    throw new Error("channel parity audit upstream identity mismatch");
  }
  const requiredChannels = validateRequiredChannels(
    options.requiredChannels ?? STANDARD_CHANNELS,
  );

  const checksums = await readChecksums(
    path.join(snapshotRoot, "SHA256SUMS"),
  );
  const checksumMap = new Map(
    checksums.map((entry) => [entry.path, entry.sha256]),
  );
  for (const configFile of CONFIG_FILES) {
    if (!checksumMap.has(configFile)) {
      throw new Error(`snapshot checksum evidence missing:${configFile}`);
    }
  }

  const ledgerPath = path.resolve(
    options.ledgerPath ??
      path.join(
        repositoryRoot,
        "docs/verification/qwenpaw-channel-parity.md",
      ),
  );
  const ledger = extractLedger(await readFile(ledgerPath, "utf8"));
  const seen = new Set();
  for (const entry of ledger) {
    const object = assertPlainObject(entry, "channel ledger entry");
    const channel = assertNonEmptyString(object.channel, "channel");
    if (!STANDARD_CHANNELS.includes(channel)) {
      throw new Error(`unknown channel ledger entry:${channel}`);
    }
    if (seen.has(channel)) {
      throw new Error(`duplicate channel ledger entry:${channel}`);
    }
    seen.add(channel);
  }
  for (const channel of requiredChannels) {
    if (!STANDARD_CHANNELS.includes(channel)) {
      throw new Error(`unknown required channel:${channel}`);
    }
    if (!seen.has(channel)) {
      throw new Error(`required channel ledger entry missing:${channel}`);
    }
  }
  for (const channel of STANDARD_CHANNELS) {
    if (!seen.has(channel)) {
      throw new Error(`standard channel ledger entry missing:${channel}`);
    }
  }

  const expectedEvidence = await collectExpectedEvidence(
    repositoryRoot,
    checksumMap,
  );
  for (const entry of ledger) {
    await validateEntry(
      entry,
      expectedEvidence[entry.channel],
      repositoryRoot,
    );
  }

  return {
    channels: ledger.length,
    required: requiredChannels.length,
    tag: UPSTREAM.tag,
    commit: UPSTREAM.commit,
  };
}

export const __testing = Object.freeze({
  assertRealPathWithin,
  collectExpectedEvidence,
  extractLedger,
  parseRequiredChannels,
  validateRequiredChannels,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let requiredChannels;
  try {
    requiredChannels = parseRequiredChannels(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "invalid audit arguments",
    );
    process.exitCode = 1;
  }

  if (requiredChannels) {
    auditChannelParity({ requiredChannels })
      .then((result) => {
        console.log(
          `${result.tag} · ${result.commit} · ${result.channels} channels · parity evidence verified`,
        );
      })
      .catch((error) => {
        console.error(
          error instanceof Error
            ? error.message
            : "channel parity audit failed",
        );
        process.exitCode = 1;
      });
  }
}
