import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { verifySessionRequest } from "@/server/auth/session";

const previewPathPrefix = "/admin-preview";
const immutableCacheControl = "public, max-age=31536000, immutable";
const conservativeCacheControl = "no-cache";
const noStoreCacheControl = "no-store";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

type StaticRequest = {
  rootDirectory: string;
  pathSegments?: string[];
  rawPathname: string;
  testHooks?: StaticTestHooks;
};

type StaticTestHooks = {
  beforeOpen?: (filePath: string) => Promise<void>;
  afterOpen?: (filePath: string) => Promise<void>;
};

type PreviewHandlerOptions = {
  appSecret: string;
  defaultUserId: string;
  rootDirectory: string;
};

type InspectedFile =
  | { kind: "file"; filePath: string }
  | { kind: "missing" }
  | { kind: "blocked" };

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

export async function serveAdminConsoleStatic(input: StaticRequest): Promise<Response> {
  const validatedPath = validateRequestPath(input.pathSegments, input.rawPathname);
  if (!validatedPath) return errorResponse(400);

  const requestedSegments = validatedPath;
  if (requestedSegments.length === 0) {
    return serveFile(input.rootDirectory, ["index.html"], true, input.testHooks);
  }

  const inspected = await inspectRegularFile(input.rootDirectory, requestedSegments);
  if (inspected.kind === "file") {
    return respondWithFile(
      input.rootDirectory,
      inspected.filePath,
      requestedSegments,
      false,
      input.testHooks,
    );
  }

  if (inspected.kind === "blocked" || isExplicitResourceRequest(requestedSegments)) {
    return errorResponse(404);
  }

  return serveFile(input.rootDirectory, ["index.html"], true, input.testHooks);
}

export function createAdminConsolePreviewHandler(options: PreviewHandlerOptions) {
  return async function handleAdminConsolePreview(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const userId = await verifySessionRequest(
      request,
      options.defaultUserId,
      options.appSecret,
    );
    if (!userId) return loginRedirect(request);

    const url = new URL(request.url);
    if (url.hash) return errorResponse(400);

    let params: { path?: string[] };
    try {
      params = await context.params;
    } catch {
      return errorResponse(400);
    }

    return serveAdminConsoleStatic({
      rootDirectory: options.rootDirectory,
      pathSegments: params.path,
      rawPathname: url.pathname,
    });
  };
}

function validateRequestPath(pathSegments: string[] | undefined, rawPathname: string): string[] | null {
  const frameworkSegments = pathSegments ?? [];
  if (!Array.isArray(frameworkSegments) || frameworkSegments.some((segment) => typeof segment !== "string")) {
    return null;
  }

  const rawSegments = parseRawPreviewPath(rawPathname);
  if (!rawSegments || rawSegments.length !== frameworkSegments.length) return null;

  for (let index = 0; index < frameworkSegments.length; index += 1) {
    const frameworkSegment = frameworkSegments[index];
    if (!isSafeSegment(frameworkSegment) || frameworkSegment !== rawSegments[index]) return null;
  }

  return [...frameworkSegments];
}

function parseRawPreviewPath(rawPathname: string): string[] | null {
  if (rawPathname === previewPathPrefix || rawPathname === `${previewPathPrefix}/`) return [];
  if (!rawPathname.startsWith(`${previewPathPrefix}/`)) return null;

  const rawTail = rawPathname.slice(previewPathPrefix.length + 1);
  if (!rawTail || rawTail.includes("?") || rawTail.includes("#")) return null;

  const rawSegments = rawTail.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) return null;

  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!isSafeSegment(decoded)) return null;
    decodedSegments.push(decoded);
  }
  return decodedSegments;
}

function isSafeSegment(segment: string): boolean {
  let decoded = segment;

  for (let depth = 0; depth < 5; depth += 1) {
    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.includes("?") ||
      decoded.includes("#") ||
      /^[A-Za-z]:/.test(decoded)
    ) {
      return false;
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) return true;
    decoded = next;
  }

  return false;
}

async function serveFile(
  rootDirectory: string,
  pathSegments: string[],
  forceHtmlNoStore = false,
  testHooks?: StaticTestHooks,
): Promise<Response> {
  const inspected = await inspectRegularFile(rootDirectory, pathSegments);
  if (inspected.kind !== "file") return errorResponse(404);
  return respondWithFile(
    rootDirectory,
    inspected.filePath,
    pathSegments,
    forceHtmlNoStore,
    testHooks,
  );
}

