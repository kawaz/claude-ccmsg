// Locator parse/format tests (DR-0004 §5 room form, DR-0008 session form).
// The core contract this file guards: format(x) round-trips through
// parseHash back to an equivalent Locator, for every shape the two views
// produce, and the two forms never get confused for one another.
import { describe, expect, test } from "bun:test";
import {
  agentTimelineHref,
  fileHref,
  messageHref,
  parseHash,
  roomHref,
  sessionHref,
  timelineHref,
  type Locator,
} from "../src/client/locator.ts";

describe("parseHash / room form (unchanged, DR-0004 §5)", () => {
  test("empty hash -> no room selected", () => {
    expect(parseHash("")).toEqual({ view: "room", room: null, mid: null });
    expect(parseHash("#")).toEqual({ view: "room", room: null, mid: null });
  });

  test("#rXXXX -> room only, no message anchor", () => {
    expect(parseHash("#r1")).toEqual({ view: "room", room: "r1", mid: null });
  });

  test("#rXXXX-mNN -> room + message anchor", () => {
    expect(parseHash("#r1-m42")).toEqual({ view: "room", room: "r1", mid: 42 });
  });

  test("roomHref/messageHref round-trip through parseHash", () => {
    expect(parseHash(roomHref("r7"))).toEqual({ view: "room", room: "r7", mid: null });
    expect(parseHash(messageHref("r7", 9))).toEqual({ view: "room", room: "r7", mid: 9 });
  });
});

describe("parseHash / session form (DR-0008)", () => {
  // Bare `#s<sid>`: session selected, no file open yet (FileTree shown, viewer empty).
  test("#s<sid> -> session view, no file selected", () => {
    expect(parseHash("#sabc123")).toEqual({ view: "session", sid: "abc123", path: null });
  });

  // `#s<sid>:<relpath>`: session + file selected. Path is percent-decoded so
  // the reducer/components work with the real relpath, not its wire form.
  test("#s<sid>:<relpath> -> session view with file selected", () => {
    expect(parseHash("#sabc123:src%2Findex.ts")).toEqual({
      view: "session",
      sid: "abc123",
      path: "src/index.ts",
    });
  });

  test("sessionHref/fileHref round-trip through parseHash", () => {
    expect(parseHash(sessionHref("sess-1"))).toEqual({
      view: "session",
      sid: "sess-1",
      path: null,
    });
    const loc: Locator = { view: "session", sid: "sess-1", path: "a/b c.txt" };
    expect(parseHash(fileHref(loc.sid, loc.path ?? ""))).toEqual(loc);
  });

  test("DR-0024 absolute external path survives fileHref round-trip", () => {
    // The whole path is percent-encoded, so a leading `/` remains data rather
    // than becoming locator syntax and FileViewer receives the exact allowlist key.
    const loc: Locator = { view: "session", sid: "sess-1", path: "/external/shared file.md" };
    expect(parseHash(fileHref(loc.sid, loc.path ?? ""))).toEqual(loc);
  });

  // A relpath containing characters that would otherwise collide with the
  // locator's own syntax (`:`, `#`, `/`) must still survive because fileHref
  // encodes the whole path segment, not just risky characters.
  test("relpath containing ':' and '/' survives the round-trip", () => {
    const loc: Locator = { view: "session", sid: "s1", path: "weird:name/deep/file.txt" };
    expect(parseHash(fileHref(loc.sid, loc.path ?? ""))).toEqual(loc);
  });

  // sid is encoded symmetrically with path (both via sessionHref/fileHref and
  // decoded back in parseHash), so a sid containing ':' — which would
  // otherwise be misread as the sid/path separator — still round-trips.
  test("sid containing ':' survives the round-trip", () => {
    const loc: Locator = { view: "session", sid: "weird:sid", path: null };
    expect(parseHash(sessionHref(loc.sid))).toEqual(loc);

    const withPath: Locator = { view: "session", sid: "weird:sid", path: "a.txt" };
    expect(parseHash(fileHref(withPath.sid, withPath.path ?? ""))).toEqual(withPath);
  });

  // Malformed percent-encoding (e.g. a lone "%zz") must not throw — parseHash
  // runs at module load in main.tsx, uncaught it would blank the whole page.
  // The path segment falls back to "no file selected" (same session, empty
  // viewer) rather than a garbled path.
  test("malformed percent-encoding in the path segment falls back to no file selected, not a thrown error", () => {
    expect(() => parseHash("#s1:%zz")).not.toThrow();
    expect(parseHash("#s1:%zz")).toEqual({ view: "session", sid: "1", path: null });
  });

  // Same guarantee for a malformed sid segment: falls back to the raw
  // (still-encoded) sid rather than throwing.
  test("malformed percent-encoding in the sid segment falls back to the raw sid, not a thrown error", () => {
    expect(() => parseHash("#s%zz")).not.toThrow();
    expect(parseHash("#s%zz")).toEqual({ view: "session", sid: "%zz", path: null });
  });
});

