// セッション宛の入力欄の保存領域 (session-input-store.ts): 下書きの読み書き・
// sweep と、送信の記録 (DR-0035 §5)。部品 (SessionInputComposer) はこの領域を
// 映すだけなので、送信の境界 (unmount 後の応答、送信中のリロード、別タブの
// 下書き、再送、無応答の期限切れ、A→B の置き換え) はここで固定する。返事の
// 分類と文言は session-input.test.ts。 A tiny in-memory `localStorage` polyfill lets the sweep run
// under bun test where `window.localStorage` isn't available.
import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import type { ErrorResponse, SessionInputResponse } from "@ccmsg/protocol";
import {
  beginSend,
  cleanupStaleSessionInputs,
  clearDraft,
  discardSend,
  DRAFT_ATTACHMENTS_STORAGE_PREFIX,
  DRAFT_STORAGE_PREFIX,
  LEGACY_DRAFT_STORAGE_PREFIX,
  finishSend,
  isSending,
  lastFailure,
  loadDraft,
  loadSends,
  resetSessionInputPageState,
  sameContent,
  saveDraft,
  sendSessionInput,
  SENDS_STORAGE_PREFIX,
  storedDraftChange,
  subscribeSessionInput,
  unconfirmedSends,
} from "../src/client/components/session-input-store.ts";
import { initialState, type AppState } from "../src/client/store.ts";
import { defined } from "./helpers.ts";

