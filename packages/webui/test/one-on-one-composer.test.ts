// DR-0014 §2.6 1on1 floating composer — reducer-adjacent helpers.
//
// The component itself (React-like Preact tree) is exercised through its
// pure helpers rather than a DOM render pass: `findExistingOneOnOne` (§2.2
// kind-based lookup), `cleanupStaleDrafts` (§2.6 mount-time sweep with two
// purge rules), and the save/load/clear draft trio (§2.6 localStorage
// persistence). A tiny in-memory `localStorage` polyfill lets the sweep run
// under bun test where `window.localStorage` isn't available.
import { beforeEach, describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  cleanupStaleDrafts,
  clearDraft,
  findExistingOneOnOne,
  loadDraft,
  LOCAL_STORAGE_PREFIX,
  saveDraft,
} from "../src/client/components/OneOnOneComposer.tsx";
import { initialState, type AppState, type RoomState } from "../src/client/store.ts";

// Minimal in-memory localStorage shim. Bun runs each test file in its own
// module scope, but `localStorage` is a browser global — the composer's
// helpers read it directly, so we hang a compatible object off `globalThis`
// before each test. Deliberately minimal: only the methods the helpers call.
class MemStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

function makePeer(sid: string, opts: { lastActivityAt?: string; repo?: string } = {}): PeerInfo {
  return {
    sid,
    repo: opts.repo ?? "test-repo",
    ws: "test-ws",
    cwd: "/test",
    ...(opts.lastActivityAt ? { last_activity_at: opts.lastActivityAt } : {}),
  };
}

function makeRoomState(overrides: Partial<RoomState> & { id: string }): RoomState {
  return {
    id: overrides.id,
    title: overrides.title,
    membersById: overrides.membersById ?? new Map(),
    memberOrder: overrides.memberOrder ?? [],
    msgs: overrides.msgs ?? new Map(),
    timeline: overrides.timeline ?? [],
    lastMid: overrides.lastMid ?? 0,
    lastTs: overrides.lastTs ?? null,
    archived: overrides.archived,
    kind: overrides.kind ?? "normal",
  };
}

describe("DR-0014 1on1 draft save/load/clear", () => {
  // 何を保証するか (§2.6 「入力中メッセージは localStorage に保存」): a
  // saved draft is retrievable verbatim by sid — the trip through
  // JSON.stringify/parse preserves both text and updatedAt shape.
  test("saveDraft + loadDraft round-trip preserves text and timestamp shape", () => {
    saveDraft("sid-abcdefgh12345", "hello there");
    const restored = loadDraft("sid-abcdefgh12345");
    expect(restored).not.toBeNull();
    expect(restored?.text).toBe("hello there");
    expect(typeof restored?.updatedAt).toBe("string");
    // updatedAt is a valid ISO string
    expect(Number.isFinite(Date.parse(restored!.updatedAt))).toBe(true);
  });

  // 何を保証するか (§2.6 「送信時は当然ローカルストレージは消す」): clearing
  // an existing draft removes it; loading a cleared draft returns null; a
  // clearDraft on a never-saved sid is a no-op (safe idempotency).
  test("clearDraft removes the entry; a fresh loadDraft returns null", () => {
    saveDraft("sid-A", "draft");
    clearDraft("sid-A");
    expect(loadDraft("sid-A")).toBeNull();
    // Idempotent — safe to call for a sid that never had a draft.
    clearDraft("sid-never-existed");
    expect(loadDraft("sid-never-existed")).toBeNull();
  });

  // 何を保証するか (loadDraft の malformed 耐性): a corrupted localStorage
  // value (someone tampered with it, or a schema drift) returns null instead
  // of crashing the composer on open. Regression guard for the try/catch
  // path in loadDraft.
  test("loadDraft returns null for malformed JSON without throwing", () => {
    // Bypass saveDraft to plant a raw value
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}sid-corrupt`, "{not json");
    expect(loadDraft("sid-corrupt")).toBeNull();
    // Valid JSON but wrong shape
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}sid-badshape`, '{"foo":"bar"}');
    expect(loadDraft("sid-badshape")).toBeNull();
  });
});

