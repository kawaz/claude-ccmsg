// Files タブ表示状態 (選択ファイル + viewMode) の per-sid 永続化ヘルパ
// (kawaz r17 mid=5)。1on1 draft (one-on-one-composer.test.ts) と同じ
// 保存・削除ルールを踏襲していることをテストで固定する: round-trip、
// 壊れた record の拒否、mount-time sweep の 2 規則 (peers 不在 / 10 日超
// 非アクティブ)、誤爆防止 (無関係 key と fresh record を残す)。
import { beforeEach, describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  cleanupStaleFilesViews,
  FILES_VIEW_STALE_MS,
  filesViewKey,
  loadFilesView,
  resolveMarkdownViewMode,
  resolveMarkdownViewModePersist,
  saveFilesView,
} from "../src/client/files-view-store.ts";
import { initialState, type AppState } from "../src/client/store.ts";

// one-on-one-composer.test.ts と同じ最小 localStorage shim (helpers が
// 直接 browser global を読むため、bun test では自前で生やす)。
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

function makePeer(sid: string, opts: { lastActivityAt?: string } = {}): PeerInfo {
  return {
    sid,
    repo: "test-repo",
    ws: "test-ws",
    cwd: "/test",
    ...(opts.lastActivityAt ? { last_activity_at: opts.lastActivityAt } : {}),
  };
}

function stateWithPeers(peers: PeerInfo[]): AppState {
  return { ...initialState(), peers };
}

describe("filesView save/load round-trip", () => {
  // 何を保証するか: 保存した path + viewMode が sid をキーに verbatim で
  // 取り出せる (タブ切替・リロード後の復元の土台)。updatedAt は保存側が
  // 自動で刻む (sweep の fallback 基準になるため record に必ず載る)。
  test("saveFilesView + loadFilesView round-trips path and viewMode", () => {
    saveFilesView("sid-a", { path: "docs/README.md", viewMode: "preview" });
    const got = loadFilesView("sid-a");
    expect(got?.path).toBe("docs/README.md");
    expect(got?.viewMode).toBe("preview");
    expect(typeof got?.updatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(got!.updatedAt))).toBe(true);
  });

  // 何を保証するか (壊れた record の拒否): 手編集・旧版・別アプリ由来の
  // 不正 JSON / 型不一致 (viewMode が "code"/"preview" 以外) は null 扱いで
  // 復元経路に乗らない — 壊れた値で viewer が未定義状態になるより
  // 「復元なし」に degrade するのが安全側。
  test("loadFilesView rejects malformed records", () => {
    localStorage.setItem(filesViewKey("sid-b"), "not json");
    expect(loadFilesView("sid-b")).toBeNull();
    localStorage.setItem(
      filesViewKey("sid-c"),
      JSON.stringify({ path: "a.md", viewMode: "html", updatedAt: new Date().toISOString() }),
    );
    expect(loadFilesView("sid-c")).toBeNull();
    localStorage.setItem(filesViewKey("sid-d"), JSON.stringify({ viewMode: "code" }));
    expect(loadFilesView("sid-d")).toBeNull();
  });
});

