import { describe, expect, it } from "vitest";
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
  it("keeps the desktop project on the full app E2E suite", () => {
    expect(getProject("Desktop Chrome").testMatch).toBeUndefined();
  });

  it.each(["iPad Mini", "Mobile Chrome"])(
    "limits %s to the Console preview baseline",
    (projectName) => {
      expect(getProject(projectName).testMatch).toBe(
        "**/admin-console-preview.spec.ts",
      );
    },
  );
});