// Minimal in-memory localStorage shim. Bun runs each test file in its own
// module scope, but `localStorage` is a browser global — the composer's
// helpers read it directly, so we hang a compatible object off `globalThis`
// before each test. Deliberately minimal: only the methods the helpers call.
class MemStorage {
  private data = new Map<string, string>();
  /** Keys whose writes fail, as a full storage's do (quota). */
  failingWrites = new Set<string>();
  /** setItem / removeItem calls so far. */
  writes = 0;
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
    this.writes += 1;
    if (this.failingWrites.has(k)) throw new Error("QuotaExceededError");
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.writes += 1;
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

let storage = new MemStorage();

beforeEach(() => {
  storage = new MemStorage();
  globalThis.localStorage = storage;
  resetSessionInputPageState();
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
    expect(Number.isFinite(Date.parse(defined(restored, "the restored draft").updatedAt))).toBe(
      true,
    );
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

describe("cleanupStaleSessionInputs (purge rules)", () => {
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
    cleanupStaleSessionInputs(state);

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
    cleanupStaleSessionInputs(state, now);

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
    cleanupStaleSessionInputs(state, new Date("2026-07-14T00:00:00Z").getTime());

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
    cleanupStaleSessionInputs(state);

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
    cleanupStaleSessionInputs(state, new Date("2026-07-20T00:00:00Z").getTime());

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

  // 何を保証するか: 添付の書き込みだけが失敗 (quota) しても、前の添付が新しい
  // 本文に結び付かない (送信時に古いファイルで [FILE<N>] が置き換わらない)。
  // 添付は保存した本文と同じ updatedAt を持つ時だけ採る。
  test("attachments a failed write left behind are not joined to a newer text", () => {
    const a = { n: 1, name: "a.png", status: "done", progress: 100, path: "/tmp/a.png" } as const;
    const b = { n: 1, name: "b.png", status: "done", progress: 100, path: "/tmp/b.png" } as const;
    saveDraft("sid-q", "first [FILE1]", [a]);
    storage.failingWrites.add(`${DRAFT_ATTACHMENTS_STORAGE_PREFIX}sid-q`);
    saveDraft("sid-q", "second [FILE1]", [b]);
    const got = loadDraft("sid-q");
    expect(got?.text).toBe("second [FILE1]");
    expect(got?.attachments).toBeUndefined();
  });

  // 何を保証するか (DR-0035 §5): 添付は本文と別のキーにあるので、添付の形が
  // 読めなくても人が書いた本文は残る (添付だけ無いものとして扱う)。
  test("attachments that do not read leave the text of the draft", () => {
    saveDraft("sid-bad", "hello [FILE1]");
    localStorage.setItem(
      `${DRAFT_ATTACHMENTS_STORAGE_PREFIX}sid-bad`,
      JSON.stringify([{ n: "one", status: "done" }]),
    );
    const got = loadDraft("sid-bad");
    expect(got?.text).toBe("hello [FILE1]");
    expect(got?.attachments).toBeUndefined();
  });
});

// 本文と添付を 1 つの値 (`ccmsg.1on1.<sid>`) に持っていた頃の下書きの移行
// (1 回限り): 読めれば今のキーへ分けて保存し直し、読めなければ捨てる。旧キーは
// どちらでも消える。
describe("drafts stored before the split", () => {
  const attachment = { n: 1, name: "a.png", status: "done", progress: 100, path: "/tmp/a.png" };

  test("a stored draft that reads moves to the text and attachments keys", () => {
    localStorage.setItem(
      `${LEGACY_DRAFT_STORAGE_PREFIX}sid-old`,
      JSON.stringify({
        text: "old [FILE1]",
        attachments: [attachment],
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(loadDraft("sid-old")).toMatchObject({
      text: "old [FILE1]",
      updatedAt: "2026-10-01T00:00:00.000Z",
      attachments: [{ n: 1, path: "/tmp/a.png" }],
    });
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-old`)).toBeNull();
    expect(localStorage.getItem(`${DRAFT_STORAGE_PREFIX}sid-old`)).not.toBeNull();
  });

  test("a stored draft that does not read is dropped", () => {
    localStorage.setItem(
      `${LEGACY_DRAFT_STORAGE_PREFIX}sid-broken`,
      JSON.stringify({
        text: "x",
        attachments: [{ n: "one" }],
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(loadDraft("sid-broken")).toBeNull();
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-broken`)).toBeNull();
  });

  // 新キーに読めない値があっても、それは下書きではない: 読める旧本文を捨てずに
  // 移す (新キーが優先されるのはスキーマで読めた時だけ)。
  test("a new key that does not read does not win over a stored draft that reads", () => {
    localStorage.setItem(`${DRAFT_STORAGE_PREFIX}sid-mixed`, "{not json");
    localStorage.setItem(
      `${LEGACY_DRAFT_STORAGE_PREFIX}sid-mixed`,
      JSON.stringify({ text: "old text", updatedAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(loadDraft("sid-mixed")?.text).toBe("old text");
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-mixed`)).toBeNull();
    expect(loadDraft("sid-mixed")?.text).toBe("old text");
  });

  // 新キーへ書けなかった (quota) 移行は旧キーを消さない: 旧本文は残り、読めば
  // それが返り、次に読む時にもう一度移す。
  test("a move whose write fails keeps the stored draft", () => {
    localStorage.setItem(
      `${LEGACY_DRAFT_STORAGE_PREFIX}sid-full`,
      JSON.stringify({ text: "old text", updatedAt: "2026-10-01T00:00:00.000Z" }),
    );
    storage.failingWrites.add(`${DRAFT_STORAGE_PREFIX}sid-full`);
    expect(loadDraft("sid-full")?.text).toBe("old text");
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-full`)).not.toBeNull();
    storage.failingWrites.clear();
    expect(loadDraft("sid-full")?.text).toBe("old text");
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-full`)).toBeNull();
  });

  test("the mount-time sweep moves every stored draft, opened or not", () => {
    localStorage.setItem(
      `${LEGACY_DRAFT_STORAGE_PREFIX}sid-here`,
      JSON.stringify({ text: "kept", updatedAt: new Date().toISOString() }),
    );
    cleanupStaleSessionInputs({ ...initialState(), peers: [makePeer("sid-here")] });
    expect(localStorage.getItem(`${LEGACY_DRAFT_STORAGE_PREFIX}sid-here`)).toBeNull();
    expect(loadDraft("sid-here")?.text).toBe("kept");
  });
});

describe("saveDraft writes only on a change", () => {
  // 何を保証するか: 保存済みと同じ中身は書き直さない。別タブの下書きを
  // storage event で映した部品が同じ値を書き戻し、タブ同士で event を撒き合う
  // のを防ぐ (updatedAt が変わらないことで観測する)。
  test("leaves an identical draft untouched", () => {
    localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}sid-same`,
      JSON.stringify({ text: "same", updatedAt: "2026-10-01T00:00:00.000Z" }),
    );
    saveDraft("sid-same", "same", []);
    expect(loadDraft("sid-same")?.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    saveDraft("sid-same", "changed", []);
    expect(loadDraft("sid-same")?.text).toBe("changed");
  });

  // 何を保証するか: 空の本文は下書きを消す (空の下書きを残さない)。
  test("clears the draft for an empty text", () => {
    saveDraft("sid-empty", "x");
    saveDraft("sid-empty", "");
    expect(loadDraft("sid-empty")).toBeNull();
  });
});

describe("a draft another tab wrote (DR-0035 §5)", () => {
  // 何を保証するか: 入力欄に映す下書きを読むだけで、保存領域に書かない。
  // 映したタブが保存し直すと、その保存は入力しているタブの次の保存より後に
  // 走りうり、古い文が storage event で入力しているタブへ戻る (片方のタブで
  // 打っているだけで文字が消えて戻る)。
  test("reading the draft to show writes nothing", () => {
    saveDraft("sid-tab", "from the other tab", []);
    let before = storage.writes;
    expect(storedDraftChange("sid-tab", { text: "" })?.text).toBe("from the other tab");
    expect(storage.writes).toBe(before);
    clearDraft("sid-tab");
    before = storage.writes;
    expect(storedDraftChange("sid-tab", { text: "shown" })).toEqual({ text: "" });
    expect(storage.writes).toBe(before);
  });

  // 何を保証するか: 入力欄が既に映している中身なら何も返さない (入力中の
  // state を作り直さない)。
  test("nothing to show when the input already shows the draft", () => {
    saveDraft("sid-tab", "same", []);
    expect(storedDraftChange("sid-tab", { text: "same", attachments: [] })).toBeNull();
    expect(storedDraftChange("sid-other", { text: "" })).toBeNull();
  });

  // 何を保証するか: 片方のタブだけで打つ間、もう片方が遅れて映しても (背景
  // タブで render が遅れる)、保存領域は打っているタブの最新の文のまま。
  test("a tab that only shows the other tab's typing never moves the draft back", () => {
    let shown = "";
    const show = () => {
      shown = storedDraftChange("sid-tab", { text: shown })?.text ?? shown;
    };
    saveDraft("sid-tab", "a", []);
    saveDraft("sid-tab", "ab", []);
    show();
    saveDraft("sid-tab", "abc", []);
    expect(loadDraft("sid-tab")?.text).toBe("abc");
    show();
    expect(shown).toBe("abc");
    expect(loadDraft("sid-tab")?.text).toBe("abc");
  });
});

describe("sameContent", () => {
  const done = (n: number, path: string) =>
    ({ n, name: `f${n}`, status: "done", progress: 100, path }) as const;

  // 何を保証するか: 本文と upload 済み添付 (番号と path) で比べ、upload 中の
  // 添付 (送られない) は比べない。
  test("compares text and done attachments only", () => {
    expect(
      sameContent(
        { text: "a", attachments: [done(1, "/p")] },
        { text: "a", attachments: [done(1, "/p")] },
      ),
    ).toBe(true);
    expect(sameContent({ text: "a" }, { text: "b" })).toBe(false);
    expect(
      sameContent(
        { text: "a", attachments: [done(1, "/p")] },
        { text: "a", attachments: [done(1, "/q")] },
      ),
    ).toBe(false);
    expect(
      sameContent(
        { text: "a" },
        { text: "a", attachments: [{ n: 2, name: "u", status: "uploading", progress: 10 }] },
      ),
    ).toBe(true);
    expect(sameContent(null, { text: "a" })).toBe(false);
  });
});

/** daemon への依頼の代わり。resolve を外から呼んで返事の時機を決める。 */
function deferredRequest() {
  let resolve!: (r: SessionInputResponse | ErrorResponse) => void;
  let sent: string | null = null;
  const request = (text: string) => {
    sent = text;
    return new Promise<SessionInputResponse | ErrorResponse>((r) => {
      resolve = r;
    });
  };
  return {
    request,
    reply: (r: SessionInputResponse | ErrorResponse) => resolve(r),
    sentText: () => sent,
  };
}

describe("send records (DR-0035 §5)", () => {
  // 何を保証するか (指摘 1): 送信の記録は ws に送る前に書かれる。依頼が
  // 出た時点で既に記録があるので、返事の前にページが消えても印は残る。
  test("writes the record before the request goes out", async () => {
    saveDraft("sid-1", "hello");
    let recordsAtRequest: readonly unknown[] = [];
    const done = sendSessionInput("sid-1", { text: "hello" }, "hello", async () => {
      recordsAtRequest = loadSends("sid-1");
      return { ok: true, outcome: "unconfirmed" };
    });
    await done;
    expect(recordsAtRequest).toHaveLength(1);
    expect(recordsAtRequest[0]).toMatchObject({ text: "hello", state: "sending" });
  });

  // 何を保証するか (指摘 1): 送信中にページが消えた (= このページの待ち状態が
  // 失われた) 後に読むと、送信中の記録は未確認として見える。
  test("a sending record left by a vanished page shows as unconfirmed", () => {
    saveDraft("sid-2", "lost reply");
    const record = beginSend("sid-2", { text: "lost reply" });
    expect(isSending("sid-2")).toBe(true);
    expect(unconfirmedSends(loadSends("sid-2"))).toHaveLength(0);
    resetSessionInputPageState(); // リロード
    expect(isSending("sid-2")).toBe(false);
    expect(unconfirmedSends(loadSends("sid-2")).map((r) => r.id)).toEqual([record.id]);
    expect(loadDraft("sid-2")?.text).toBe("lost reply");
  });

  // 何を保証するか: accepted は記録を消し、下書きが送った文のままなら消す。
  test("accepted clears the record and the unchanged draft", async () => {
    saveDraft("sid-3", "send me");
    const outcome = await sendSessionInput("sid-3", { text: "send me" }, "send me", async () => ({
      ok: true,
      outcome: "accepted",
    }));
    expect(outcome.kind).toBe("accepted");
    expect(loadSends("sid-3")).toEqual([]);
    expect(loadDraft("sid-3")).toBeNull();
    expect(isSending("sid-3")).toBe(false);
  });

  // 何を保証するか (指摘 3): 返事を待つ間に別タブ (または unmount 後に戻った
  // 部品) が新しい下書きを書いたら、古い送信の accepted はそれを消さない。
  // 部品が居なくても応答は保存領域に対して処理される。
  test("accepted keeps a draft written after the send (other tab / remount)", async () => {
    saveDraft("sid-4", "A");
    const d = deferredRequest();
    const pending = sendSessionInput("sid-4", { text: "A" }, "A", d.request);
    saveDraft("sid-4", "B written meanwhile");
    d.reply({ ok: true, outcome: "accepted" });
    await pending;
    expect(loadDraft("sid-4")?.text).toBe("B written meanwhile");
    expect(loadSends("sid-4")).toEqual([]);
  });

  // 何を保証するか (指摘 5): 未確認の送信 A の後に送り直して届かなかった時、
  // A の未確認の記録は残り、失敗は別に持たれる (失敗の表示が未確認を隠さない)。
  test("a failed resend keeps the earlier unconfirmed record", async () => {
    saveDraft("sid-5", "A");
    await sendSessionInput("sid-5", { text: "A" }, "A", async () => ({
      ok: true,
      outcome: "unconfirmed",
    }));
    await sendSessionInput("sid-5", { text: "A" }, "A", async () => ({
      ok: true,
      outcome: "not_delivered",
      reason: "dialog",
    }));
    const unconfirmed = unconfirmedSends(loadSends("sid-5"));
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]).toMatchObject({ text: "A", state: "unconfirmed" });
    expect(lastFailure("sid-5")).toEqual({ kind: "not_delivered", reason: "dialog" });
    expect(loadDraft("sid-5")?.text).toBe("A");
  });

  // 何を保証するか: not_delivered / 送れなかった時は記録を消し、下書きは残す。
  test("not_delivered and failed drop the record and keep the draft", async () => {
    saveDraft("sid-6", "keep");
    await sendSessionInput("sid-6", { text: "keep" }, "keep", async () => ({
      ok: true,
      outcome: "not_delivered",
      reason: "no_terminal",
    }));
    await sendSessionInput("sid-6", { text: "keep" }, "keep", async () => {
      throw new Error("ws not open");
    });
    expect(loadSends("sid-6")).toEqual([]);
    expect(loadDraft("sid-6")?.text).toBe("keep");
    expect(lastFailure("sid-6")?.kind).toBe("failed");
  });

  // 何を保証するか (指摘 6): ws の期限切れ (request_timeout) は未確認になり、
  // 送信中の状態が解ける。
  test("a timed-out request becomes unconfirmed and releases the lock", async () => {
    saveDraft("sid-7", "slow");
    const outcome = await sendSessionInput("sid-7", { text: "slow" }, "slow", async () => ({
      ok: false,
      error: { code: "request_timeout", msg: "no reply within 15000 ms" },
    }));
    expect(outcome.kind).toBe("unconfirmed");
    expect(isSending("sid-7")).toBe(false);
    expect(unconfirmedSends(loadSends("sid-7"))).toHaveLength(1);
  });

  // 何を保証するか (指摘 7): 未確認の文 A を B に書き換えた後、A の記録を
  // 「届いていたので消す」と、記録だけが消えて下書き B は残る。下書きが A の
  // ままなら下書きも消える。
  test("discarding a record clears the draft only while it still holds that text", async () => {
    saveDraft("sid-8", "A");
    await sendSessionInput("sid-8", { text: "A" }, "A", async () => ({
      ok: true,
      outcome: "unconfirmed",
    }));
    const [recordA] = loadSends("sid-8");
    saveDraft("sid-8", "B");
    discardSend("sid-8", recordA.id);
    expect(loadSends("sid-8")).toEqual([]);
    expect(loadDraft("sid-8")?.text).toBe("B");

    saveDraft("sid-8", "A2");
    await sendSessionInput("sid-8", { text: "A2" }, "A2", async () => ({
      ok: true,
      outcome: "unconfirmed",
    }));
    const [recordA2] = loadSends("sid-8");
    discardSend("sid-8", recordA2.id);
    expect(loadDraft("sid-8")).toBeNull();
  });

  // 何を保証するか: 送った文の本文は placeholder を解決した finalText で、
  // 記録と下書きの比較は人が書いたままの本文で行う。
  test("sends the resolved text but records the draft as written", async () => {
    const attachment = {
      n: 1,
      name: "a.png",
      status: "done",
      progress: 100,
      path: "/t/a.png",
    } as const;
    saveDraft("sid-9", "see [FILE1]", [attachment]);
    const d = deferredRequest();
    const pending = sendSessionInput(
      "sid-9",
      { text: "see [FILE1]", attachments: [attachment] },
      "see [FILE1:a.png](/t/a.png)",
      d.request,
    );
    expect(d.sentText()).toBe("see [FILE1:a.png](/t/a.png)");
    expect(loadSends("sid-9")[0]).toMatchObject({ text: "see [FILE1]", attachments: [{ n: 1 }] });
    d.reply({ ok: true, outcome: "accepted" });
    await pending;
    expect(loadDraft("sid-9")).toBeNull();
  });

  // 何を保証するか: 状態の変化を購読者に知らせる (部品が再描画の契機に使う)。
  // 送信の開始と終了の両方で sid 付きで呼ばれる。
  test("notifies subscribers on begin and finish", () => {
    const seen: string[] = [];
    const off = subscribeSessionInput((sid) => seen.push(sid));
    const record = beginSend("sid-10", { text: "x" });
    finishSend("sid-10", record, { kind: "accepted" });
    off();
    beginSend("sid-10", { text: "y" });
    expect(seen).toEqual(["sid-10", "sid-10"]);
  });

  // 何を保証するか: 壊れた記録は読み飛ばす (送信経路を詰まらせない)。
  // 形の崩れた記録を含む記録の列は読めない: 一部だけを採らず、丸ごと無いもの
  // として扱う (DR-0038 §6)。
  test("loadSends ignores records with a malformed one, as a whole", () => {
    localStorage.setItem(
      `${SENDS_STORAGE_PREFIX}sid-bad`,
      JSON.stringify([
        { id: "ok", text: "t", sentAt: "2026-10-08T00:00:00.000Z", state: "unconfirmed" },
        { id: "bad-state", text: "t", sentAt: "2026-10-08T00:00:00.000Z", state: "weird" },
        { id: "bad-time", text: "t", sentAt: "nope", state: "sending" },
        "junk",
      ]),
    );
    expect(loadSends("sid-bad")).toEqual([]);
  });

  // 何を保証するか: 送信の記録も下書きと同じ規則で sweep される (セッションが
  // 消えた sid の記録を溜め続けない)。
  test("cleanupStaleSessionInputs sweeps send records of gone sessions", () => {
    beginSend("sid-gone", { text: "x" });
    beginSend("sid-here", { text: "y" });
    cleanupStaleSessionInputs({ ...initialState(), peers: [makePeer("sid-here")] });
    expect(loadSends("sid-gone")).toEqual([]);
    expect(loadSends("sid-here")).toHaveLength(1);
  });
});
