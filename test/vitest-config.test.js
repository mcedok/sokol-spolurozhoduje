import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

describe("Vitest discovery", () => {
  it("does not collect tests from linked worktrees nested under the repository", () => {
    expect(config.test?.exclude).toContain("**/.worktrees/**");
  });
});
