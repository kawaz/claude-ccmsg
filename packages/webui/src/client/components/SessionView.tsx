// Top-level "session" screen (DR-0008 Files pane, DR-0009 Timeline pane,
// DR-0020 Status tab). Selected via the `#s<sid>[:<path>]` (Files) or
// `#t<sid>` (Timeline) locator (App.tsx routes here instead of RoomView when
// state.view is "session" or "timeline"). Files/Timeline/Rooms/Status all
// share one sid-keyed SessionTreeState cache so switching tabs never
// refetches what's already loaded.
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { SessionSearchHit } from "@ccmsg/protocol";
import { DEFAULT_TIMELINE_SEARCH, type AppState, type SessionTreeState } from "../store.ts";
import {
  fileHref,
  filesHref,
  sessionRoomsHref,
  statusHref,
  terminalHref,
  timelineHref,
  type AgentRef,
  type SessionTab,
} from "../locator.ts";
import { BEFORE_NAVIGATION_EVENT, replaceNavigation } from "../navigation.ts";
import { cleanupStaleFilesViews, loadFilesView } from "../files-view-store.ts";
import { useApp } from "../context.ts";
import { FilesPanes } from "./FilesPanes.tsx";
import { Timeline } from "./Timeline.tsx";
import { TimelinePanes } from "./TimelinePanes.tsx";
import { SessionRooms } from "./SessionRooms.tsx";
import { StatusPanel } from "./StatusPanel.tsx";
import { OneOnOneComposer } from "./OneOnOneComposer.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { Tabs, type TabItem } from "./Tabs.tsx";

/** Terminal appears only for sessions that have one — an always-present but
 * dead Terminal tab would invite clicks that do nothing. Timeline instead
 * stays and goes disabled, because a session without a transcript is the
 * unusual case and saying so is more useful than hiding it. */
function sessionTabItems(
  sid: string,
  hasTranscript: boolean,
  hasTerminal: boolean,
): TabItem<SessionTab>[] {
  return [
    { id: "files", label: "Files", href: filesHref(sid) },
    hasTranscript
      ? { id: "timeline", label: "Timeline", href: timelineHref(sid) }
      : {
          id: "timeline",
          label: "Timeline",
          disabled: true,
          title: "このセッションは transcript を申告していません",
        },
    ...(hasTerminal
      ? [{ id: "terminal", label: "Terminal", href: terminalHref(sid) } as TabItem<SessionTab>]
      : []),
    { id: "status", label: "Status", href: statusHref(sid) },
    { id: "rooms", label: "Rooms", href: sessionRoomsHref(sid) },
  ];
}

const EMPTY_TREE: SessionTreeState = {
  dirs: new Map(),
  dirErrors: new Map(),
  expanded: new Set(),
  selectedPath: null,
  selectedLineRange: null,
  selectedFrom: null,
  file: null,
  timeline: { status: "idle", lines: [], start: 0, end: 0, size: 0, atStart: false },
  timelineSearch: { ...DEFAULT_TIMELINE_SEARCH },
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
    title: agent?.name ?? null,
  };
}

