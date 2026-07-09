import { describe, expect, it } from "vitest";
import { discoverSkillsFromGitHub, parseGitHubUrl, type FetchLike } from "@/server/skills/import";

const skillMd = ["---", "name: 会议纪要", "description: 把录音要点整理成会议纪要", "---", "", "# 会议纪要"].join("\n");

function mockFetch(routes: Record<string, unknown | string>): FetchLike {
  return async (url) => {
    for (const [prefix, payload] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

describe("parseGitHubUrl", () => {
  it("parses repo, tree and blob links", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: null,
      path: "",
      kind: "repo",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/skills")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "skills",
      kind: "tree",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/skills/foo/SKILL.md")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "skills/foo/SKILL.md",
      kind: "blob",
    });
  });

  it("rejects non-GitHub or malformed links", () => {
    expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubUrl("不是链接")).toBeNull();
  });
});

describe("discoverSkillsFromGitHub", () => {
  it("discovers all SKILL.md files in a repo via the git tree", async () => {
    const fetchFn = mockFetch({
      "https://api.github.com/repos/owner/repo/git/trees/main": {
        tree: [
          { path: "README.md", type: "blob" },
          { path: "skills/meeting/SKILL.md", type: "blob" },
          { path: "skills/meeting", type: "tree" },
        ],
      },
      "https://api.github.com/repos/owner/repo": { default_branch: "main" },
      "https://raw.githubusercontent.com/owner/repo/main/skills/meeting/SKILL.md": skillMd,
    });

    const skills = await discoverSkillsFromGitHub({ url: "https://github.com/owner/repo", fetchFn });

    expect(skills).toHaveLength(1);
    expect(skills[0].path).toBe("skills/meeting/SKILL.md");
    expect(skills[0].document.name).toBe("会议纪要");
    expect(skills[0].webUrl).toBe("https://github.com/owner/repo/blob/main/skills/meeting/SKILL.md");
  });

  it("scopes discovery to the linked directory", async () => {
    const fetchFn = mockFetch({
      "https://api.github.com/repos/owner/repo/git/trees/main": {
        tree: [
          { path: "skills/a/SKILL.md", type: "blob" },
          { path: "other/SKILL.md", type: "blob" },
        ],
      },
      "https://raw.githubusercontent.com/owner/repo/main/skills/a/SKILL.md": skillMd,
      "https://raw.githubusercontent.com/owner/repo/main/other/SKILL.md": skillMd,
    });

    const skills = await discoverSkillsFromGitHub({ url: "https://github.com/owner/repo/tree/main/skills", fetchFn });

    expect(skills.map((skill) => skill.path)).toEqual(["skills/a/SKILL.md"]);
  });

  it("fetches a single SKILL.md from a blob link", async () => {
    const fetchFn = mockFetch({
      "https://raw.githubusercontent.com/owner/repo/main/skills/a/SKILL.md": skillMd,
    });

    const skills = await discoverSkillsFromGitHub({
      url: "https://github.com/owner/repo/blob/main/skills/a/SKILL.md",
      fetchFn,
    });

    expect(skills).toHaveLength(1);
    expect(skills[0].document.name).toBe("会议纪要");
  });

  it("rejects blob links that are not SKILL.md", async () => {
    await expect(
      discoverSkillsFromGitHub({ url: "https://github.com/owner/repo/blob/main/README.md", fetchFn: mockFetch({}) }),
    ).rejects.toThrow("SKILL.md");
  });

  it("throws a readable error for invalid links", async () => {
    await expect(discoverSkillsFromGitHub({ url: "https://example.com/x", fetchFn: mockFetch({}) })).rejects.toThrow(
      "GitHub",
    );
  });
});
