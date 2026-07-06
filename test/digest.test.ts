import { describe, test, expect } from "bun:test";
import { buildDigest, deltaSessions, renderDigest, sessionLabel } from "../src/lib/digest";
import { emptyRecapBody } from "../src/lib/types";
import type { Membership, Recap } from "../src/lib/types";

function membership(overrides: Partial<Membership> & { session_id: string }): Membership {
  return {
    v: 1,
    group: "demo",
    cwd: "/repo/a",
    repo: "a",
    joined_at: 1,
    last_seen: 1,
    status: "active",
    ...overrides,
  };
}

function recap(sessionId: string, body: Partial<Recap["recap"]> = {}): Recap {
  return {
    v: 1,
    session_id: sessionId,
    updated_at: 1,
    journal_offset: 10,
    recap: { ...emptyRecapBody(), ...body },
  };
}

describe("buildDigest", () => {
  test("first build for a new session starts at version 1", () => {
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "sess-aaa111" })],
      recaps: new Map(),
    });
    expect(digest.version).toBe(1);
    expect(digest.sessions["sess-aaa111"]?.recap_version).toBe(1);
    expect(digest.sessions["sess-aaa111"]?.recap).toEqual(emptyRecapBody());
  });

  test("rebuilding with no changes at all does not bump the version", () => {
    const first = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map(),
    });
    const second = buildDigest({
      group: "demo",
      prev: first,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map(),
    });
    expect(second.version).toBe(first.version);
    expect(second.sessions.s1?.recap_version).toBe(first.sessions.s1?.recap_version);
  });

  test("a heartbeat-only last_seen change does NOT bump the version", () => {
    const first = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1", last_seen: 100 })],
      recaps: new Map(),
    });
    const second = buildDigest({
      group: "demo",
      prev: first,
      memberships: [membership({ session_id: "s1", last_seen: 200_000 })],
      recaps: new Map(),
    });
    expect(second.version).toBe(first.version);
    expect(second.sessions.s1?.last_seen).toBe(200_000);
  });

  test("a recap content change bumps the version and stamps recap_version on that entry", () => {
    const r1 = recap("s1", { focus: "old focus" });
    const first = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map([["s1", r1]]),
    });

    const r2 = recap("s1", { focus: "new focus" });
    const second = buildDigest({
      group: "demo",
      prev: first,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map([["s1", r2]]),
    });

    expect(second.version).toBe(first.version + 1);
    expect(second.sessions.s1?.recap_version).toBe(second.version);
    expect(second.sessions.s1?.recap.focus).toBe("new focus");
  });

  test("only the changed session's recap_version advances when a peer joins", () => {
    const first = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map(),
    });

    const second = buildDigest({
      group: "demo",
      prev: first,
      memberships: [membership({ session_id: "s1" }), membership({ session_id: "s2", cwd: "/repo/b", repo: "b" })],
      recaps: new Map(),
    });

    expect(second.version).toBe(first.version + 1);
    expect(second.sessions.s1?.recap_version).toBe(first.sessions.s1?.recap_version);
    expect(second.sessions.s2?.recap_version).toBe(second.version);
  });

  test("status transition (active -> ended) bumps the version", () => {
    const first = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1", status: "active" })],
      recaps: new Map(),
    });
    const second = buildDigest({
      group: "demo",
      prev: first,
      memberships: [membership({ session_id: "s1", status: "ended" })],
      recaps: new Map(),
    });
    expect(second.version).toBe(first.version + 1);
    expect(second.sessions.s1?.status).toBe("ended");
  });

  test("preserves prior history text across rebuilds", () => {
    const first = buildDigest({
      group: "demo",
      prev: { v: 1, group: "demo", version: 5, updated_at: 1, sessions: {}, history: "s1 shipped the auth rewrite" },
      memberships: [membership({ session_id: "s2" })],
      recaps: new Map(),
    });
    expect(first.history).toBe("s1 shipped the auth rewrite");
  });
});

