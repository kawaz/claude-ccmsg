// SessionView のセッション宛の入力欄 (SessionInputComposer) — 下書きの helpers.
//
// The component itself (Preact tree) is exercised through its pure helpers
// rather than a DOM render pass: `cleanupStaleDrafts` (mount-time sweep with
// two purge rules) and the save/load/clear draft trio (localStorage
// persistence). The send outcome handling lives in session-input.test.ts. A tiny in-memory `localStorage` polyfill lets the sweep run
// under bun test where `window.localStorage` isn't available.
import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import {
  cleanupStaleDrafts,
  clearDraft,
  DRAFT_STORAGE_PREFIX,
  formatSentAt,
  loadDraft,
  saveDraft,
} from "../src/client/components/SessionInputComposer.tsx";
import { initialState, type AppState } from "../src/client/store.ts";

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

/** `claude agents --json` の 1 行 (ccmsg 未起動セッション)。sweep が見るのは
 * sessionId だけなので他は最小の妥当値で埋める。 */
function makeAgent(sid: string): AgentInfo {
  return {
    pid: 1234,
    cwd: "/test",
    kind: "interactive",
    startedAt: Date.parse("2026-07-01T00:00:00Z"),
    sessionId: sid,
    config_dir: "/test/.claude",
  };
}

describe("draft save/load/clear", () => {
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
    localStorage.setItem(`${DRAFT_STORAGE_PREFIX}sid-corrupt`, "{not json");
    expect(loadDraft("sid-corrupt")).toBeNull();
    // Valid JSON but wrong shape
    localStorage.setItem(`${DRAFT_STORAGE_PREFIX}sid-badshape`, '{"foo":"bar"}');
    expect(loadDraft("sid-badshape")).toBeNull();
  });
});

