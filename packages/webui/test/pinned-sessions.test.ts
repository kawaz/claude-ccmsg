// Pinned sessions' repo/ws rule (DR-0021 §2.4/§3.2). The sidebar's Pinned row
// used to print the stored pin's own repo/ws, which made one connected session
// render two different first lines at once: the full `repo@ws` in its status
// section (live PeerInfo) and whatever half pair the pin was frozen with above
// it. The reducer-side fold is exercised through `peers/loaded` in
// store.test.ts; these cover the two functions directly.
import { describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import {
  pinnedSessionLabel,
  pinnedSessionTitle,
  refreshPinsFromAgents,
  refreshPinsFromPeers,
} from "../src/client/pinned-sessions.ts";

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
        hit({ repo: null, ws: "wip-issue-board" }),
        peer({ ws: "wip-issue-board" }),
      ),
    ).toEqual({ repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("keeps the stored repo/ws when the pinned session has no live peer", () => {
    expect(pinnedSessionLabel(hit({ repo: "kawaz/pinned" }), undefined)).toEqual({
      repo: "kawaz/pinned",
      ws: "main",
    });
  });

  // A peer that announced neither (and whose cwd the daemon could not resolve)
  // must not blank out a pin that does know its repo/ws — "live first" is
  // decided on the pair, so an empty pair is not a source.
  test("keeps the stored repo/ws when the live peer has neither", () => {
    expect(pinnedSessionLabel(hit({ repo: "kawaz/pinned" }), peer({ repo: "", ws: "" }))).toEqual({
      repo: "kawaz/pinned",
      ws: "main",
    });
  });

  // Nothing is invented: with no live peer and a pin that stored neither, the
  // row keeps its own cwd-leaf fallback (SessionList) rather than getting a
  // substitute label from here.
  test("returns an empty pair when neither source has repo/ws", () => {
    expect(pinnedSessionLabel(hit({ repo: null, ws: null }), undefined)).toEqual({
      repo: "",
      ws: "",
    });
  });
});

describe("pinnedSessionTitle", () => {
  // What `/rename` set is reported by `claude agents --json` as `name`, and a
  // rename after the pin was made must win over the frozen record.
  test("prefers the live agent's name over the pin's stored title", () => {
    expect(pinnedSessionTitle(hit({ title: "古いタイトル" }), agent({ name: "新しい名前" }))).toBe(
      "新しい名前",
    );
  });

  test("falls back to the stored title when the session is not running", () => {
    expect(pinnedSessionTitle(hit({ title: "Issue管理" }), undefined)).toBe("Issue管理");
  });

  // A session that never renamed itself reports no name; that is not a reason
  // to drop a title Session Search recovered from the transcript.
  test("keeps the stored title when the live agent has no name", () => {
    expect(pinnedSessionTitle(hit({ title: "Issue管理" }), agent({ name: undefined }))).toBe(
      "Issue管理",
    );
  });

  // No stand-in is produced here — SessionList applies the row's own cwd-leaf
  // then short-sid fallback, the same tail sessionRowTitle uses.
  test("returns an empty string when neither source knows a title", () => {
    expect(pinnedSessionTitle(hit({ title: null }), agent({ name: undefined }))).toBe("");
  });
});

describe("refreshPinsFromAgents", () => {
  test("writes a renamed session's title back into its pin", () => {
    const stored = hit({ title: "古いタイトル" });
    const pins = new Map([["s1", stored]]);
    const next = refreshPinsFromAgents(pins, [agent({ name: "新しい名前" })]);
    expect(next.get("s1")).toEqual({ ...stored, title: "新しい名前" });
  });

  test("returns the same Map when the pin's title already matches", () => {
    const pins = new Map([["s1", hit({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ name: "Issue管理" })])).toBe(pins);
  });

  test("does not blank a stored title from an agent that has no name", () => {
    const pins = new Map([["s1", hit({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ name: undefined })])).toBe(pins);
  });

  test("fills a pin that stored no title at all", () => {
    const pins = new Map([["s1", hit({ title: null })]]);
    expect(refreshPinsFromAgents(pins, [agent()])?.get("s1")?.title).toBe("Issue管理");
  });

  test("ignores agents whose session is not pinned, and never mutates its input", () => {
    const pins = new Map([["s1", hit({ title: "Issue管理" })]]);
    expect(refreshPinsFromAgents(pins, [agent({ sessionId: "s2", name: "別物" })])).toBe(pins);
    expect(pins.get("s1")?.title).toBe("Issue管理");
  });
});

describe("refreshPinsFromPeers", () => {
  test("replaces a stale pin's repo/ws as one pair, leaving its other fields", () => {
    const stale = hit({ repo: null, ws: "wip-issue-board", title: "Issue管理", size: 4242 });
    const pins = new Map([["s1", stale]]);
    const next = refreshPinsFromPeers(pins, [peer({ ws: "wip-issue-board" })]);
    expect(next.get("s1")).toEqual({ ...stale, repo: "kawaz/claude-ccmsg", ws: "wip-issue-board" });
  });

  test("returns the same Map when every pin already agrees with its peer", () => {
    const pins = new Map([["s1", hit()]]);
    expect(refreshPinsFromPeers(pins, [peer()])).toBe(pins);
  });

  test("returns the same Map when there are no pins at all", () => {
    const pins = new Map<string, SessionSearchHit>();
    expect(refreshPinsFromPeers(pins, [peer()])).toBe(pins);
  });

  test("never mutates the Map it was given", () => {
    const pins = new Map([["s1", hit({ repo: null })]]);
    refreshPinsFromPeers(pins, [peer()]);
    expect(pins.get("s1")?.repo).toBeNull();
  });

  // One peers push can carry several sessions; each pinned sid it names is
  // repaired in the single copy that push produces.
  test("repairs every pinned sid the peers list names", () => {
    const pins = new Map([
      ["s1", hit({ repo: null })],
      ["s2", hit({ sid: "s2", repo: null, ws: "wip" })],
      ["s3", hit({ sid: "s3" })],
    ]);
    const next = refreshPinsFromPeers(pins, [
      peer(),
      peer({ sid: "s2", repo: "kawaz/other", ws: "wip" }),
    ]);
    expect(next.get("s1")?.repo).toBe("kawaz/claude-ccmsg");
    expect(next.get("s2")?.repo).toBe("kawaz/other");
    expect(next.get("s3")).toEqual(hit({ sid: "s3" }));
  });
});
