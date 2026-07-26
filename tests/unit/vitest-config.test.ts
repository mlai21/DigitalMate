import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

describe("Vitest resource isolation", () => {
  it("只扫描 DigitalMate 当前工作区测试", () => {
    const exclude = config.test?.exclude ?? [];
    expect(exclude).toEqual([
      "**/node_modules/**",
      "tests/e2e/**",
      ".worktrees/**",
      "vendor/**",
      "patches/**",
      ".generated/**",
      "public/_admin-console/**",
    ]);
  });

  it("bounds workers so embedded PostgreSQL suites fit the host limits", () => {
    expect(config).toMatchObject({
      test: {
        maxWorkers: 4,
      },
    });
  });
});