describe("cleanupStaleDrafts (purge rules)", () => {
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
      `${DRAFT_STORAGE_PREFIX}sid-quiet`,
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
  // `ccmsg.since_seq`), and preserves a still-fresh draft even when its peer's
  // last_activity_at is missing (the safe-default path when neither peer
  // activity nor the draft is >10 days old).
  test("leaves unrelated keys and fresh drafts alone", () => {
    localStorage.setItem("ccmsg.since_seq", '{"r1":5}');
    saveDraft("sid-fresh", "keep me");

    const state: AppState = {
      ...initialState(),
      peers: [makePeer("sid-fresh")], // no last_activity_at, but the draft is fresh
    };
    cleanupStaleDrafts(state);

    expect(localStorage.getItem("ccmsg.since_seq")).toBe('{"r1":5}');
    expect(loadDraft("sid-fresh")?.text).toBe("keep me");
  });

  // 何を保証するか: ccmsg 未起動セッション (peers に居ないが `claude agents`
  // に居る = プロセスは生きている) 宛の下書きは (a) 規則で消さない。composer
  // をそのセッションでも出す以上、書いた下書きが次の mount で消えては困る。
  // 経過時間の判定は draft 自身の updatedAt に落ちるので、古い下書きは従来
  // どおり (b) 規則で消える。
  test("keeps drafts for agents-only sids, still purging stale ones", () => {
    saveDraft("sid-agent-fresh", "keep me");
    saveDraft("sid-agent-stale", "drop me");
    localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}sid-agent-stale`,
      JSON.stringify({ text: "drop me", updatedAt: "2026-07-01T00:00:00Z" }),
    );

    const state: AppState = {
      ...initialState(),
      peers: [],
      agents: [makeAgent("sid-agent-fresh"), makeAgent("sid-agent-stale")],
    };
    cleanupStaleDrafts(state, new Date("2026-07-20T00:00:00Z").getTime());

    expect(loadDraft("sid-agent-fresh")?.text).toBe("keep me");
    expect(loadDraft("sid-agent-stale")).toBeNull();
  });
});

describe("draft attachments round-trip (kawaz r17 mid=36)", () => {
  // 何を保証するか: upload 完了 (done) の添付メタが draft に保存・復元される。
  // 以前は text のみ保存で、close→reopen 後の送信で [FILE<N>] placeholder が
  // substitute 対象を失いリテラルのまま届いていた (実事故)。
  test("saveDraft persists done attachments and loadDraft restores them", () => {
    saveDraft("sid-att", "see [FILE1]", [
      { n: 1, name: "a.png", status: "done", progress: 100, path: "/tmp/a.png" },
    ]);
    const got = loadDraft("sid-att");
    expect(got?.attachments?.length).toBe(1);
    expect(got?.attachments?.[0]).toMatchObject({ n: 1, status: "done", path: "/tmp/a.png" });
  });

  // 何を保証するか: uploading / error の途中状態は保存されない (XHR は復元
  // 不能な transient)。done が 0 件なら attachments キー自体を書かない。
  test("saveDraft drops non-done attachments", () => {
    saveDraft("sid-up", "text [FILE1]", [
      { n: 1, name: "b.png", status: "uploading", progress: 40 },
    ]);
    expect(loadDraft("sid-up")?.attachments).toBeUndefined();
  });

  // 何を保証するか (壊れた record への degrade): attachments の shape が
  // 崩れていたら text だけの復元に落とす — 壊れた添付メタで送信経路を
  // 詰まらせない。
  test("loadDraft drops malformed attachments but keeps the text", () => {
    localStorage.setItem(
      "ccmsg.1on1.sid-bad",
      JSON.stringify({
        text: "hello [FILE1]",
        attachments: [{ n: "one", status: "done" }],
        updatedAt: new Date().toISOString(),
      }),
    );
    const got = loadDraft("sid-bad");
    expect(got?.text).toBe("hello [FILE1]");
    expect(got?.attachments).toBeUndefined();
  });
});

describe("draft unconfirmedAt (DR-0035 §5 送信済みかもしれない印)", () => {
  // 何を保証するか: unconfirmed に終わった送信の時刻が下書きと一緒に保存され、
  // リロード後の loadDraft で戻る (入力欄が「送信済みかもしれない」と示せる)。
  test("saveDraft persists unconfirmedAt and loadDraft restores it", () => {
    saveDraft("sid-u", "maybe sent", [], "2026-10-08T10:00:00.000Z");
    expect(loadDraft("sid-u")).toMatchObject({
      text: "maybe sent",
      unconfirmedAt: "2026-10-08T10:00:00.000Z",
    });
  });

  // 何を保証するか (対極): 印の無い保存では unconfirmedAt キー自体を書かない。
  // null を渡しても同じ (送り直して届かなかった等、印を外す経路)。
  test("saveDraft omits unconfirmedAt when absent or null", () => {
    saveDraft("sid-n", "plain");
    expect(loadDraft("sid-n")?.unconfirmedAt).toBeUndefined();
    saveDraft("sid-n", "plain", [], null);
    expect(loadDraft("sid-n")?.unconfirmedAt).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(`${DRAFT_STORAGE_PREFIX}sid-n`)!)).not.toHaveProperty(
      "unconfirmedAt",
    );
  });

  // 何を保証するか (壊れた record への degrade): 日時として読めない印は落とし、
  // 文は残す。文を失わせないことが印より優先。
  test("loadDraft drops a malformed unconfirmedAt but keeps the text", () => {
    localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}sid-bad-u`,
      JSON.stringify({ text: "keep", unconfirmedAt: "not a date", updatedAt: "t" }),
    );
    const got = loadDraft("sid-bad-u");
    expect(got?.text).toBe("keep");
    expect(got?.unconfirmedAt).toBeUndefined();
  });
});

describe("formatSentAt", () => {
  // 何を保証するか: 同じ日の送信は時:分だけ、日を跨いだら月/日を前に付ける
  // (注記の「(HH:MM の送信)」が別の日の送信を今日のものと誤読させない)。
  test("omits the date on the same day and adds it across days", () => {
    const sent = new Date(2026, 9, 8, 9, 5).toISOString();
    const sameDay = new Date(2026, 9, 8, 23, 0).getTime();
    const nextDay = new Date(2026, 9, 9, 1, 0).getTime();
    expect(formatSentAt(sent, sameDay)).not.toContain("10/8");
    expect(formatSentAt(sent, sameDay)).toMatch(/09.05|9.05/);
    expect(formatSentAt(sent, nextDay)).toMatch(/^10\/8 /);
  });
});
