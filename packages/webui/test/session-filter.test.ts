// The SESSIONS quick filter's matching (DR-0043 §9): which rows a query keeps.
// The grammar is the Files name search's (parseFileSearchQuery): words ANDed,
// case-insensitive substring, `-word` excludes, `+word` literal. What the rows
// are matched against is the text the row identifies itself by.
import { describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import {
  parseSessionFilter,
  sessionBookmarkFilterFields,
  sessionBookmarkRowTitle,
  sessionMatchesFilter,
  sessionRowFilterFields,
  type SessionFilter,
  type SessionFilterFields,
} from "../src/client/session-filter.ts";
import type { SessionBookmark } from "../src/client/session-bookmarks.ts";
import type { SessionRow } from "../src/client/utils.ts";
import { peerLocation } from "./helpers.ts";

const SID = "a1b2c3d4-0000-4000-8000-00000000beef";

function fields(over: Partial<SessionFilterFields> = {}): SessionFilterFields {
  return {
    title: "claude-ccmsg@main 20261121T0900",
    repo: "kawaz/claude-ccmsg",
    ws: "session-quick-filter",
    branch: "feature-x",
    cwd: "/w/claude-ccmsg/session-quick-filter",
    sid: SID,
    ...over,
  };
}

function parsed(text: string): SessionFilter {
  const filter = parseSessionFilter(text);
  if (filter === null) throw new Error(`"${text}" parsed to no filter`);
  return filter;
}

function matches(text: string, over: Partial<SessionFilterFields> = {}): boolean {
  return sessionMatchesFilter(fields(over), parsed(text));
}

describe("parseSessionFilter", () => {
  // An empty box shows the list as is; it is not "match nothing".
  test("a box with no term is no filter", () => {
    expect(parseSessionFilter("")).toBeNull();
    expect(parseSessionFilter("   ")).toBeNull();
  });

  test("a box with a term is a filter", () => {
    expect(parseSessionFilter(" ccmsg ")).toEqual({ include: ["ccmsg"], exclude: [] });
    expect(parseSessionFilter("-ccmsg")).toEqual({ include: [], exclude: ["ccmsg"] });
  });
});

describe("sessionMatchesFilter", () => {
  // Each field the row shows is a target on its own.
  test("a term in any one field keeps the row", () => {
    expect(matches("20261121")).toBe(true); // title
    expect(matches("kawaz/claude")).toBe(true); // repo
    expect(matches("quick-filter")).toBe(true); // ws
    expect(matches("feature-x")).toBe(true); // branch
    expect(matches("/w/claude")).toBe(true); // cwd
    expect(matches("a1b2c3")).toBe(true); // short sid
    expect(matches("nowhere")).toBe(false);
  });

  // The sid is shown as its first 8 characters; a term that only hits the
  // hidden tail would keep a row with nothing on screen saying why.
  test("only the shown part of the sid is matched", () => {
    expect(matches("a1b2c3d4")).toBe(true);
    expect(matches("beef")).toBe(false);
  });

  test("case does not matter", () => {
    expect(matches("CCMSG")).toBe(true);
    expect(matches("Quick")).toBe(true);
  });

  // Words are ANDed; two words may hit two different fields.
  test("every word must be found, each in some field", () => {
    expect(matches("ccmsg quick")).toBe(true);
    expect(matches("ccmsg nowhere")).toBe(false);
  });

  // A term never spans the boundary between two fields.
  test("a term does not run across two fields", () => {
    expect(
      sessionMatchesFilter(
        fields({ title: "ab", repo: "cd", ws: "", branch: "", cwd: "" }),
        parsed("bc"),
      ),
    ).toBe(false);
  });

  test("a -word drops the rows holding it", () => {
    expect(matches("ccmsg -quick")).toBe(false);
    expect(matches("ccmsg -other")).toBe(true);
  });

  // Unlike the Files search (which shows nothing for an exclude-only query,
  // to avoid enumerating the repo), the session rows are all on screen
  // already: "everything but these" is a narrowing.
  test("an exclude-only query keeps every row without the word", () => {
    expect(matches("-quick")).toBe(false);
    expect(matches("-other")).toBe(true);
  });

  test("+word takes a leading - literally", () => {
    expect(matches("+-quick")).toBe(true);
    expect(matches("+-nowhere")).toBe(false);
  });

  test("absent fields are simply not matched", () => {
    expect(matches("feature", { branch: undefined })).toBe(false);
    expect(matches("/w/", { cwd: null })).toBe(false);
  });
});

describe("the fields of a row", () => {
  const agent = (name?: string): AgentInfo => ({
    pid: 1,
    cwd: "/w/x",
    kind: "interactive",
    startedAt: 1,
    sessionId: SID,
    config_dir: "/c",
    ...(name ? { name } : {}),
  });

  // The cwd is read only where the row prints it: on a row with neither
  // repo nor ws. Every cwd under one repos root shares a long prefix, which
  // would otherwise keep nearly every row for a word from it.
  test("a status row gives its title, repo, ws, branch and sid, and the cwd only when it prints it", () => {
    const row: SessionRow = {
      sid: SID,
      repo: "owner/repo",
      ws: "main",
      branch: "trunk",
      cwd: "/w/repo/main",
      agent: agent("my session"),
      connected: true,
    };
    expect(sessionRowFilterFields(row)).toEqual({
      title: "my session",
      repo: "owner/repo",
      ws: "main",
      branch: "trunk",
      cwd: undefined,
      sid: SID,
    });
    expect(sessionRowFilterFields({ ...row, repo: "", ws: "" }).cwd).toBe("/w/repo/main");
  });

  const bookmark: SessionBookmark = {
    sid: SID,
    cwd: "/bookmarked/repo-dir",
    repo: "owner/stored",
    ws: "stored-ws",
    title: null,
    file: "",
    updated_at: "2026-11-21T00:00:00.000Z",
  };

  // A bookmarked row prints the live peer's repo/ws while it is connected, else
  // the stored pair; the filter reads the same pair.
  test("a bookmarked row gives the repo/ws it prints, live first", () => {
    expect(sessionBookmarkFilterFields(bookmark, undefined, undefined)).toEqual({
      title: "repo-dir",
      repo: "owner/stored",
      ws: "stored-ws",
      branch: undefined,
      cwd: undefined,
      sid: SID,
    });
    const peer: PeerInfo = {
      sid: SID,
      cwd: "/bookmarked/repo-dir",
      ...peerLocation("owner/live", "live-ws", "live-branch"),
    };
    expect(sessionBookmarkFilterFields(bookmark, peer, agent("live title"))).toEqual({
      title: "live title",
      repo: "owner/live",
      ws: "live-ws",
      branch: "live-branch",
      cwd: undefined,
      sid: SID,
    });
    // A bookmark with no repo/ws prints its cwd.
    expect(
      sessionBookmarkFilterFields({ ...bookmark, repo: null, ws: null }, undefined, undefined).cwd,
    ).toBe("/bookmarked/repo-dir");
  });

  test("a bookmarked row's title falls back from the agent, the stored title, the cwd leaf, to the short sid", () => {
    expect(sessionBookmarkRowTitle({ ...bookmark, title: "stored" }, agent("live"))).toBe("live");
    expect(sessionBookmarkRowTitle({ ...bookmark, title: "stored" }, undefined)).toBe("stored");
    expect(sessionBookmarkRowTitle(bookmark, undefined)).toBe("repo-dir");
    expect(sessionBookmarkRowTitle({ ...bookmark, cwd: "" }, undefined)).toBe(SID.slice(0, 8));
  });
});
