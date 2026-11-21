// Session bookmarks' repo/ws rule (DR-0021 §2.4/§3.2). The sidebar's Bookmarks row
// used to print the stored bookmark's own repo/ws, which made one connected session
// render two different first lines at once: the full `repo@ws` in its status
// section (live PeerInfo) and whatever half pair the bookmark was frozen with above
// it. Bookmarks are keyed by cwd; the refresh tests key by the fixture's
// cwd accordingly. The reducer-side fold is exercised through `peers/loaded` in
// store.test.ts; these cover the two functions directly.
import { describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import {
  type SessionBookmark,
  sessionBookmarkFromHit,
  sessionBookmarkRows,
  sessionBookmarksFromList,
  sessionBookmarkLabel,
  sessionBookmarkTitle,
  refreshSessionBookmarksFromAgents,
  refreshSessionBookmarksFromPeers,
} from "../src/client/session-bookmarks.ts";
import { peerLocation } from "./helpers.ts";

const CWD = "/repos/claude-ccmsg/main";

function bookmark(overrides: Partial<SessionBookmark> = {}): SessionBookmark {
  return {
    sid: "s1",
    cwd: "/repos/claude-ccmsg/main",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    title: null,
    file: "/home/.claude/projects/x/s1.jsonl",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function hit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    sid: "s1",
    config_dir: "/home/.claude",
    file: "/home/.claude/projects/x/s1.jsonl",
    cwd: "/repos/claude-ccmsg/main",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    size: 2048,
    matches: [],
    title: null,
    ...overrides,
  };
}

function peer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    sid: "s1",
    ...peerLocation("kawaz/claude-ccmsg", "main"),
    cwd: "/repos/claude-ccmsg/main",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    pid: 1,
    cwd: "/repos/claude-ccmsg/main",
    kind: "interactive",
    startedAt: 1,
    sessionId: "s1",
    name: "Issue管理",
    config_dir: "/home/.claude",
    ...overrides,
  };
}