describe("DR-0014 1on1 cleanupStaleDrafts (§2.6 purge rules)", () => {
  // 何を保証するか (§2.6 (a) 「対応するセッションが無ければ消す」): a draft
  // whose sid isn't in the peers list gets swept — the target can't receive
  // it. Regression guard for the (a) branch of the mount-time sweep.
  test("removes drafts for sids no longer in peers", () => {
    saveDraft("sid-gone", "orphan draft");
    saveDraft("sid-still-here", "active draft");

    const state: AppState = {
      ...initialState(),
      peers: [makePeer("sid-still-here")],
    };
    cleanupStaleDrafts(state);

    expect(loadDraft("sid-gone")).toBeNull();
    expect(loadDraft("sid-still-here")?.text).toBe("active draft");
  });

  // 何を保証するか (§2.6 (b) 「10日以上非アクティブなセッション」): a peer
  // that's still connected but idle for >10 days has its draft swept. The
  // sweep prefers peers.last_activity_at as the freshness signal.
  test("removes drafts for peers idle >10 days (using peer last_activity_at)", () => {
    saveDraft("sid-stale", "old draft");
    saveDraft("sid-fresh", "new draft");

    const now = new Date("2026-07-14T00:00:00Z").getTime();
    const staleActivity = new Date(now - 11 * 24 * 60 * 60 * 1000).toISOString();
    const freshActivity = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    const state: AppState = {
      ...initialState(),
      peers: [
        makePeer("sid-stale", { lastActivityAt: staleActivity }),
        makePeer("sid-fresh", { lastActivityAt: freshActivity }),
      ],
    };
    cleanupStaleDrafts(state, now);

    expect(loadDraft("sid-stale")).toBeNull();
    expect(loadDraft("sid-fresh")?.text).toBe("new draft");
  });

  // 何を保証するか (fallback path): when a peer has no last_activity_at (older
  // daemon / freshly-connected session), the sweep uses the draft's own
  // updatedAt as the freshness proxy. A draft written >10 days ago against
  // such a peer is still swept — otherwise silent staleness accumulates.
  test("falls back to draft updatedAt when peer has no last_activity_at", () => {
    // Plant a draft directly with an old updatedAt (bypass saveDraft's "now"
    // stamp so we can control the age).
    const oldStamp = new Date("2026-06-01T00:00:00Z").toISOString();
    localStorage.setItem(
      `${LOCAL_STORAGE_PREFIX}sid-quiet`,
      JSON.stringify({ text: "old draft", updatedAt: oldStamp }),
    );

    const state: AppState = {
      ...initialState(),
      peers: [makePeer("sid-quiet")], // no last_activity_at
    };
    // "now" is > 10 days after oldStamp
    cleanupStaleDrafts(state, new Date("2026-07-14T00:00:00Z").getTime());

    expect(loadDraft("sid-quiet")).toBeNull();
  });

  // 何を保証するか (対極 — 誤爆防止): the sweep leaves alone localStorage
  // keys that don't carry the ccmsg.1on1. prefix (other webui state like
  // `ccmsg.since`), and preserves a still-fresh draft even when its peer's
  // last_activity_at is missing (the safe-default path when neither peer
  // activity nor the draft is >10 days old).
  test("leaves unrelated keys and fresh drafts alone", () => {
    localStorage.setItem("ccmsg.since", '{"r1":5}');
    saveDraft("sid-fresh", "keep me");

    const state: AppState = {
      ...initialState(),
      peers: [makePeer("sid-fresh")], // no last_activity_at, but the draft is fresh
    };
    cleanupStaleDrafts(state);

    expect(localStorage.getItem("ccmsg.since")).toBe('{"r1":5}');
    expect(loadDraft("sid-fresh")?.text).toBe("keep me");
  });
});

describe("DR-0014 findExistingOneOnOne (§2.2 kind-based lookup)", () => {
  // 何を保証するか (§2.2 「判別は kind フィールドで行う」): the lookup
  // matches by room.kind === "1on1" AND its single non-u1 member sid. A
  // room whose title merely contains "1on1" but has kind "normal" is NOT
  // treated as a 1on1 (§2.1 「title 文字列一致は typo に弱い」).
  test("matches only by kind:'1on1' + sole member sid, not by title", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "normal",
            title: "misleading 1on1 title",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "repo-a",
                  ws: "ws",
                  cwd: "/cwd",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
        [
          "r2",
          makeRoomState({
            id: "r2",
            kind: "1on1",
            title: "repo-a 1on1 sid-A",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "repo-a",
                  ws: "ws",
                  cwd: "/cwd",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    const found = findExistingOneOnOne(state, "sid-A");
    expect(found?.id).toBe("r2");
  });

  // 何を保証するか (§2.1 dedup: 対象 sid の 1on1 が無ければ null): a broadcast
  // that happens to contain the sid as a member does NOT count — auto-create
  // would spin up a fresh 1on1 in that case.
  test("returns null when no kind:'1on1' room has the target sid as its sole member", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "broadcast",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "r",
                  ws: "w",
                  cwd: "/",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    expect(findExistingOneOnOne(state, "sid-A")).toBeNull();
  });

  // 何を保証するか (left member skip): a member who has left the 1on1 room
  // (kicked, or voluntarily left — unusual for 1on1 but possible) doesn't
  // match, so a fresh compose against that sid would auto-create a new
  // 1on1 room rather than resurrecting the dead one.
  test("skips rooms where the sole member has left", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "1on1",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "r",
                  ws: "w",
                  cwd: "/",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: true,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    expect(findExistingOneOnOne(state, "sid-A")).toBeNull();
  });
});
