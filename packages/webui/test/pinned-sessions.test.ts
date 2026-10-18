// Pinned sessions' repo/ws rule (DR-0021 §2.4/§3.2). The sidebar's Pinned row
// used to print the stored pin's own repo/ws, which made one connected session
// render two different first lines at once: the full `repo@ws` in its status
// section (live PeerInfo) and whatever half pair the pin was frozen with above
// it. Pins are keyed by cwd; the refresh tests key by the fixture's
// cwd accordingly. The reducer-side fold is exercised through `peers/loaded` in
// store.test.ts; these cover the two functions directly.
import { describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import {
  type Pin,
  pinFromHit,
  pinnedRows,
  pinsFromList,
  pinnedSessionLabel,
  pinnedSessionTitle,
  refreshPinsFromAgents,
  refreshPinsFromPeers,
} from "../src/client/pinned-sessions.ts";

const CWD = "/repos/claude-ccmsg/main";

function pin(overrides: Partial<Pin> = {}): Pin {
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
    repo: "kawaz/claude-ccmsg",
    ws: "main",
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

describe("pinnedSessionLabel", () => {
  test("prefers the live peer's repo/ws over the pin's stored snapshot", () => {
    expect(
      pinnedSessionLabel(
        pin({ repo: null, ws: "wip-issue-board" }),
        peer({ ws: "wip-issue-board" }),
      ),
    ).toEqual({ repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("keeps the stored repo/ws when the pinned session has no live peer", () => {
    expect(pinnedSessionLabel(pin({ repo: "kawaz/pinned" }), undefined)).toEqual({
      repo: "kawaz/pinned",
      ws: "main",
    });
  });

  // A peer that announced neither (and whose cwd the daemon could not resolve)
  // must not blank out a pin that does know its repo/ws — "live first" is
  // decided on the pair, so an empty pair is not a source.
  test("keeps the stored repo/ws when the live peer has neither", () => {
    expect(pinnedSessionLabel(pin({ repo: "kawaz/pinned" }), peer({ repo: "", ws: "" }))).toEqual({
      repo: "kawaz/pinned",
      ws: "main",
    });
  });

  // Nothing is invented: with no live peer and a pin that stored neither, the
  // row keeps its own cwd-leaf fallback (SessionList) rather than getting a
  // substitute label from here.
  test("returns an empty pair when neither source has repo/ws", () => {
    expect(pinnedSessionLabel(pin({ repo: null, ws: null }), undefined)).toEqual({
      repo: "",
      ws: "",
    });
  });
});

describe("pinnedSessionTitle", () => {
  // What `/rename` set is reported by `claude agents --json` as `name`, and a
  // rename after the pin was made must win over the frozen record.
  test("prefers the live agent's name over the pin's stored title", () => {
    expect(pinnedSessionTitle(pin({ title: "古いタイトル" }), agent({ name: "新しい名前" }))).toBe(
      "新しい名前",
    );
  });

  test("falls back to the stored title when the session is not running", () => {
    expect(pinnedSessionTitle(pin({ title: "Issue管理" }), undefined)).toBe("Issue管理");
  });

  // A session that never renamed itself reports no name; that is not a reason
  // to drop a title Session Search recovered from the transcript.
  test("keeps the stored title when the live agent has no name", () => {
    expect(pinnedSessionTitle(pin({ title: "Issue管理" }), agent({ name: undefined }))).toBe(
      "Issue管理",
    );
  });

  // No stand-in is produced here — SessionList applies the row's own cwd-leaf
  // then short-sid fallback, the same tail sessionRowTitle uses.
  test("returns an empty string when neither source knows a title", () => {
    expect(pinnedSessionTitle(pin({ title: null }), agent({ name: undefined }))).toBe("");
  });
});

describe("refreshPinsFromAgents", () => {
  test("writes a renamed session's title back into its pin", () => {
    const stored = pin({ title: "古いタイトル" });
    const pins = new Map([[CWD, stored]]);
    const next = refreshPinsFromAgents(pins, [agent({ name: "新しい名前" })]);
    expect(next.get(CWD)).toEqual({ ...stored, title: "新しい名前" });
  });

  test("returns the same Map when the pin's title already matches", () => {
    const pins = new Map([[CWD, pin({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ name: "Issue管理" })])).toBe(pins);
  });

  test("does not blank a stored title from an agent that has no name", () => {
    const pins = new Map([[CWD, pin({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ name: undefined })])).toBe(pins);
  });

  test("fills a pin that stored no title at all", () => {
    const pins = new Map([[CWD, pin({ title: null })]]);
    expect(refreshPinsFromAgents(pins, [agent()])?.get(CWD)?.title).toBe("Issue管理");
  });

  test("ignores agents whose session is not pinned, and never mutates its input", () => {
    const pins = new Map([[CWD, pin({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ sessionId: "s2", name: "別物" })])).toBe(pins);
    expect(pins.get(CWD)?.title).toBe("Issue管理");
  });
});

describe("refreshPinsFromPeers", () => {
  test("replaces a stale pin's repo/ws as one pair, leaving its other fields", () => {
    const stale = pin({
      repo: null,
      ws: "wip-issue-board",
      title: "Issue管理",
      file: "/kept.jsonl",
    });
    const pins = new Map([[CWD, stale]]);
    const next = refreshPinsFromPeers(pins, [peer({ ws: "wip-issue-board" })]);
    expect(next.get(CWD)).toEqual({ ...stale, repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("returns the same Map when every pin already agrees with its peer", () => {
    const pins = new Map([[CWD, pin()]]);
    expect(refreshPinsFromPeers(pins, [peer()])).toBe(pins);
  });

  test("returns the same Map when there are no pins at all", () => {
    const pins = new Map<string, Pin>();
    expect(refreshPinsFromPeers(pins, [peer()])).toBe(pins);
  });

  test("never mutates the Map it was given", () => {
    const pins = new Map([[CWD, pin({ repo: null })]]);
    refreshPinsFromPeers(pins, [peer()]);
    expect(pins.get(CWD)?.repo).toBeNull();
  });

  // One peers push can carry several sessions; each pinned sid it names is
  // repaired in the single copy that push produces.
  test("repairs every pinned sid the peers list names", () => {
    const pins = new Map([
      [CWD, pin({ repo: null })],
      ["/repos/two", pin({ sid: "s2", cwd: "/repos/two", repo: null, ws: "wip" })],
      ["/repos/three", pin({ sid: "s3", cwd: "/repos/three" })],
    ]);
    const next = refreshPinsFromPeers(pins, [
      peer(),
      peer({ sid: "s2", repo: "kawaz/other", ws: "wip" }),
    ]);
    expect(next.get(CWD)?.repo).toBe("kawaz/claude-ccmsg");
    expect(next.get("/repos/two")?.repo).toBe("kawaz/other");
    expect(next.get("/repos/three")).toEqual(pin({ sid: "s3", cwd: "/repos/three" }));
  });
});

describe("pinsFromList", () => {
  test("keys each stored pin by its cwd", () => {
    const pins = pinsFromList([pin(), pin({ sid: "s2", cwd: "/repos/two" })]);
    expect([...pins.keys()]).toEqual([CWD, "/repos/two"]);
  });

  // Stored per-sid records may hold a retired session and its successor in
  // one directory; the newest stands for the directory.
  test("keeps the most recently updated pin when several share a cwd", () => {
    const older = pin({ sid: "old", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = pin({ sid: "new", updated_at: "2026-07-20T00:00:00.000Z" });
    expect(pinsFromList([newer, older]).get(CWD)).toBe(newer);
    expect(pinsFromList([older, newer]).get(CWD)).toBe(newer);
  });
});

describe("pinFromHit", () => {
  // A pin keeps what the pinned row and the session view read, not the search
  // answer's matches or scan size.
  test("keeps the fields a pin reads from a search hit", () => {
    expect(
      pinFromHit(hit({ title: "Issue管理", model: "claude-fable-5[1m]", effort: "high" })),
    ).toEqual(pin({ title: "Issue管理", model: "claude-fable-5[1m]", effort: "high" }));
  });

  test("leaves model and effort out when the hit has none", () => {
    expect(pinFromHit(hit())).toEqual(pin());
  });

  // A pin belongs to a directory; a hit Session Search could not place in one
  // cannot be pinned.
  test("is null for a hit with no cwd", () => {
    expect(pinFromHit(hit({ cwd: null }))).toBeNull();
    expect(pinFromHit(hit({ cwd: "" }))).toBeNull();
  });
});

describe("pinnedRows", () => {
  const noAgents = new Map<string, AgentInfo>();

  test("a pin with no connected peer lists the record frozen at pin time", () => {
    const frozen = pin({ title: "凍結" });
    expect(pinnedRows(new Map([[CWD, frozen]]), [], noAgents)).toEqual([{ key: CWD, pin: frozen }]);
  });

  // Peers in other directories are not this pin's sessions.
  test("ignores peers outside the pinned directory", () => {
    const frozen = pin();
    const rows = pinnedRows(
      new Map([[CWD, frozen]]),
      [peer({ sid: "s9", cwd: "/repos/else" })],
      noAgents,
    );
    expect(rows).toEqual([{ key: CWD, pin: frozen }]);
  });

  test("a pin whose own session is connected lists its frozen record", () => {
    const frozen = pin({ title: "凍結" });
    expect(pinnedRows(new Map([[CWD, frozen]]), [peer()], noAgents)).toEqual([
      { key: CWD, pin: frozen },
    ]);
  });

  // The point of a directory pin: a new session in the pinned directory shows
  // up under the pin without being pinned itself.
  test("a successor session in the pinned directory replaces the frozen row", () => {
    const rows = pinnedRows(
      new Map([[CWD, pin({ sid: "retired" })]]),
      [peer({ sid: "s2" })],
      new Map([["s2", agent({ sessionId: "s2", name: "後継" })]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(CWD);
    expect(rows[0]?.pin).toMatchObject({ sid: "s2", cwd: CWD, title: "後継" });
  });

  // During a handover both sessions run in the directory; neither is dropped.
  test("lists every connected session of the directory, newest first", () => {
    const rows = pinnedRows(
      new Map([[CWD, pin()]]),
      [
        peer({ sid: "s1", last_activity_at: "2026-07-01T00:00:00.000Z" }),
        peer({ sid: "s2", last_activity_at: "2026-07-20T00:00:00.000Z" }),
      ],
      noAgents,
    );
    expect(rows.map((row) => [row.key, row.pin.sid])).toEqual([
      [CWD, "s2"],
      [CWD, "s1"],
    ]);
  });

  test("orders pins most recently updated first", () => {
    const rows = pinnedRows(
      new Map([
        [
          "/repos/old",
          pin({ sid: "a", cwd: "/repos/old", updated_at: "2026-07-01T00:00:00.000Z" }),
        ],
        [
          "/repos/new",
          pin({ sid: "b", cwd: "/repos/new", updated_at: "2026-07-20T00:00:00.000Z" }),
        ],
      ]),
      [],
      noAgents,
    );
    expect(rows.map((row) => row.key)).toEqual(["/repos/new", "/repos/old"]);
  });
});