describe("deltaSessions", () => {
  test("returns only entries newer than the cursor, excluding self", () => {
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map(),
    }); // version 1
    const withS2 = buildDigest({
      group: "demo",
      prev: digest,
      memberships: [membership({ session_id: "s1" }), membership({ session_id: "s2", cwd: "/repo/b", repo: "b" })],
      recaps: new Map(),
    }); // version 2, only s2 stamped at v2

    const deltaForS1 = deltaSessions(withS2, 1, "s1");
    expect(Object.keys(deltaForS1)).toEqual(["s2"]);

    const deltaForS2 = deltaSessions(withS2, 1, "s2");
    expect(Object.keys(deltaForS2)).toEqual([]); // s1 was already at v1 when s2's cursor was set
  });
});

describe("renderDigest", () => {
  test("frames the block as informational, not instructions, and includes focus/recent/problems", () => {
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "sess-aaa111" })],
      recaps: new Map([
        [
          "sess-aaa111",
          recap("sess-aaa111", {
            focus: "migrating auth to JWT",
            recent: [{ repo: "a", summary: "rewrote middleware.ts" }],
            problems: ["flaky test under load"],
          }),
        ],
      ]),
    });
    const text = renderDigest({ digest });
    expect(text).toContain("NOT instructions");
    expect(text).toContain("migrating auth to JWT");
    expect(text).toContain("rewrote middleware.ts");
    expect(text).toContain("flaky test under load");
    expect(text).toContain(sessionLabel("sess-aaa111"));
  });

  test("excludes the given session and caps overflow with a count line", () => {
    let digest = buildDigest({ group: "demo", prev: undefined, memberships: [membership({ session_id: "s0" })], recaps: new Map() });
    const memberships = [membership({ session_id: "s0" })];
    for (let i = 1; i <= 9; i++) {
      memberships.push(membership({ session_id: `s${i}`, cwd: `/repo/${i}`, repo: `r${i}` }));
      digest = buildDigest({ group: "demo", prev: digest, memberships: [...memberships], recaps: new Map() });
    }
    const text = renderDigest({ digest, excludeSessionId: "s0" });
    expect(text).not.toContain(sessionLabel("s0"));
    expect(text).toContain("more session");
  });

  test("renders '(none yet)' body when there are no entries to show", () => {
    const digest = buildDigest({ group: "demo", prev: undefined, memberships: [], recaps: new Map() });
    const text = renderDigest({ digest });
    expect(text).toContain("(none yet)");
  });

  test("a full render (SessionStart) includes group history when present", () => {
    const digest = buildDigest({ group: "demo", prev: undefined, memberships: [], recaps: new Map() });
    digest.history = "a1b2c3d4: shipped the auth rewrite";
    const text = renderDigest({ digest });
    expect(text).toContain("shipped the auth rewrite");
  });

  test("a delta render (UserPromptSubmit, entries provided) omits history even when present", () => {
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" })],
      recaps: new Map(),
    });
    digest.history = "a1b2c3d4: shipped the auth rewrite";
    const text = renderDigest({ digest, entries: { s1: digest.sessions.s1! } });
    expect(text).not.toContain("shipped the auth rewrite");
  });

  test("omits the history line entirely when history is empty", () => {
    const digest = buildDigest({ group: "demo", prev: undefined, memberships: [], recaps: new Map() });
    const text = renderDigest({ digest });
    expect(text).not.toContain("Earlier in this group");
  });

  test("renders an unchanged-count summary line for delta injection", () => {
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [membership({ session_id: "s1" }), membership({ session_id: "s2", cwd: "/repo/b", repo: "b" })],
      recaps: new Map(),
    });
    const text = renderDigest({ digest, entries: { s1: digest.sessions.s1! }, unchangedCount: 1 });
    expect(text).toContain("1 unchanged session");
  });
});