export function SessionView({
  state,
  sid,
  tab,
  agent,
  active,
}: {
  state: AppState;
  sid: string;
  tab: SessionTab;
  agent: AgentRef | null;
  active: boolean;
}) {
  const { store, ws } = useApp();
  const tree = state.sessionTrees.get(sid) ?? EMPTY_TREE;
  const visitedTabs = useRef(new Set<SessionTab>());
  const rootRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  visitedTabs.current.add(tab);

  useEffect(() => {
    if (!active) return;
    const capture = () => {
      const root = rootRef.current;
      if (!root) return;
      const next = new Map<HTMLElement, { top: number; left: number }>();
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
          next.set(element, { top: element.scrollTop, left: element.scrollLeft });
        }
      }
      scrollPositions.current = next;
    };
    window.addEventListener(BEFORE_NAVIGATION_EVENT, capture);
    return () => window.removeEventListener(BEFORE_NAVIGATION_EVENT, capture);
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;
    for (const [element, position] of scrollPositions.current) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }, [active]);
  // Status/Timeline の status データ源は transcript fold (DR-0020 §3.1) —
  // hello 時に transcript_path を申告・検証済みのセッションでしか
  // session_status_subscribe は成立しない (daemon の resolveTranscript が
  // error を返す)。Timeline タブが既に使っている判定と同一 (下の
  // hasTranscript と同値だが、early return より前 = hooks 位置で必要なので
  // ここで引く)。
  const peer = state.peers.find((p) => p.sid === sid);
  // Terminal タブは agent の hyoui_session_id が解決済み かつ daemon の
  // config.json で terminal_gateway_url が設定されているセッションでのみ
  // 表示する (issue 2026-07-21, kawaz r46m7)。どちらか欠けていれば Terminal
  // タブ自体を出さない (「設定していないユーザには存在しない機能」に倒す +
  // iframe の src が組めない)。
  const agentForSid = sid ? state.agents.find((a) => a.sessionId === sid) : undefined;
  const hyouiSessionId = agentForSid?.hyoui_session_id;
  const terminalGatewayUrl = state.terminalGatewayUrl;
  const hasTerminal = !!hyouiSessionId && !!terminalGatewayUrl;
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
    if (!active || !sid || !needsStatus || !hasStatusFeed) return;
    if (state.connStatus !== "connected") return;
    // Cancellation guard (same pattern as Timeline's scroll effect): without
    // it, a tab/session switch that tears this effect down BEFORE the
    // subscribe response resolves would dispatch `session-status/loaded`
    // AFTER the cleanup's `session-status/cleared` — leaving a stale entry
    // in sessionStatuses that violates its "absence = not subscribed"
    // contract (store.ts) with no owner left to ever clear it.
    let cancelled = false;
    // The daemon answers this connection's requests concurrently, and
    // session_status_subscribe awaits IO while session_status_unsubscribe does
    // not — so the cleanup below waits for this Promise instead of racing it,
    // or a fast tab switch could tear down the subscription before it exists
    // and leave the watch installed with no reader.
    const subscribed = ws
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
            ...(res.agent_tree ? { agent_tree: res.agent_tree } : {}),
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
      void subscribed.then(() => ws.sessionStatusUnsubscribe(sid).catch(() => {}));
      store.dispatch({ type: "session-status/cleared", sid });
    };
  }, [active, sid, needsStatus, hasStatusFeed, statusSource, state.connStatus]);

  // Files タブのファイル選択の復元 (kawaz r17 mid=5、2026-07-14)。Files タブ
  // のリンクは `#s<sid>` (path なし) なので、Timeline↔Files のタブ往復や
  // セッション切替のたびに selectedPath が null に戻る。path なしの Files
  // locator に居て per-sid の保存 record (files-view-store.ts) があれば、
  // 保存 path の fileHref へ location.replace で差し替える (replace なのは
  // 「path なし → 復元後」の中間状態を history に残さないため — back で
  // 直前の画面に戻れる挙動を維持する)。viewMode の復元は FileViewer 側
  // (path 一致時のみ) が担う。
  const selectedPath = state.sessionTrees.get(sid)?.selectedPath ?? null;
  useEffect(() => {
    if (!active || tab !== "files" || selectedPath !== null) return;
    const saved = loadFilesView(sid);
    if (saved) replaceNavigation(fileHref(sid, saved.path));
  }, [active, sid, tab, selectedPath]);

  // 保存 record の mount-time sweep (OneOnOneComposer の draft sweep と同じ
  // 2 規則: peers 不在 sid / 10 日超非アクティブ)。peers が hydrate する前
  // (空) は比較対象がないので待つ — 以降の peers 増減では再実行しない
  // (mount あたり 1 回で十分、再訪時にまた走る)。
  useEffect(() => {
    if (state.peers.length > 0) cleanupStaleFilesViews(state);
  }, [state.peers.length]);

  const sessionStatus = state.sessionStatuses.get(sid);

  return (
    <main ref={rootRef} class="session-view" hidden={!active} data-session-id={sid}>
      <div class="session-tabs">
        {/* Every tab is a location (`#s<sid>...`), so they are links — a tab
         * you can middle-click into a second window is worth more here than
         * one that only flips state. Timeline stays present-but-disabled when
         * the session declares no transcript: its absence would silently
         * change the shape of the row between sessions.
         *
         * Order (kawaz r46 mid=9,11 / r26 mid=66): Terminal sits next to
         * Timeline (similar views adjacent, "Rooms の隣は変"), Rooms last.
         *
         * kawaz r38 mid=7: Status stays a link even while a sub-agent TL is
         * open (= state.currentAgent set) — navigating to `statusHref(sid)`
         * clears currentAgent, which a <button> could not do; the tab
         * resolution above (`state.currentAgent ? "timeline" : ...`) would
         * keep forcing "timeline" otherwise. */}
        <Tabs
          class="session-tabs-list"
          tabClass="session-tab"
          label="セッションの表示"
          selected={tab}
          items={sessionTabItems(sid, hasTranscript, hasTerminal)}
        />
        <button
          type="button"
          class={"session-pin-toggle" + (state.pinnedSessions.has(sid) ? " active" : "")}
          aria-pressed={state.pinnedSessions.has(sid)}
          aria-label={state.pinnedSessions.has(sid) ? "ピン解除" : "ピン留め"}
          title={state.pinnedSessions.has(sid) ? "ピン解除" : "ピン留め"}
          onClick={() =>
            store.dispatch({ type: "pinned/toggled", hit: pinCandidate(state, sid, tree) })
          }
        >
          {state.pinnedSessions.has(sid) ? "⭐" : "☆"}
        </button>
      </div>
      {visitedTabs.current.has("files") ? (
        <div class="session-tab-panel" hidden={tab !== "files"} data-session-tab="files">
          <FilesPanes
            sid={sid}
            tree={tree}
            peer={peer}
            externalFiles={sessionStatus?.external_files ?? []}
            workspaceFolders={sessionStatus?.workspace_folders ?? []}
          />
        </div>
      ) : null}
      {visitedTabs.current.has("timeline") ? (
        <div class="session-tab-panel" hidden={tab !== "timeline"} data-session-tab="timeline">
          {hasTranscript ? (
            (() => {
              const graph = sessionStatus?.agent_tree;
              return graph &&
                (graph.teammates.length > 0 ||
                  graph.agents.length > 0 ||
                  graph.workflows.length > 0) ? (
                <TimelinePanes
                  sid={sid}
                  agentTree={graph}
                  timeline={tree.timeline}
                  search={tree.timelineSearch}
                  sessionStatus={sessionStatus}
                  agent={agent}
                  active={active}
                  visible={active && tab === "timeline"}
                />
              ) : (
                <Timeline
                  sid={sid}
                  timeline={tree.timeline}
                  search={tree.timelineSearch}
                  sessionStatus={sessionStatus}
                  agent={agent}
                  active={active}
                  visible={active && tab === "timeline"}
                />
              );
            })()
          ) : (
            <p id="empty-state">このセッションは transcript を申告していません</p>
          )}
        </div>
      ) : null}
      {visitedTabs.current.has("terminal") && hyouiSessionId && terminalGatewayUrl ? (
        <div class="session-tab-panel" hidden={tab !== "terminal"} data-session-tab="terminal">
          <TerminalPanel hyouiSessionId={hyouiSessionId} gatewayUrl={terminalGatewayUrl} />
        </div>
      ) : null}
      {visitedTabs.current.has("status") ? (
        <div class="session-tab-panel" hidden={tab !== "status"} data-session-tab="status">
          {hasStatusFeed ? (
            <StatusPanel
              snapshot={sessionStatus}
              sid={sid}
              onKill={(opts) => ws.sessionKill(sid, opts)}
              onLoadEnv={() => ws.sessionEnv(sid)}
            />
          ) : hasTranscript ? (
            <p id="empty-state">
              Status は接続中のセッションのみ表示できます (このセッションは ccmsg 未接続)
            </p>
          ) : (
            <p id="empty-state">このセッションは transcript を申告していません</p>
          )}
        </div>
      ) : null}
      {visitedTabs.current.has("rooms") ? (
        <div class="session-tab-panel" hidden={tab !== "rooms"} data-session-tab="rooms">
          <SessionRooms sid={sid} state={state} />
        </div>
      ) : null}
      {/* DR-0014 §2.6 floating 1on1 composer. kawaz r46 m44 (2026-07-23):
       * セッション選択中は tab (files/timeline/status/rooms/terminal) に
       * よらず常時表示する — position:fixed の floating FAB なので裏のタブ
       * コンテンツと干渉しない。tab 切替を跨いでも同じ OneOnOneComposer
       * instance が生き続けるので、書きかけ text / attachments state も
       * 保たれる (関連: draft は localStorage 保存 §2.6)。
       * kawaz r26 mid=65: ccmsg 未接続セッション (pinned/仮想閲覧、agents-only
       * 行) では 1on1 送信先が存在しないため FAB 自体を出さない — daemon 側
       * でも配送不能なのでガード。 */}
      {peer ? <OneOnOneComposer sid={sid} state={state} /> : null}
    </main>
  );
}
