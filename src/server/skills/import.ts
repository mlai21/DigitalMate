import { parseSkillMd, type SkillDocument } from "@/server/skills/skill-md";

export type ParsedGitHubUrl = {
  owner: string;
  repo: string;
  /** Branch/tag; null means the repo default branch. */
  ref: string | null;
  /** Path inside the repo ("" for repo root). */
  path: string;
  kind: "repo" | "tree" | "blob";
};

export type DiscoveredSkill = {
  /** Path of the SKILL.md inside the repo. */
  path: string;
  /** Human-facing GitHub URL of the file. */
  webUrl: string;
  raw: string;
  document: SkillDocument;
};

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const MAX_SKILL_FILES = 20;
const MAX_SKILL_BYTES = 64 * 1024;

export function parseGitHubUrl(input: string): ParsedGitHubUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repoRaw, mode, ref, ...rest] = segments;
  const repo = repoRaw.replace(/\.git$/, "");

  if (!mode) return { owner, repo, ref: null, path: "", kind: "repo" };
  if ((mode === "tree" || mode === "blob") && ref) {
    return {
      owner,
      repo,
      ref: decodeURIComponent(ref),
      path: rest.map(decodeURIComponent).join("/"),
      kind: mode,
    };
  }
  return null;
}

/**
 * Discovers SKILL.md documents behind a GitHub link (repo root, tree
 * directory, or a single blob file) via the GitHub API + raw content host.
 */
export async function discoverSkillsFromGitHub(input: {
  url: string;
  token?: string;
  fetchFn?: FetchLike;
}): Promise<DiscoveredSkill[]> {
  const parsed = parseGitHubUrl(input.url);
  if (!parsed) throw new Error("不是有效的 GitHub 链接（支持仓库、目录或 SKILL.md 文件链接）。");
  const fetchFn: FetchLike = input.fetchFn ?? (fetch as unknown as FetchLike);
  const headers = buildHeaders(input.token);

  if (parsed.kind === "blob") {
    if (!isSkillMdPath(parsed.path)) throw new Error("文件链接必须指向 SKILL.md 文件。");
    const skill = await fetchSkillFile(fetchFn, headers, parsed, parsed.path, parsed.ref ?? "HEAD");
    return skill ? [skill] : [];
  }

  const ref = parsed.ref ?? (await fetchDefaultBranch(fetchFn, headers, parsed));
  const paths = await listSkillMdPaths(fetchFn, headers, parsed, ref);
  const scoped = parsed.path ? paths.filter((path) => path === parsed.path || path.startsWith(`${parsed.path}/`)) : paths;

  const skills: DiscoveredSkill[] = [];
  for (const path of scoped.slice(0, MAX_SKILL_FILES)) {
    const skill = await fetchSkillFile(fetchFn, headers, parsed, path, ref);
    if (skill) skills.push(skill);
  }
  return skills;
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "DigitalMate",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function isSkillMdPath(path: string): boolean {
  return /(^|\/)skill\.md$/i.test(path);
}

async function fetchDefaultBranch(fetchFn: FetchLike, headers: Record<string, string>, parsed: ParsedGitHubUrl): Promise<string> {
  const response = await fetchFn(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers });
  if (!response.ok) throw new Error(`无法访问 GitHub 仓库（HTTP ${response.status}），请确认链接和权限。`);
  const data = (await response.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

async function listSkillMdPaths(
  fetchFn: FetchLike,
  headers: Record<string, string>,
  parsed: ParsedGitHubUrl,
  ref: string,
): Promise<string[]> {
  const response = await fetchFn(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers },
  );
  if (!response.ok) throw new Error(`无法读取仓库文件列表（HTTP ${response.status}）。`);
  const data = (await response.json()) as { tree?: Array<{ path?: string; type?: string }> };
  return (data.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path && isSkillMdPath(entry.path))
    .map((entry) => entry.path as string);
}

async function fetchSkillFile(
  fetchFn: FetchLike,
  headers: Record<string, string>,
  parsed: ParsedGitHubUrl,
  path: string,
  ref: string,
): Promise<DiscoveredSkill | null> {
  const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(ref)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetchFn(rawUrl, { headers: { "user-agent": "DigitalMate" } });
  if (!response.ok) return null;
  const raw = (await response.text()).slice(0, MAX_SKILL_BYTES);
  const document = parseSkillMd(raw);
  if (!document) return null;
  return {
    path,
    webUrl: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${ref}/${path}`,
    raw,
    document,
  };
}