describe("resolveMarkdownViewMode / …Persist (r26 mid=112 の A→B→A 復元)", () => {
  // 何を保証するか (真因の再発防止): 初版は「saved.path === 現 path 一致時
  // のみ preview 復元」だったため、markdown A(preview) → 別ファイル B → A
  // で戻ると B 選択時に record が {B, code} で上書きされ A では復元できない。
  // r26 mid=112 以降は saved.viewMode を per-sid の markdown モードとして扱い、
  // markdown ファイルを開くたびに saved.viewMode を復元する。
  test("markdown file restores saved viewMode regardless of path mismatch", () => {
    const saved = { path: "docs/OTHER.md", viewMode: "preview" as const, updatedAt: "t" };
    expect(resolveMarkdownViewMode(saved, "docs/QUESTIONS.md")).toBe("preview");
    expect(resolveMarkdownViewMode(saved, "docs/QUESTIONS.markdown")).toBe("preview");
  });

  // 何を保証するか (対極): saved が null (初回) や viewMode が "code" の
  // 記憶なら markdown を開いても "code" 復元 — 「勝手に preview になる」
  // 事故を起こさない。
  test("markdown file falls back to code when there is no preview memory", () => {
    expect(resolveMarkdownViewMode(null, "docs/README.md")).toBe("code");
    expect(
      resolveMarkdownViewMode(
        { path: "docs/README.md", viewMode: "code", updatedAt: "t" },
        "docs/README.md",
      ),
    ).toBe("code");
  });

  // 何を保証するか (非 markdown): 非 markdown path では viewer 表示は常に
  // code (toggle 自体が render されない) — 復元値も無条件 "code"。
  test("non-markdown file always resolves to code", () => {
    const saved = { path: "src/foo.ts", viewMode: "preview" as const, updatedAt: "t" };
    expect(resolveMarkdownViewMode(saved, "src/foo.ts")).toBe("code");
    expect(resolveMarkdownViewMode(saved, "package.json")).toBe("code");
  });

  // 何を保証するか (継承の要): 非 markdown ファイルを選んだときの record
  // 上書きで saved.viewMode ("preview" 等) を "code" に落とすと A→B(非md)→A
  // の遷移で markdown モードが失われる。resolveMarkdownViewModePersist は
  // 非 markdown 選択時に saved.viewMode をそのまま継承する。
  test("persist inherits saved markdown mode when selecting a non-markdown path", () => {
    const saved = { path: "docs/QUESTIONS.md", viewMode: "preview" as const, updatedAt: "t" };
    // .ts を選んでも markdown モード ("preview") の記憶を維持
    expect(resolveMarkdownViewModePersist(saved, "src/foo.ts", "code")).toBe("preview");
    // saved が無い / "code" 記憶の場合は "code" のまま (中立初期状態)
    expect(resolveMarkdownViewModePersist(null, "src/foo.ts", "code")).toBe("code");
  });

  // 何を保証するか (markdown 側): markdown を開いたときは restored 値を
  // そのまま record.viewMode に反映 (= その値がその後の per-sid markdown
  // モードの last choice になる)。
  test("persist writes restored value verbatim for markdown paths", () => {
    expect(resolveMarkdownViewModePersist(null, "docs/README.md", "preview")).toBe("preview");
    expect(
      resolveMarkdownViewModePersist(
        { path: "docs/OTHER.md", viewMode: "code", updatedAt: "t" },
        "docs/README.md",
        "code",
      ),
    ).toBe("code");
  });

  // 何を保証するか (A→B→A シナリオの integration): saveFilesView / loadFilesView
  // と組み合わせて FileViewer restore effect と同じ順序で状態遷移させ、A に
  // 戻ったときに preview が復活することを固定する。
  test("integration: A(preview) → B(non-md) → A restores preview", () => {
    const sid = "sid-abcs";
    const A = "docs/QUESTIONS.md";
    const B = "src/foo.ts";

    // A(preview) 選択 + 手動 preview 切替
    saveFilesView(sid, { path: A, viewMode: "preview" });

    // B 選択の path 遷移 effect と同じ手順 (restored + persist)
    let saved = loadFilesView(sid);
    const restoredB = resolveMarkdownViewMode(saved, B);
    saveFilesView(sid, {
      path: B,
      viewMode: resolveMarkdownViewModePersist(saved, B, restoredB),
    });
    // record は path=B に更新されるが viewMode は "preview" のまま継承
    expect(loadFilesView(sid)?.path).toBe(B);
    expect(loadFilesView(sid)?.viewMode).toBe("preview");

    // A に戻る path 遷移 effect
    saved = loadFilesView(sid);
    const restoredA = resolveMarkdownViewMode(saved, A);
    expect(restoredA).toBe("preview");
    saveFilesView(sid, {
      path: A,
      viewMode: resolveMarkdownViewModePersist(saved, A, restoredA),
    });
    expect(loadFilesView(sid)?.path).toBe(A);
    expect(loadFilesView(sid)?.viewMode).toBe("preview");
  });
});

