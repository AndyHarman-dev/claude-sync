import { describe, test, expect } from "bun:test";
import { mergeHooks, removeHooks, HOOK_SENTINEL } from "../src/install/settings-merge";

const HOOK_MAIN = "/Users/wiam/VSCodeProjects/claude-sync/src/hooks/main.ts";

describe("mergeHooks", () => {
  test("adds all four events into an empty settings object, preserving other keys", () => {
    const settings = { model: "claude-fable-5", theme: "dark" };
    const next = mergeHooks(settings, HOOK_MAIN);
    expect(next.model).toBe("claude-fable-5");
    expect(next.theme).toBe("dark");
    expect(Object.keys(next.hooks!).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
    expect(next.hooks!.PostToolUse![0]!.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
    expect(next.hooks!.SessionStart![0]!.matcher).toBeUndefined();
    for (const event of Object.keys(next.hooks!)) {
      expect(next.hooks![event]![0]!.hooks[0]!.command).toContain(HOOK_SENTINEL);
    }
  });

  test("is idempotent: running twice does not duplicate entries", () => {
    const once = mergeHooks({}, HOOK_MAIN);
    const twice = mergeHooks(once, HOOK_MAIN);
    for (const event of Object.keys(twice.hooks!)) {
      expect(twice.hooks![event]).toHaveLength(1);
    }
    expect(twice).toEqual(once);
  });

  test("preserves another tool's hook entries on the same event", () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "some-other-tool --notify" }] }],
      },
    };
    const next = mergeHooks(settings, HOOK_MAIN);
    expect(next.hooks!.SessionStart).toHaveLength(2);
    expect(next.hooks!.SessionStart!.some((e) => e.hooks[0]!.command === "some-other-tool --notify")).toBe(true);
    expect(next.hooks!.SessionStart!.some((e) => e.hooks[0]!.command.includes(HOOK_SENTINEL))).toBe(true);
  });

  test("re-installing after a hook path change replaces the old entry, not append", () => {
    const once = mergeHooks({}, "/old/path/claude-sync/src/hooks/main.ts");
    const twice = mergeHooks(once, "/new/path/claude-sync/src/hooks/main.ts");
    expect(twice.hooks!.SessionStart).toHaveLength(1);
    expect(twice.hooks!.SessionStart![0]!.hooks[0]!.command).toContain("/new/path/");
  });
});

describe("removeHooks", () => {
  test("removes our entries and drops the hooks key entirely when nothing else remains", () => {
    const merged = mergeHooks({ model: "x" }, HOOK_MAIN);
    const removed = removeHooks(merged);
    expect(removed.hooks).toBeUndefined();
    expect(removed.model).toBe("x");
  });

  test("leaves another tool's entry on the same event intact after removal", () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "some-other-tool --notify" }] }],
      },
    };
    const merged = mergeHooks(settings, HOOK_MAIN);
    const removed = removeHooks(merged);
    expect(removed.hooks!.SessionStart).toHaveLength(1);
    expect(removed.hooks!.SessionStart![0]!.hooks[0]!.command).toBe("some-other-tool --notify");
  });

  test("is a no-op on settings with no hooks key at all", () => {
    const settings = { model: "x" };
    expect(removeHooks(settings)).toEqual(settings);
  });

  test("round-trips: merge then remove restores the original settings shape", () => {
    const original = { model: "claude-fable-5", enabledPlugins: { foo: true } };
    const restored = removeHooks(mergeHooks(original, HOOK_MAIN));
    expect(restored).toEqual(original);
  });
});