async function inspectRegularFile(
  rootDirectory: string,
  pathSegments: string[],
): Promise<InspectedFile> {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(root, ...pathSegments);
  const relativeCandidate = path.relative(root, candidate);
  if (
    relativeCandidate === "" ||
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidate)
  ) {
    return { kind: "blocked" };
  }

  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return { kind: "blocked" };

    const canonicalRoot = await realpath(root);
    for (let index = 0; index < pathSegments.length; index += 1) {
      const currentPath = path.join(root, ...pathSegments.slice(0, index + 1));
      const metadata = await lstat(currentPath);
      const isLastSegment = index === pathSegments.length - 1;

      if (metadata.isSymbolicLink()) return { kind: "blocked" };
      if (isLastSegment ? !metadata.isFile() : !metadata.isDirectory()) {
        return { kind: "blocked" };
      }
    }

    const expectedCanonicalPath = path.resolve(canonicalRoot, ...pathSegments);
    const canonicalCandidate = await realpath(candidate);
    if (
      canonicalCandidate !== expectedCanonicalPath ||
      !isWithinRoot(canonicalRoot, canonicalCandidate)
    ) {
      return { kind: "blocked" };
    }

    return { kind: "file", filePath: candidate };
  } catch (error) {
    return isMissingFilesystemEntry(error) ? { kind: "missing" } : { kind: "blocked" };
  }
}

async function respondWithFile(
  rootDirectory: string,
  filePath: string,
  pathSegments: string[],
  forceHtmlNoStore = false,
  testHooks?: StaticTestHooks,
): Promise<Response> {
  let fileHandle;
  try {
    await testHooks?.beforeOpen?.(filePath);
    fileHandle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await testHooks?.afterOpen?.(filePath);

    const metadata = await fileHandle.stat({ bigint: true });
    if (!(await validateOpenedFile(rootDirectory, pathSegments, metadata))) {
      return errorResponse(404);
    }

    const content = await fileHandle.readFile();
    const fileName = pathSegments.at(-1) ?? "";
    const contentType = contentTypes.get(path.extname(fileName).toLowerCase()) ?? "application/octet-stream";
    const cacheControl =
      forceHtmlNoStore || contentType.startsWith("text/html")
        ? noStoreCacheControl
        : isHashedAsset(pathSegments)
          ? immutableCacheControl
          : conservativeCacheControl;

    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        "Cache-Control": cacheControl,
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return errorResponse(404);
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function validateOpenedFile(
  rootDirectory: string,
  pathSegments: string[],
  openedMetadata: BigIntStats,
): Promise<boolean> {
  if (!openedMetadata.isFile() || !hasReliableFileIdentity(openedMetadata)) return false;

  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(root, ...pathSegments);

  try {
    const rootMetadata = await lstat(root, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;

    const canonicalRoot = await realpath(root);
    let finalMetadata: BigIntStats | null = null;
    for (let index = 0; index < pathSegments.length; index += 1) {
      const currentPath = path.join(root, ...pathSegments.slice(0, index + 1));
      const metadata = await lstat(currentPath, { bigint: true });
      const isLastSegment = index === pathSegments.length - 1;

      if (metadata.isSymbolicLink()) return false;
      if (isLastSegment) {
        if (!metadata.isFile()) return false;
        finalMetadata = metadata;
      } else if (!metadata.isDirectory()) {
        return false;
      }
    }

    if (!finalMetadata || !hasReliableFileIdentity(finalMetadata)) return false;

    const expectedCanonicalPath = path.resolve(canonicalRoot, ...pathSegments);
    const canonicalCandidate = await realpath(candidate);
    if (
      canonicalCandidate !== expectedCanonicalPath ||
      !isWithinRoot(canonicalRoot, canonicalCandidate)
    ) {
      return false;
    }

    return (
      openedMetadata.dev === finalMetadata.dev &&
      openedMetadata.ino === finalMetadata.ino
    );
  } catch {
    return false;
  }
}

function hasReliableFileIdentity(metadata: BigIntStats): boolean {
  return metadata.dev >= BigInt(0) && metadata.ino > BigInt(0);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isMissingFilesystemEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isExplicitResourceRequest(pathSegments: string[]): boolean {
  const firstSegment = pathSegments[0]?.toLowerCase();
  const fileName = pathSegments.at(-1)?.toLowerCase() ?? "";
  return firstSegment === "assets" || fileName === "favicon" || path.extname(fileName).length > 0;
}

function isHashedAsset(pathSegments: string[]): boolean {
  if (pathSegments[0]?.toLowerCase() !== "assets") return false;
  const fileName = pathSegments.at(-1) ?? "";
  return /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(fileName);
}

function loginRedirect(request: Request): Response {
  const requestUrl = new URL(request.url);
  const searchParams = new URLSearchParams({
    redirect: `${requestUrl.pathname}${requestUrl.search}`,
  });
  return new Response(null, {
    status: 307,
    headers: { Location: `/login?${searchParams.toString()}` },
  });
}

function errorResponse(status: 400 | 404): Response {
  return new Response(status === 400 ? "Bad Request" : "Not Found", {
    status,
    headers: {
      "Cache-Control": noStoreCacheControl,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
