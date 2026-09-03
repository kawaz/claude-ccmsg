// The sidebar's "前回稼働中" section (issue 2026-08-25-restart-recovery-last-
// live-sessions): what a row shows, what it asks the launcher for, and how the
// list is folded into the store. Membership itself is the daemon's decision —
// these cover only the rules the webui owns.
import { describe, expect, test } from "bun:test";
import type { LastLiveSession, PeerInfo } from "@ccmsg/protocol";
import {
  lastLiveForkPrefill,
  lastLiveResumePrefill,
  lastLiveSessionTitle,
  sortLastLiveSessions,
  visibleLastLiveSessions,
} from "../src/client/last-live-sessions.ts";
import { initialState, reducer } from "../src/client/store.ts";

function entry(over: Partial<LastLiveSession> = {}): LastLiveSession {
  return {
    sid: "s1",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
    last_seen_at: "2026-08-25T10:00:00.000Z",
    ...over,
  };
}

function peer(over: Partial<PeerInfo> = {}): PeerInfo {
  return { sid: "s1", repo: "r", ws: "w", cwd: "/tmp", ...over };
}

describe("visibleLastLiveSessions", () => {
  test("接続中の sid は出さない (resume すると二重起動になる)", () => {
    const rows = visibleLastLiveSessions([entry({ sid: "s1" }), entry({ sid: "s2" })], [peer()]);
    expect(rows.map((e) => e.sid)).toEqual(["s2"]);
  });

  test("peers に居ない entry はそのまま残る", () => {
    expect(visibleLastLiveSessions([entry()], [peer({ sid: "other" })])).toHaveLength(1);
  });
});

describe("sortLastLiveSessions", () => {
  test("最終確認が新しい順、同時刻は sid 順", () => {
    const rows = sortLastLiveSessions([
      entry({ sid: "old", last_seen_at: "2026-08-25T09:00:00.000Z" }),
      entry({ sid: "b", last_seen_at: "2026-08-25T10:00:00.000Z" }),
      entry({ sid: "a", last_seen_at: "2026-08-25T10:00:00.000Z" }),
    ]);
    expect(rows.map((e) => e.sid)).toEqual(["a", "b", "old"]);
  });
});

describe("lastLiveSessionTitle", () => {
  test("daemon が記録したタイトルがあればそれ", () => {
    expect(lastLiveSessionTitle(entry({ title: "restart recovery" }))).toBe("restart recovery");
  });

  test("無ければ cwd の末尾 (他のセッション行と同じ退避先)", () => {
    expect(lastLiveSessionTitle(entry())).toBe("main");
  });

  // The daemon never records an entry with an empty cwd (it is one of the
  // three fields a record must have to be kept), so this is the defensive
  // tail: whatever arrives, the title line is never blank.
  test("cwd も手掛かりにならなければ短縮 sid で、行は空にしない", () => {
    expect(lastLiveSessionTitle(entry({ sid: "0123456789abcdef", cwd: "" }))).toBe("01234567");
  });
});

describe("lastLiveResumePrefill", () => {
  test("Session Search の resume と同じ形で launcher に渡す", () => {
    expect(
      lastLiveResumePrefill(
        entry({ model: "claude-opus-5", effort: "high", title: "restart recovery" }),
      ),
    ).toEqual({
      kind: "resume",
      cwd: "/repos/claude-ccmsg/main",
      sessionId: "s1",
      model: "claude-opus-5",
      effort: "high",
      title: "restart recovery",
    });
  });

  test("model/effort/title が分からない時は渡さない (form の既定を上書きしない)", () => {
    const prefill = lastLiveResumePrefill(entry());
    expect(prefill).toEqual({ kind: "resume", cwd: "/repos/claude-ccmsg/main", sessionId: "s1" });
    expect("model" in prefill).toBe(false);
    expect("title" in prefill).toBe(false);
  });
});

describe("lastLiveForkPrefill", () => {
  test("resume と同じ情報を fork レシピ向けに渡す", () => {
    expect(
      lastLiveForkPrefill(
        entry({ model: "claude-opus-5", effort: "high", title: "restart recovery" }),
      ),
    ).toEqual({
      kind: "fork",
      sessionId: "s1",
      // 行はどのレコードから分岐するかを知らない (それを選ぶのは Timeline)。
      // 空のまま渡して、必要なら form で uuid を貼れる状態にする。
      resumeAt: "",
      cwd: "/repos/claude-ccmsg/main",
      model: "claude-opus-5",
      effort: "high",
      title: "restart recovery",
    });
  });

  test("model/effort/title が分からない時は渡さない (form の既定を上書きしない)", () => {
    const prefill = lastLiveForkPrefill(entry());
    expect(prefill).toEqual({
      kind: "fork",
      sessionId: "s1",
      resumeAt: "",
      cwd: "/repos/claude-ccmsg/main",
    });
    expect("model" in prefill).toBe(false);
  });

  // 同じ行の 2 つのボタンは同じセッションを指す — 片方だけ sid の出所が
  // ずれていたら、押したボタンで別セッションが起動することになる。
  test("resume 導線と同じ sid を指す", () => {
    const row = entry({ sid: "same-session" });
    expect(lastLiveForkPrefill(row).sessionId).toBe(lastLiveResumePrefill(row).sessionId);
  });
});

describe("reducer / peers/loaded の last_live", () => {
  test("peers と同じ action で入る", () => {
    const state = reducer(initialState(), {
      type: "peers/loaded",
      peers: [],
      lastLive: [entry()],
    });
    expect(state.lastLiveSessions.map((e) => e.sid)).toEqual(["s1"]);
  });

  test("last_live を伴わない frame は空にする (全部復旧した / 古い daemon)", () => {
    const withList = reducer(initialState(), {
      type: "peers/loaded",
      peers: [],
      lastLive: [entry()],
    });
    const after = reducer(withList, { type: "peers/loaded", peers: [peer()] });
    expect(after.lastLiveSessions).toEqual([]);
  });
});
