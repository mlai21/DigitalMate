import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifySnapshot } from "./verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../..");
const SNAPSHOT_ROOT = path.join(REPOSITORY_ROOT, "vendor/qwenpaw-console");
const CONSOLE_ROOT = path.join(SNAPSHOT_ROOT, "console");
const PATCH_ROOT = path.join(REPOSITORY_ROOT, "patches/qwenpaw-console");

export const PATCHES = Object.freeze([
  "0001-brand.patch",
  "0002-theme.patch",
  "0003-route-auth.patch",
  "0004-api-compat.patch",
]);

const DEFAULT_PATCH_PATHS = Object.freeze(
  PATCHES.map((patchName) => path.join(PATCH_ROOT, patchName)),
);

async function applyPatch(workdir, patchPath) {
  const options = {
    cwd: workdir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
  };
  await execFileAsync("git", ["apply", "--check", patchPath], options);
  await execFileAsync("git", ["apply", patchPath], options);
}

async function removePreparedDirectory(workdir, originalError) {
  try {
    await rm(workdir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (originalError && typeof originalError === "object") {
      Object.defineProperty(originalError, "cleanupError", {
        configurable: true,
        value: cleanupError,
      });
      return;
    }
    throw cleanupError;
  }
}

async function prepareConsoleWithDependencies(
  { keep = false } = {},
  {
    patchPaths = DEFAULT_PATCH_PATHS,
    temporaryParent = os.tmpdir(),
    verify = () => verifySnapshot(SNAPSHOT_ROOT),
  } = {},
) {
  await verify();
  const workdir = await mkdtemp(
    path.join(temporaryParent, "digitalmate-qwenpaw-console-"),
  );
  const applied = [];

  try {
    await cp(CONSOLE_ROOT, workdir, {
      force: false,
      recursive: true,
    });

    for (const patchPath of patchPaths) {
      await applyPatch(workdir, path.resolve(patchPath));
      applied.push(path.basename(patchPath));
    }

    await verify();
    if (!keep) {
      await removePreparedDirectory(workdir);
      return { workdir: null, applied: [...applied] };
    }
    return { workdir, applied: [...applied] };
  } catch (error) {
    await removePreparedDirectory(workdir, error);
    throw error;
  }
}

export function prepareConsole(options = {}) {
  return prepareConsoleWithDependencies(options);
}

export const __testing = Object.freeze({
  prepareConsoleWithDependencies,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  prepareConsole()
    .then(({ applied }) => {
      console.log(`Console patches verified: ${applied.join(", ")}`);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Console preparation failed",
      );
      process.exitCode = 1;
    });
}
