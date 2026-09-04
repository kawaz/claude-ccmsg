// The sidebar's "前回稼働中" section (issue 2026-08-25-restart-recovery-last-
// live-sessions): what a row shows, what it asks the launcher for, and how the
// list is folded into the store. Membership itself is the daemon's decision —
// these cover only the rules the webui owns.
import { describe, expect, test } from "bun:test";
import type { LastLiveSession, PeerInfo } from "@ccmsg/protocol";
import {
  lastLiveRemoveAction,
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

describe("lastLiveRemoveAction", () => {
  test("既定 (Shift なし) は確認を挟み、✕ のまま", () => {
    const action = lastLiveRemoveAction(entry({ title: "restart recovery" }), false);
    expect(action.mark).toBe("✕");
    expect(action.confirm).toContain("restart recovery");
  });

  // 確認文はどの行を消すのかを言えないと意味がない。タイトルが無い行でも
  // 行に見えている文字 (cwd 末尾 / 短縮 sid) と同じものが出る。
  test("確認文は行に見えているタイトルで対象を名指しする", () => {
    expect(lastLiveRemoveAction(entry(), false).confirm).toContain("main");
  });

  test("Shift 押下中は確認なしで、字も ❌ に変わる", () => {
    expect(lastLiveRemoveAction(entry(), true)).toEqual({ mark: "❌", confirm: null });
  });

  // 見た目と挙動が同じ判断から出ていること自体が仕様: ❌ が出ているのに
  // 確認が挟まる (逆もまた) 組み合わせは存在しない。
  test("❌ を出す時は必ず確認なし、✕ を出す時は必ず確認あり", () => {
    for (const shift of [true, false]) {
      const { mark, confirm } = lastLiveRemoveAction(entry(), shift);
      expect(mark === "❌").toBe(confirm === null);
    }
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
