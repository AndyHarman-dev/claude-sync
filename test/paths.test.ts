import { describe, test, expect } from "bun:test";
import { mungeCwd, paths } from "../src/lib/paths";

describe("mungeCwd", () => {
  test("does not collide for structurally different paths that share a slug", () => {
    // Regression: a naive `[^a-zA-Z0-9]` -> "-" replace collapses both of these to the
    // same "-repo-a" string, which would let a pending-join intended for one cwd be
    // silently claimed by a session in the other.
    const a = mungeCwd("/repo/a");
    const b = mungeCwd("/repo-a");
    expect(a).not.toBe(b);
  });

  test("is deterministic for the same input", () => {
    expect(mungeCwd("/repo/a")).toBe(mungeCwd("/repo/a"));
  });

  test("pendingJoinFile paths for colliding-slug cwds are distinct files", () => {
    const pathA = paths.pendingJoinFile("/repo/a");
    const pathB = paths.pendingJoinFile("/repo-a");
    expect(pathA).not.toBe(pathB);
  });
});
