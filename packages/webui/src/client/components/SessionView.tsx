// Top-level "session" screen (DR-0008 Files pane, DR-0009 Timeline pane,
// DR-0020 Status tab). Selected via the `#s<sid>[:<path>]` (Files) or
// `#t<sid>` (Timeline) locator (App.tsx routes here instead of RoomView when
// state.view is "session" or "timeline"). Files/Timeline/Rooms/Status all
// share one sid-keyed SessionTreeState cache so switching tabs never
// refetches what's already loaded.
import { useEffect, useState } from "preact/hooks";
import type { SessionSearchHit } from "@ccmsg/protocol";
import type { AppState, SessionTreeState } from "../store.ts";
import { fileHref, sessionHref, timelineHref } from "../locator.ts";
import { cleanupStaleFilesViews, loadFilesView } from "../files-view-store.ts";
import { useApp } from "../context.ts";
import { FilesPanes } from "./FilesPanes.tsx";
import { Timeline } from "./Timeline.tsx";
import { SessionRooms } from "./SessionRooms.tsx";
import { StatusPanel } from "./StatusPanel.tsx";
import { OneOnOneComposer } from "./OneOnOneComposer.tsx";

/** Local (non-locator) tab layered on top of Files/Timeline locator routing,
 * same rationale as the pre-existing Rooms tab (see `localTab`'s doc comment
 * in SessionView below): Status has no per-sid persisted sub-state worth
 * round-tripping through the URL, just a live snapshot already cached in
 * `state.sessionStatuses`. `null` = follow the locator-driven tab
 * (Files/Timeline). */
type LocalTab = "rooms" | "status" | null;

const EMPTY_TREE: SessionTreeState = {
  dirs: new Map(),
  dirErrors: new Map(),
  expanded: new Set(),
  selectedPath: null,
  file: null,
  timeline: { status: "idle", lines: [], start: 0, end: 0, size: 0, atStart: false },
  timelineSearch: { queryText: "", caseSensitive: false, regex: false },
};

