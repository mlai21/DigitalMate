import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import playwrightConfig from "../../playwright.config";

function getProject(projectName: string) {
  const project = playwrightConfig.projects?.find(
    ({ name }) => name === projectName,
  );
  if (!project) {
    throw new Error(`Missing Playwright project: ${projectName}`);
  }
  return project;
}

describe("Playwright app project selection", () => {
  it("uses per-run credentials for the production E2E server", () => {
    expect(process.env.PLAYWRIGHT_APP_PASSWORD).toMatch(
      /^[A-Za-z0-9_-]{40,}$/,
    );
    expect(process.env.PLAYWRIGHT_APP_SECRET).toMatch(
      /^[A-Za-z0-9_-]{60,}$/,
    );
  });

  it("binds the production E2E server to the loopback interface", () => {
    const runnerSource = readFileSync(
      "scripts/run-e2e-app.mjs",
      "utf8",
    );

    expect(runnerSource).toContain('"start",\n    "-H",\n    "127.0.0.1"');
    expect(runnerSource).not.toContain(
      "digitalmate-e2e-private-session-secret",
    );
  });

  it("keeps the desktop project on the full app E2E suite", () => {
    expect(getProject("Desktop Chrome").testMatch).toBeUndefined();
  });

  it.each(["iPad Mini", "Mobile Chrome"])(
    "limits %s to the Console compatibility suites",
    (projectName) => {
      expect(getProject(projectName).testMatch).toEqual([
        "**/admin-console-preview.spec.ts",
        "**/admin-console-pages.spec.ts",
        "**/admin-console.visual.spec.ts",
      ]);
    },
  );
});
