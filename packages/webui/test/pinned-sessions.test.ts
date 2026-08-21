// Pinned sessions' repo/ws rule (DR-0021 §2.4/§3.2). The sidebar's Pinned row
// used to print the stored pin's own repo/ws, which made one connected session
// render two different first lines at once: the full `repo@ws` in its status
// section (live PeerInfo) and whatever half pair the pin was frozen with above
// it. The reducer-side fold is exercised through `peers/loaded` in
// store.test.ts; these cover the two functions directly.
import { describe, expect, test } from "bun:test";
import type { PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import { pinnedSessionLabel, refreshPinsFromPeers } from "../src/client/pinned-sessions.ts";

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