function pinCandidate(state: AppState, sid: string, tree: SessionTreeState): SessionSearchHit {
  const stored = state.pinnedSessions.get(sid) ?? tree.searchHit;
  if (stored) return stored;
  const peer = state.peers.find((item) => item.sid === sid);
  const agent = state.agents.find((item) => item.sessionId === sid);
  const cwd = peer?.cwd ?? agent?.cwd ?? null;
  const agentCreatedAt =
    agent && Number.isFinite(agent.startedAt) && Math.abs(agent.startedAt) <= 8.64e15
      ? new Date(agent.startedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  const createdAt = peer?.connected_at ?? agentCreatedAt;
  return {
    sid,
    config_dir: agent?.config_dir ?? "",
    file: peer?.transcript_path ?? "",
    cwd,
    repo: peer?.repo ?? null,
    ws: peer?.ws ?? null,
    created_at: createdAt,
    updated_at: peer?.last_activity_at ?? createdAt,
    size: 0,
    matches: [],
  };
}

export function SessionView({ state }: { state: AppState }) {
  const { store, ws } = useApp();
  const sid = state.currentSid;
  const tree = sid ? (state.sessionTrees.get(sid) ?? EMPTY_TREE) : EMPTY_TREE;
  // Rooms/Status are tabs layered on top of the Files/Timeline locator
  // routing (`#s<sid>` / `#t<sid>`, see locator.ts) rather than a locator
  // form of their own — neither has per-sid persisted sub-state worth
  // round-tripping through the URL (unlike Files' selectedPath or Timeline's
  // paging position), so a local toggle is enough. Clicking Files/Timeline
  // (both real `<a href>` locator links) clears it back to whatever
  // state.view says.
  const [localTab, setLocalTab] = useState<LocalTab>(null);

  // Reset back to the locator-driven tab (Files/Timeline) on a session
  // switch (adversarial review nit finding): SessionView doesn't remount
  // across a sid change (sidebar navigation just changes `state.currentSid`),
  // so without this a Rooms/Status tab left open before switching sessions
  // would keep showing that tab for the newly-selected session too,
  // inconsistent with Files/Timeline's locator-driven behavior (every other
  // tab always matches the URL for the session you just navigated to).
  useEffect(() => setLocalTab(null), [sid]);

  // tab の確定は sid の有無に関係なく毎 render 行う (下の early return より前
  // — hooks は無条件に同じ順序で呼ぶ必要があるため、購読 effect もここで
  // 確定させた tab を見て判断する)。
  // DR-0025 Phase 2: `state.currentAgent` が付いた `#t<sid>:...` locator は
  // 「Status パネルの TL リンクからエージェント TL に遷移した」状態 — この
  // 経路では `localTab` が "status" のまま残っている (Status ボタンの
  // `setLocalTab("status")` が最後の toggle だったため) ので普通に読むと
  // Status タブに戻ってしまい、agent TL が見えず要件 (DR-0025 §2.1 「TL を
  // 見る」→ Timeline ビュー) を満たさない。agent ref が locator に載って
  // いる間は localTab を無視して timeline を強制する。
  const tab = state.currentAgent
    ? "timeline"
    : (localTab ?? (state.view === "timeline" ? "timeline" : "files"));
  // Status/Timeline の status データ源は transcript fold (DR-0020 §3.1) —
  // hello 時に transcript_path を申告・検証済みのセッションでしか
  // session_status_subscribe は成立しない (daemon の resolveTranscript が
  // error を返す)。Timeline タブが既に使っている判定と同一 (下の
  // hasTranscript と同値だが、early return より前 = hooks 位置で必要なので
  // ここで引く)。
  const peer = state.peers.find((p) => p.sid === sid);
  // Two distinct capabilities, gated separately (DR-0021 §2.4/§3.1):
  //
  // - hasStatusFeed: the daemon's session_status_subscribe resolves the
  //   transcript WITHOUT the allowVirtual fallback (transcript.ts's
  //   TranscriptResolveOptions doc: "session-status callers intentionally
  //   keep the connected-session contract") — so a live folded status feed
  //   only exists for a connected session that announced a transcript_path.
  //   Subscribing for a virtual sid would get session_not_found back and
  //   leave StatusPanel's "読み込み中…" up forever.
  // - hasTranscript: transcript_read DOES take the allowVirtual path for a
  //   user-role conn (server.ts). A selected historical search hit (or a pin
  //   created from one) carries its resolved jsonl file, so it remains readable
  //   with no live peer. Arbitrary sid pins without a transcript file do not
  //   widen this capability gate.
  const hasStatusFeed = !!peer?.transcript_path;
  // Re-hello may keep the same sid while changing transcript/root metadata.
  // Include the concrete fold source in the subscription effect deps so the
  // daemon's subscribe path can invalidate/rebuild its DR-0020/DR-0024 cache.
  const statusSource = hasStatusFeed
    ? `${peer.transcript_path}\n${peer.repo_root ?? peer.cwd}`
    : null;
  const storedHit = sid ? (state.pinnedSessions.get(sid) ?? tree.searchHit) : undefined;
  const hasTranscript = hasStatusFeed || !!storedHit?.file;

  // Status データ購読 (DR-0020 Phase 2/3, DR-0024): Status/Timeline に加え
  // Files タブも external_files を要るため、この 3 タブのどれかが開いている間
  // subscribe する。Rooms に切り替わる/セッションが変わる/unmount のいずれかで
  // unsubscribe + キャッシュ破棄する。ひとつの effect が 3 タブの需要を兼ねる
  // — タブ別に effect を分けると、同じ (sid) への
  // subscribe が daemon 側で Set 的に重複排除される一方 unsubscribe は
  // 無条件にその sid を切るため、"片方の tab を閉じたらもう片方の生きた
  // 購読まで道連れで消える" 事故になる。deps は tab そのものではなく
  // 「購読が必要か」の boolean (needsStatus) — tab を直接 deps に入れると
  // Status↔Timeline の切替のたびに unsubscribe→re-subscribe が走り、daemon
  // 側は購読者 0 の時点で fold を破棄するため毎回 transcript 全量 rescan +
  // UI は cleared→loaded の間「読み込み中…」に戻るちらつきになる。
  //
  // サイドバーのミニバッジ (SessionList.tsx) はここで作った
  // `state.sessionStatuses` を読むだけの受動的な消費者 — つまりバッジが出る
  // のは「今まさに Files/Status/Timeline タブを開いているセッション」だけ
  // (DR-0020 §2.1 (a) 案: 全 peer 常時 subscribe はコストに見合わないため、
  // 実装コストとのトレードオフでこちらを採用。全 peer 分の完全なバッジは
  // Phase 3 後続に持ち越す)。
  const needsStatus = tab === "files" || tab === "status" || tab === "timeline";
  useEffect(() => {
    if (!sid || !needsStatus || !hasStatusFeed) return;
    if (state.connStatus !== "connected") return;
    // Cancellation guard (same pattern as Timeline's scroll effect): without
    // it, a tab/session switch that tears this effect down BEFORE the
    // subscribe response resolves would dispatch `session-status/loaded`
    // AFTER the cleanup's `session-status/cleared` — leaving a stale entry
    // in sessionStatuses that violates its "absence = not subscribed"
    // contract (store.ts) with no owner left to ever clear it.
    let cancelled = false;
    void ws
      .sessionStatusSubscribe(sid)
      .then((res) => {
        if (cancelled || !res.ok) return;
        store.dispatch({
          type: "session-status/loaded",
          sid,
          snapshot: {
            todos: res.todos,
            workflows: res.workflows,
            background: res.background,
            ...(res.context ? { context: res.context } : {}),
            teammates: res.teammates ?? [],
            external_files: res.external_files ?? [],
            ...(res.workspace_folders ? { workspace_folders: res.workspace_folders } : {}),
          },
        });
      })
      .catch(() => {
        // send() rejects while the socket isn't open (ws.ts) — next
        // connStatus flip to "connected" re-runs this effect, same retry
        // policy as Timeline's own transcriptSubscribe effect.
      });
    return () => {
      cancelled = true;
      void ws.sessionStatusUnsubscribe(sid).catch(() => {});
      store.dispatch({ type: "session-status/cleared", sid });
    };
  }, [sid, needsStatus, hasStatusFeed, statusSource, state.connStatus]);

  // Files タブのファイル選択の復元 (kawaz r17 mid=5、2026-07-14)。Files タブ
  // のリンクは `#s<sid>` (path なし) なので、Timeline↔Files のタブ往復や
  // セッション切替のたびに selectedPath が null に戻る。path なしの Files
  // locator に居て per-sid の保存 record (files-view-store.ts) があれば、
  // 保存 path の fileHref へ location.replace で差し替える (replace なのは
  // 「path なし → 復元後」の中間状態を history に残さないため — back で
  // 直前の画面に戻れる挙動を維持する)。viewMode の復元は FileViewer 側
  // (path 一致時のみ) が担う。
  const selectedPath = sid ? (state.sessionTrees.get(sid)?.selectedPath ?? null) : null;
  useEffect(() => {
    if (!sid || state.view !== "session" || selectedPath !== null) return;
    const saved = loadFilesView(sid);
    if (saved) location.replace(fileHref(sid, saved.path));
  }, [sid, state.view, selectedPath]);

  // 保存 record の mount-time sweep (OneOnOneComposer の draft sweep と同じ
  // 2 規則: peers 不在 sid / 10 日超非アクティブ)。peers が hydrate する前
  // (空) は比較対象がないので待つ — 以降の peers 増減では再実行しない
  // (mount あたり 1 回で十分、再訪時にまた走る)。
  useEffect(() => {
    if (state.peers.length > 0) cleanupStaleFilesViews(state);
  }, [state.peers.length]);

  if (!sid) {
    return (
      <main id="session-view">
        <p id="empty-state">session を選んでください</p>
      </main>
    );
  }

  const sessionStatus = state.sessionStatuses.get(sid);

  return (
    <main id="session-view">
      <div class="session-tabs">
        <a
          class={"session-tab" + (tab === "files" ? " active" : "")}
          href={sessionHref(sid)}
          onClick={() => setLocalTab(null)}
        >
          Files
        </a>
        {hasTranscript ? (
          <a
            class={"session-tab" + (tab === "timeline" ? " active" : "")}
            href={timelineHref(sid)}
            onClick={() => setLocalTab(null)}
          >
            Timeline
          </a>
        ) : (
          <span class="session-tab disabled" title="このセッションは transcript を申告していません">
            Timeline
          </span>
        )}
        {/* kawaz r26 mid=66: Rooms は一番右 (Files / Timeline / Status / Rooms) */}
        <button
          type="button"
          class={"session-tab" + (tab === "status" ? " active" : "")}
          onClick={() => setLocalTab("status")}
        >
          Status
        </button>
        <button
          type="button"
          class={"session-tab" + (tab === "rooms" ? " active" : "")}
          onClick={() => setLocalTab("rooms")}
        >
          Rooms
        </button>
        <button
          type="button"
          class={"session-pin-toggle" + (state.pinnedSessions.has(sid) ? " active" : "")}
          aria-pressed={state.pinnedSessions.has(sid)}
          title={state.pinnedSessions.has(sid) ? "ピン解除" : "ピン留め"}
          onClick={() =>
            store.dispatch({ type: "pinned/toggled", hit: pinCandidate(state, sid, tree) })
          }
        >
          {state.pinnedSessions.has(sid) ? "Unpin" : "Pin"}
        </button>
      </div>
      {tab === "rooms" ? (
        <SessionRooms sid={sid} state={state} />
      ) : tab === "status" ? (
        // Status data is a live fold over a CONNECTED session's transcript
        // (DR-0020 §3.1; the daemon's session_status_subscribe deliberately
        // has no allowVirtual fallback) — so both a session that never
        // announced a transcript and a pinned-but-disconnected (virtual,
        // DR-0021) one can never produce a snapshot. Explain which instead
        // of leaving StatusPanel's "読み込み中…" spinner up forever.
        hasStatusFeed ? (
          <StatusPanel snapshot={sessionStatus} sid={sid} onKill={() => ws.sessionKill(sid)} />
        ) : hasTranscript ? (
          <p id="empty-state">
            Status は接続中のセッションのみ表示できます (このセッションは ccmsg 未接続)
          </p>
        ) : (
          <p id="empty-state">このセッションは transcript を申告していません</p>
        )
      ) : tab === "timeline" ? (
        // Guard against a stale/hand-typed `#t<sid>` link outliving the
        // session's transcript announcement (e.g. reconnect without hello
        // re-sending transcript_path) — the disabled tab above already tells
        // the user why, so the pane falls back to the same explanation
        // rather than calling ws.transcriptRead for a session we know lacks one.
        hasTranscript ? (
          <Timeline
            sid={sid}
            timeline={tree.timeline}
            search={tree.timelineSearch}
            sessionStatus={sessionStatus}
            onOpenStatus={() => setLocalTab("status")}
            agent={state.currentAgent}
          />
        ) : (
          <p id="empty-state">このセッションは transcript を申告していません</p>
        )
      ) : (
        <FilesPanes
          sid={sid}
          tree={tree}
          peer={peer}
          externalFiles={sessionStatus?.external_files ?? []}
          workspaceFolders={sessionStatus?.workspace_folders ?? []}
        />
      )}
      {/* DR-0014 §2.6 floating 1on1 composer: only makes sense on the
       * Files/Timeline tabs (kawaz can already open a room directly from
       * the Rooms tab, so an extra FAB there would be noise; Status is the
       * same kind of read-only reporting tab, DR-0020). Positioned over the
       * tab content via position:fixed in app.css; each tab switch keeps the
       * same instance so an in-progress compose survives a Files↔Timeline
       * hop.
       * kawaz r26 mid=65: ccmsg 未接続セッション (pinned/仮想閲覧、agents-only
       * 行) では 1on1 送信先が存在しないため FAB 自体を出さない — daemon 側
       * でも配送不能なのでガード。Files 経由のコード閲覧・編集系はこの条件と
       * 無関係に従来通り。 */}
      {peer && (tab === "files" || tab === "timeline") ? (
        <OneOnOneComposer sid={sid} state={state} />
      ) : null}
    </main>
  );
}