describe("sessionBookmarkLabel", () => {
  test("prefers the live peer's repo/ws over the bookmark's stored snapshot", () => {
    expect(
      sessionBookmarkLabel(
        bookmark({ repo: null, ws: "wip-issue-board" }),
        peer(peerLocation("kawaz/claude-ccmsg", "wip-issue-board")),
      ),
    ).toEqual({ repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("keeps the stored repo/ws when the bookmarked session has no live peer", () => {
    expect(sessionBookmarkLabel(bookmark({ repo: "kawaz/bookmarked" }), undefined)).toEqual({
      repo: "kawaz/bookmarked",
      ws: "main",
    });
  });

  // A peer that announced neither (and whose cwd the daemon could not resolve)
  // must not blank out a bookmark that does know its repo/ws — "live first" is
  // decided on the pair, so an empty pair is not a source.
  test("keeps the stored repo/ws when the live peer has neither", () => {
    expect(
      sessionBookmarkLabel(
        bookmark({ repo: "kawaz/bookmarked" }),
        peer({ ...peerLocation("", "") }),
      ),
    ).toEqual({
      repo: "kawaz/bookmarked",
      ws: "main",
    });
  });

  // Nothing is invented: with no live peer and a bookmark that stored neither, the
  // row keeps its own cwd-leaf fallback (SessionList) rather than getting a
  // substitute label from here.
  test("returns an empty pair when neither source has repo/ws", () => {
    expect(sessionBookmarkLabel(bookmark({ repo: null, ws: null }), undefined)).toEqual({
      repo: "",
      ws: "",
    });
  });
});

describe("sessionBookmarkTitle", () => {
  // What `/rename` set is reported by `claude agents --json` as `name`, and a
  // rename after the bookmark was made must win over the frozen record.
  test("prefers the live agent's name over the bookmark's stored title", () => {
    expect(
      sessionBookmarkTitle(bookmark({ title: "古いタイトル" }), agent({ name: "新しい名前" })),
    ).toBe("新しい名前");
  });

  test("falls back to the stored title when the session is not running", () => {
    expect(sessionBookmarkTitle(bookmark({ title: "Issue管理" }), undefined)).toBe("Issue管理");
  });

  // A session that never renamed itself reports no name; that is not a reason
  // to drop a title Session Search recovered from the transcript.
  test("keeps the stored title when the live agent has no name", () => {
    expect(sessionBookmarkTitle(bookmark({ title: "Issue管理" }), agent({ name: undefined }))).toBe(
      "Issue管理",
    );
  });

  // No stand-in is produced here — SessionList applies the row's own cwd-leaf
  // then short-sid fallback, the same tail sessionRowTitle uses.
  test("returns an empty string when neither source knows a title", () => {
    expect(sessionBookmarkTitle(bookmark({ title: null }), agent({ name: undefined }))).toBe("");
  });
});

describe("refreshSessionBookmarksFromAgents", () => {
  test("writes a renamed session's title back into its bookmark", () => {
    const stored = bookmark({ title: "古いタイトル" });
    const bookmarks = new Map([[CWD, stored]]);
    const next = refreshSessionBookmarksFromAgents(bookmarks, [agent({ name: "新しい名前" })]);
    expect(next.get(CWD)).toEqual({ ...stored, title: "新しい名前" });
  });

  test("returns the same Map when the bookmark's title already matches", () => {
    const bookmarks = new Map([[CWD, bookmark({ title: "Issue管理" })]]);
    expect(refreshSessionBookmarksFromAgents(bookmarks, [agent({ name: "Issue管理" })])).toBe(
      bookmarks,
    );
  });

  test("does not blank a stored title from an agent that has no name", () => {
    const bookmarks = new Map([[CWD, bookmark({ title: "Issue管理" })]]);
    expect(refreshSessionBookmarksFromAgents(bookmarks, [agent({ name: undefined })])).toBe(
      bookmarks,
    );
  });

  test("fills a bookmark that stored no title at all", () => {
    const bookmarks = new Map([[CWD, bookmark({ title: null })]]);
    expect(refreshSessionBookmarksFromAgents(bookmarks, [agent()])?.get(CWD)?.title).toBe(
      "Issue管理",
    );
  });

  test("ignores agents whose session is not bookmarked, and never mutates its input", () => {
    const bookmarks = new Map([[CWD, bookmark({ title: "Issue管理" })]]);
    expect(
      refreshSessionBookmarksFromAgents(bookmarks, [agent({ sessionId: "s2", name: "別物" })]),
    ).toBe(bookmarks);
    expect(bookmarks.get(CWD)?.title).toBe("Issue管理");
  });
});

describe("refreshSessionBookmarksFromPeers", () => {
  test("replaces a stale bookmark's repo/ws as one pair, leaving its other fields", () => {
    const stale = bookmark({
      repo: null,
      ws: "wip-issue-board",
      title: "Issue管理",
      file: "/kept.jsonl",
    });
    const bookmarks = new Map([[CWD, stale]]);
    const next = refreshSessionBookmarksFromPeers(bookmarks, [
      peer(peerLocation("kawaz/claude-ccmsg", "wip-issue-board")),
    ]);
    expect(next.get(CWD)).toEqual({ ...stale, repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("returns the same Map when every bookmark already agrees with its peer", () => {
    const bookmarks = new Map([[CWD, bookmark()]]);
    expect(refreshSessionBookmarksFromPeers(bookmarks, [peer()])).toBe(bookmarks);
  });

  test("returns the same Map when there are no bookmarks at all", () => {
    const bookmarks = new Map<string, SessionBookmark>();
    expect(refreshSessionBookmarksFromPeers(bookmarks, [peer()])).toBe(bookmarks);
  });

  test("never mutates the Map it was given", () => {
    const bookmarks = new Map([[CWD, bookmark({ repo: null })]]);
    refreshSessionBookmarksFromPeers(bookmarks, [peer()]);
    expect(bookmarks.get(CWD)?.repo).toBeNull();
  });

  // One peers push can carry several sessions; each bookmarked sid it names is
  // repaired in the single copy that push produces.
  test("repairs every bookmarked sid the peers list names", () => {
    const bookmarks = new Map([
      [CWD, bookmark({ repo: null })],
      ["/repos/two", bookmark({ sid: "s2", cwd: "/repos/two", repo: null, ws: "wip" })],
      ["/repos/three", bookmark({ sid: "s3", cwd: "/repos/three" })],
    ]);
    const next = refreshSessionBookmarksFromPeers(bookmarks, [
      peer(),
      peer({ sid: "s2", ...peerLocation("kawaz/other", "wip") }),
    ]);
    expect(next.get(CWD)?.repo).toBe("kawaz/claude-ccmsg");
    expect(next.get("/repos/two")?.repo).toBe("kawaz/other");
    expect(next.get("/repos/three")).toEqual(bookmark({ sid: "s3", cwd: "/repos/three" }));
  });
});

describe("sessionBookmarksFromList", () => {
  test("keys each stored bookmark by its cwd", () => {
    const bookmarks = sessionBookmarksFromList([
      bookmark(),
      bookmark({ sid: "s2", cwd: "/repos/two" }),
    ]);
    expect([...bookmarks.keys()]).toEqual([CWD, "/repos/two"]);
  });

  // Stored per-sid records may hold a retired session and its successor in
  // one directory; the newest stands for the directory.
  test("keeps the most recently updated bookmark when several share a cwd", () => {
    const older = bookmark({ sid: "old", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = bookmark({ sid: "new", updated_at: "2026-07-20T00:00:00.000Z" });
    expect(sessionBookmarksFromList([newer, older]).get(CWD)).toBe(newer);
    expect(sessionBookmarksFromList([older, newer]).get(CWD)).toBe(newer);
  });
});

describe("sessionBookmarkFromHit", () => {
  // A bookmark keeps what the bookmarked row and the session view read, not the search
  // answer's matches or scan size.
  test("keeps the fields a bookmark reads from a search hit", () => {
    expect(
      sessionBookmarkFromHit(
        hit({ title: "Issue管理", model: "claude-fable-5[1m]", effort: "high" }),
      ),
    ).toEqual(bookmark({ title: "Issue管理", model: "claude-fable-5[1m]", effort: "high" }));
  });

  test("leaves model and effort out when the hit has none", () => {
    expect(sessionBookmarkFromHit(hit())).toEqual(bookmark());
  });

  // A bookmark belongs to a directory; a hit Session Search could not place in one
  // cannot be bookmarked.
  test("is null for a hit with no cwd", () => {
    expect(sessionBookmarkFromHit(hit({ cwd: null }))).toBeNull();
    expect(sessionBookmarkFromHit(hit({ cwd: "" }))).toBeNull();
  });
});

describe("sessionBookmarkRows", () => {
  const noAgents = new Map<string, AgentInfo>();

  test("a bookmark with no connected peer lists the record frozen at bookmark time", () => {
    const frozen = bookmark({ title: "凍結" });
    expect(sessionBookmarkRows(new Map([[CWD, frozen]]), [], noAgents)).toEqual([
      { key: CWD, bookmark: frozen },
    ]);
  });

  // Peers in other directories are not this bookmark's sessions.
  test("ignores peers outside the bookmarked directory", () => {
    const frozen = bookmark();
    const rows = sessionBookmarkRows(
      new Map([[CWD, frozen]]),
      [peer({ sid: "s9", cwd: "/repos/else" })],
      noAgents,
    );
    expect(rows).toEqual([{ key: CWD, bookmark: frozen }]);
  });

  test("a bookmark whose own session is connected lists its frozen record", () => {
    const frozen = bookmark({ title: "凍結" });
    expect(sessionBookmarkRows(new Map([[CWD, frozen]]), [peer()], noAgents)).toEqual([
      { key: CWD, bookmark: frozen },
    ]);
  });

  // The point of a directory bookmark: a new session in the bookmarked directory shows
  // up under the bookmark without being bookmarked itself.
  test("a successor session in the bookmarked directory replaces the frozen row", () => {
    const rows = sessionBookmarkRows(
      new Map([[CWD, bookmark({ sid: "retired" })]]),
      [peer({ sid: "s2" })],
      new Map([["s2", agent({ sessionId: "s2", name: "後継" })]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(CWD);
    expect(rows[0]?.bookmark).toMatchObject({ sid: "s2", cwd: CWD, title: "後継" });
  });

  // During a handover both sessions run in the directory; neither is dropped.
  test("lists every connected session of the directory, newest first", () => {
    const rows = sessionBookmarkRows(
      new Map([[CWD, bookmark()]]),
      [
        peer({ sid: "s1", last_activity_at: "2026-07-01T00:00:00.000Z" }),
        peer({ sid: "s2", last_activity_at: "2026-07-20T00:00:00.000Z" }),
      ],
      noAgents,
    );
    expect(rows.map((row) => [row.key, row.bookmark.sid])).toEqual([
      [CWD, "s2"],
      [CWD, "s1"],
    ]);
  });

  test("orders bookmarks most recently updated first", () => {
    const rows = sessionBookmarkRows(
      new Map([
        [
          "/repos/old",
          bookmark({ sid: "a", cwd: "/repos/old", updated_at: "2026-07-01T00:00:00.000Z" }),
        ],
        [
          "/repos/new",
          bookmark({ sid: "b", cwd: "/repos/new", updated_at: "2026-07-20T00:00:00.000Z" }),
        ],
      ]),
      [],
      noAgents,
    );
    expect(rows.map((row) => row.key)).toEqual(["/repos/new", "/repos/old"]);
  });
});
