import config from "../../vitest.config";
import { expect, it } from "vitest";

it("只扫描 DigitalMate 当前工作区测试", () => {
  const exclude = config.test?.exclude ?? [];
  expect(exclude).toEqual(
    expect.arrayContaining([
      "node_modules/**",
      "tests/e2e/**",
      ".worktrees/**",
      "vendor/**",
      "patches/**",
      ".generated/**",
      "public/_admin-console/**",
    ]),
  );
});
