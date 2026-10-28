// What the sidebar's GLOBALS fold shows (DR-0043 §5): the endpoints to move
// to and where a move lands (§5.1), and which Claude Code version stands for
// the host (§5.3).
import { describe, expect, test } from "bun:test";
import {
  endpointChoices,
  endpointLabel,
  hostClaudeVersion,
  lastSessionClaudeVersion,
  switchedHref,
} from "../src/client/sidebar-globals.ts";

describe("endpointLabel", () => {
  test("the host for https, the scheme added for anything else", () => {
    expect(endpointLabel("https://ccmsg.v6.example.com")).toBe("ccmsg.v6.example.com");
    expect(endpointLabel("https://ccmsg.example.com:8443")).toBe("ccmsg.example.com:8443");
    expect(endpointLabel("http://ccmsg.lan.example.com:8080")).toBe(
      "http://ccmsg.lan.example.com:8080",
    );
    expect(endpointLabel("http://127.0.0.1:8642")).toBe("http://127.0.0.1:8642");
  });

  test("an origin that does not parse is written as it came", () => {
    expect(endpointLabel("not an origin")).toBe("not an origin");
  });
});

describe("endpointChoices", () => {
  const A = "https://ccmsg.a.example.com";
  const V6 = "https://ccmsg.v6.example.com";

  test("the daemon's order, with the page's own origin where the daemon put it", () => {
    expect(endpointChoices(V6, [A, V6]).map((c) => c.origin)).toEqual([A, V6]);
  });

  // The page opened at the daemon's bind (a loopback name) is in no list the
  // daemon sends, and the choice still has to say where the page is.
  test("the page's own origin first when the daemon does not list it", () => {
    const here = "http://127.0.0.1:8642";
    expect(endpointChoices(here, [A, V6])).toEqual([
      { origin: here, label: "http://127.0.0.1:8642" },
      { origin: A, label: "ccmsg.a.example.com" },
      { origin: V6, label: "ccmsg.v6.example.com" },
    ]);
  });

  test("only the page's own origin with nothing listed, or from a daemon that lists none", () => {
    expect(endpointChoices(A, [])).toEqual([{ origin: A, label: "ccmsg.a.example.com" }]);
    expect(endpointChoices(A, undefined)).toEqual([{ origin: A, label: "ccmsg.a.example.com" }]);
    expect(endpointChoices(A, [A])).toEqual([{ origin: A, label: "ccmsg.a.example.com" }]);
  });
});

describe("switchedHref", () => {
  // The URL is the screen's state, the sidebar's `sb.*` included, so the move
  // carries all of it and changes only the origin.
  test("keeps the path, query and hash, and changes the origin only", () => {
    const href = "https://ccmsg.a.example.com/s/abc/timeline?sb.panel=search&sb.q=x%20y#m-12";
    const moved = new URL(switchedHref(href, "https://ccmsg.v6.example.com"));
    const before = new URL(href);
    expect(moved.origin).toBe("https://ccmsg.v6.example.com");
    expect(moved.pathname).toBe(before.pathname);
    expect(moved.search).toBe(before.search);
    expect(moved.hash).toBe(before.hash);
  });

  test("onto an origin with a port and another scheme", () => {
    expect(switchedHref("https://ccmsg.a.example.com/", "http://ccmsg.lan.example.com:8080")).toBe(
      "http://ccmsg.lan.example.com:8080/",
    );
  });
});

describe("lastSessionClaudeVersion", () => {
  test("the version of the session started last, not the highest one", () => {
    expect(
      lastSessionClaudeVersion([
        { startedAt: 100, version: "2.1.400" },
        { startedAt: 300, version: "2.1.312" },
        { startedAt: 200, version: "2.1.350" },
      ]),
    ).toEqual({ version: "2.1.312", at: 300 });
  });

  test("passes over rows that name no version", () => {
    expect(
      lastSessionClaudeVersion([
        { startedAt: 100, version: "2.1.310" },
        { startedAt: 300 },
        { startedAt: 400, version: "" },
      ]),
    ).toEqual({ version: "2.1.310", at: 100 });
  });

  test("none when no row names a version", () => {
    expect(lastSessionClaudeVersion([])).toBeNull();
    expect(lastSessionClaudeVersion([{ startedAt: 1 }])).toBeNull();
  });
});

describe("hostClaudeVersion", () => {
  const session = { version: "2.1.310", at: 1_000 };

  // Whichever was seen later: an update after the last start shows what the
  // daemon read, a session started after the update shows its own version.
  test("the later of the session started last and the daemon's reading", () => {
    expect(hostClaudeVersion(session, { version: "2.1.312", at: 2_000 })).toBe("2.1.312");
    expect(
      hostClaudeVersion({ version: "2.1.313", at: 3_000 }, { version: "2.1.312", at: 2_000 }),
    ).toBe("2.1.313");
  });

  // Not the higher version: a later reading of an older version still wins.
  test("the later one even when it names the lower version", () => {
    expect(
      hostClaudeVersion({ version: "2.1.400", at: 1_000 }, { version: "2.1.312", at: 2_000 }),
    ).toBe("2.1.312");
  });

  test("either alone, or none", () => {
    expect(hostClaudeVersion(session, null)).toBe("2.1.310");
    expect(hostClaudeVersion(null, { version: "2.1.312", at: 2_000 })).toBe("2.1.312");
    expect(hostClaudeVersion(null, null)).toBeNull();
  });
});
