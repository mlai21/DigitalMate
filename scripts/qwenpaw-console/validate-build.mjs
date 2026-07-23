import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const CONSOLE_BASE_PATH = "/_admin-console/";
const STATIC_RESOURCE_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".mjs",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

function getHtmlResourceReferences(source) {
  return [...source.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(
    ([, resourceUrl]) => ({
      resourceUrl,
      syntax: "html-attribute",
    }),
  );
}

async function listBuildFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listBuildFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      });
    }
  }
  return files;
}

function getCssResourceReferences(source) {
  return [...source.matchAll(/url\(\s*(["']?)([^'")]+)\1\s*\)/gi)].map(
    ([, , resourceUrl]) => ({
      resourceUrl: resourceUrl.trim(),
      syntax: "css-url",
    }),
  );
}

function isStaticResourceUrl(resourceUrl) {
  if (!resourceUrl.startsWith("/") || resourceUrl.startsWith("//")) {
    return false;
  }
  const resourcePath = resourceUrl.split(/[?#]/, 1)[0];
  return STATIC_RESOURCE_EXTENSIONS.has(
    path.posix.extname(resourcePath).toLowerCase(),
  );
}

function isPlusExpression(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

function isConcatCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "concat"
  );
}

function hasSyntacticallyNonEmptyConcatenationValue(node) {
  if (ts.isParenthesizedExpression(node)) {
    return hasSyntacticallyNonEmptyConcatenationValue(node.expression);
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text.length > 0;
  }
  if (isPlusExpression(node)) {
    return (
      hasSyntacticallyNonEmptyConcatenationValue(node.left) ||
      hasSyntacticallyNonEmptyConcatenationValue(node.right)
    );
  }
  if (isConcatCall(node)) {
    return (
      hasSyntacticallyNonEmptyConcatenationValue(
        node.expression.expression,
      ) ||
      node.arguments.some(hasSyntacticallyNonEmptyConcatenationValue)
    );
  }
  return true;
}

function hasExplicitConcatenationPrefix(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (isPlusExpression(parent)) {
      if (
        parent.right === current &&
        hasSyntacticallyNonEmptyConcatenationValue(parent.left)
      ) {
        return true;
      }
      current = parent;
      continue;
    }
    if (isConcatCall(parent)) {
      const argumentIndex = parent.arguments.indexOf(current);
      if (argumentIndex === -1) {
        break;
      }
      const earlierParts = [
        parent.expression.expression,
        ...parent.arguments.slice(0, argumentIndex),
      ];
      if (earlierParts.some(hasSyntacticallyNonEmptyConcatenationValue)) {
        return true;
      }
      current = parent;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      parent.name.text === "concat" &&
      isConcatCall(parent.parent) &&
      parent.parent.expression === parent
    ) {
      current = parent.parent;
      continue;
    }
    break;
  }
  return false;
}

function getJavaScriptResourceReferences(source) {
  const references = [];
  const sourceFile = ts.createSourceFile(
    "bundle.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) &&
      isStaticResourceUrl(node.text) &&
      !hasExplicitConcatenationPrefix(node)
    ) {
      references.push({
        resourceUrl: node.text,
        syntax: "javascript-string",
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function resolveBuildResourcePath(distRoot, resourcePath) {
  const relativePath = decodeURIComponent(
    resourcePath.slice(CONSOLE_BASE_PATH.length),
  );
  if (
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`invalid build resource path: ${resourcePath}`);
  }
  const absolutePath = path.resolve(distRoot, relativePath);
  if (
    absolutePath !== distRoot &&
    !absolutePath.startsWith(`${distRoot}${path.sep}`)
  ) {
    throw new Error(`invalid build resource path: ${resourcePath}`);
  }
  return absolutePath;
}

async function requireRegularFile(filePath, description) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`${description} missing: ${filePath}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new Error(`${description} is not a file: ${filePath}`);
  }
}

async function validateBuildResource(distRoot, { resourceUrl }) {
  if (
    resourceUrl.startsWith("data:") ||
    resourceUrl.startsWith("#") ||
    /^[a-z][a-z\d+.-]*:/i.test(resourceUrl) ||
    resourceUrl.startsWith("//")
  ) {
    return;
  }
  const resourcePath = resourceUrl.split(/[?#]/, 1)[0];
  if (!resourcePath.startsWith(CONSOLE_BASE_PATH)) {
    throw new Error(
      `build resource outside ${CONSOLE_BASE_PATH}: ${resourceUrl}`,
    );
  }
  const absolutePath = resolveBuildResourcePath(distRoot, resourcePath);
  await requireRegularFile(absolutePath, "missing build asset");
}

export async function validateConsoleBuild(workdir) {
  const distRoot = path.join(workdir, "dist");
  const indexPath = path.join(distRoot, "index.html");
  await requireRegularFile(indexPath, "build entry");
  const buildFiles = await listBuildFiles(distRoot);
  const resourceUrls = [];

  for (const { absolutePath, relativePath } of buildFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    if (![".css", ".html", ".js", ".mjs"].includes(extension)) {
      continue;
    }
    const source = await readFile(absolutePath, "utf8");
    let references = [];
    if (extension === ".html") {
      references = getHtmlResourceReferences(source);
    } else if (extension === ".css") {
      references = getCssResourceReferences(source);
    } else {
      references = getJavaScriptResourceReferences(source);
    }
    for (const reference of references) {
      const { resourceUrl } = reference;
      resourceUrls.push(resourceUrl);
      await validateBuildResource(distRoot, reference);
    }
  }

  const logoPath = path.join(distRoot, "digitalmate-logo.svg");
  await requireRegularFile(logoPath, "digitalmate-logo.svg");
  return {
    indexPath,
    logoPath,
    resourceUrls: [...resourceUrls],
  };
}
