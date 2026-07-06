import { describe, test, expect } from "bun:test";
import { parseFlags } from "../src/cli";

describe("parseFlags", () => {
  test("separates positional args from --flag value pairs", () => {
    const { positional, flags } = parseFlags(["join", "demo", "--cwd", "/repo/a"]);
    expect(positional).toEqual(["join", "demo"]);
    expect(flags.cwd).toBe("/repo/a");
  });

  test("a flag with no following value (or followed by another flag) becomes boolean 'true'", () => {
    const { flags } = parseFlags(["uninstall", "--purge"]);
    expect(flags.purge).toBe("true");
  });

  test("handles a multi-word message passed as a single --message value", () => {
    const { positional, flags } = parseFlags(["--message", "don't touch schema.sql", "--cwd", "/repo/a"]);
    expect(flags.message).toBe("don't touch schema.sql");
    expect(flags.cwd).toBe("/repo/a");
    expect(positional).toEqual([]);
  });
});