describe("cleanupStaleFilesViews (1on1 draft と同じ 2 規則の sweep)", () => {
  // 何を保証するか (規則 a): peers に居ない sid の record は削除される —
  // 対象セッションが消えており「そのセッションの Files タブ」自体が
  // もう開けないので、復元先のない record を溜め込まない。
  test("removes records whose sid is absent from peers", () => {
    saveFilesView("sid-gone", { path: "a.ts", viewMode: "code" });
    saveFilesView("sid-alive", { path: "b.ts", viewMode: "code" });
    cleanupStaleFilesViews(stateWithPeers([makePeer("sid-alive")]));
    expect(loadFilesView("sid-gone")).toBeNull();
    expect(loadFilesView("sid-alive")?.path).toBe("b.ts");
  });

  // 何を保証するか (規則 b): peer は居るが 10 日超非アクティブ
  // (last_activity_at 基準) の record は削除される。10 日は 1on1 draft の
  // CLEANUP_STALE_DAYS と同じ運用判断 (kawaz「入力フォームと同じ保存と
  // 削除ルールで良い」r17 mid=5)。
  test("removes records for peers inactive beyond the stale window", () => {
    const now = Date.now();
    const staleTs = new Date(now - FILES_VIEW_STALE_MS - 1000).toISOString();
    const freshTs = new Date(now - 1000).toISOString();
    saveFilesView("sid-stale", { path: "a.ts", viewMode: "code" });
    saveFilesView("sid-fresh", { path: "b.ts", viewMode: "preview" });
    cleanupStaleFilesViews(
      stateWithPeers([
        makePeer("sid-stale", { lastActivityAt: staleTs }),
        makePeer("sid-fresh", { lastActivityAt: freshTs }),
      ]),
      now,
    );
    expect(loadFilesView("sid-stale")).toBeNull();
    expect(loadFilesView("sid-fresh")?.viewMode).toBe("preview");
  });

  // 何を保証するか (fallback): peer が last_activity_at を持たない場合は
  // record 自身の updatedAt で判定する (古い daemon / hello 直後の peer でも
  // sweep が機能する)。fresh な record は残る (誤爆防止の対極ケース)。
  test("falls back to the record's own updatedAt when the peer has no activity stamp", () => {
    const now = Date.now();
    localStorage.setItem(
      filesViewKey("sid-old-record"),
      JSON.stringify({
        path: "a.ts",
        viewMode: "code",
        updatedAt: new Date(now - FILES_VIEW_STALE_MS - 1000).toISOString(),
      }),
    );
    saveFilesView("sid-new-record", { path: "b.ts", viewMode: "code" });
    cleanupStaleFilesViews(
      stateWithPeers([makePeer("sid-old-record"), makePeer("sid-new-record")]),
      now,
    );
    expect(loadFilesView("sid-old-record")).toBeNull();
    expect(loadFilesView("sid-new-record")?.path).toBe("b.ts");
  });

  // 何を保証するか (誤爆防止の対極): sweep は ccmsg.filesView. prefix の
  // key だけを対象にする — 1on1 draft (ccmsg.1on1.*) や since cursor
  // (ccmsg.since_seq) など隣接する localStorage 状態を巻き込まない。
  test("leaves unrelated localStorage keys alone", () => {
    localStorage.setItem("ccmsg.1on1.sid-x", JSON.stringify({ text: "draft", updatedAt: "t" }));
    localStorage.setItem("ccmsg.since_seq", '{"r1":5}');
    cleanupStaleFilesViews(stateWithPeers([makePeer("sid-alive")]));
    expect(localStorage.getItem("ccmsg.1on1.sid-x")).not.toBeNull();
    expect(localStorage.getItem("ccmsg.since_seq")).toBe('{"r1":5}');
  });
});