describe("parseHash / timeline form (DR-0009)", () => {
  // Bare `#t<sid>`: the Timeline pane has no client-chosen path (byte-offset
  // paging state lives in the store, not the URL), so — unlike the session
  // form — there is no `:<something>` sub-form to test here.
  test("#t<sid> -> timeline view for that sid", () => {
    expect(parseHash("#tabc123")).toEqual({ view: "timeline", sid: "abc123" });
  });

  test("timelineHref round-trips through parseHash", () => {
    expect(parseHash(timelineHref("sess-1"))).toEqual({ view: "timeline", sid: "sess-1" });
  });

  // Same encode/decode symmetry the session form guarantees for sid: a raw
  // sid containing characters with syntactic meaning elsewhere (':', '#')
  // must still survive because timelineHref encodes the whole segment.
  test("sid containing ':' and '#' survives the round-trip", () => {
    const loc: Locator = { view: "timeline", sid: "weird:sid#1" };
    expect(parseHash(timelineHref(loc.sid))).toEqual(loc);
  });

  // Malformed percent-encoding must not throw, same policy as the session
  // form's sid fallback (falls back to the raw, still-encoded sid).
  test("malformed percent-encoding in the sid segment falls back to the raw sid, not a thrown error", () => {
    expect(() => parseHash("#t%zz")).not.toThrow();
    expect(parseHash("#t%zz")).toEqual({ view: "timeline", sid: "%zz" });
  });
});

describe("parseHash / timeline agent form (DR-0025)", () => {
  test("#t<sid>:a... -> direct subagent under sid", () => {
    const loc = parseHash("#tabc:a1234567890abcdef");
    expect(loc).toEqual({
      view: "timeline",
      sid: "abc",
      agent: { agentId: "a1234567890abcdef" },
    });
  });

  test("#t<sid>:<runId>/<agentId> -> workflow-owned agent", () => {
    const loc = parseHash("#tabc:wf_01234567-abc/a1111111111111111");
    expect(loc).toEqual({
      view: "timeline",
      sid: "abc",
      agent: { runId: "wf_01234567-abc", agentId: "a1111111111111111" },
    });
  });

  test("#t<sid>:tm/<name> -> teammate", () => {
    const loc = parseHash("#tabc:tm/my-mate");
    expect(loc).toEqual({
      view: "timeline",
      sid: "abc",
      agent: { teammate: "my-mate" },
    });
  });

  test("agentTimelineHref round-trips through parseHash", () => {
    for (const ref of [
      { agentId: "a1234567890abcdef" },
      { runId: "wf_01234567-abc", agentId: "a2222222222222222" },
      { teammate: "some/mate" }, // encoded through
    ]) {
      const href = agentTimelineHref("sess-1", ref);
      const parsed = parseHash(href);
      expect(parsed.view).toBe("timeline");
      if (parsed.view === "timeline") {
        expect(parsed.sid).toBe("sess-1");
        expect(parsed.agent).toEqual(ref);
      }
    }
  });

  test("existing plain #t<sid> stays agentless", () => {
    const loc = parseHash("#tabc123");
    expect(loc).toEqual({ view: "timeline", sid: "abc123" });
  });
});

describe("parseHash / room, session, and timeline forms never collide", () => {
  // Room ids are always daemon-assigned as "r<n>" (server.ts), so a session
  // locator's leading literal "s" cannot be produced by roomHref, and no
  // existing room id starts with "s" — this test pins that invariant from
  // the client side.
  test("a hash starting with 's' is always parsed as a session locator", () => {
    const loc = parseHash("#s1");
    expect(loc.view).toBe("session");
  });

  test("a hash starting with 'r' is always parsed as a room locator", () => {
    const loc = parseHash("#r1");
    expect(loc.view).toBe("room");
  });

  // Same invariant for the timeline form's leading "t" (DR-0009): no
  // daemon-assigned room id starts with "t" either.
  test("a hash starting with 't' is always parsed as a timeline locator", () => {
    const loc = parseHash("#t1");
    expect(loc.view).toBe("timeline");
  });
});
