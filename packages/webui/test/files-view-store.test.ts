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
