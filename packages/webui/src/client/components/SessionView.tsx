// Top-level "session" screen (DR-0008 Files pane, DR-0009 Timeline pane,
// DR-0020 Status tab). Selected via the `#s<sid>[:<path>]` (Files) or
// `#t<sid>` (Timeline) locator (App.tsx routes here instead of RoomView when
// state.view is "session" or "timeline"). Files/Timeline/Rooms/Status all
// share one sid-keyed SessionTreeState cache so switching tabs never
// refetches what's already loaded.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
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
import { hasSessionTranscript } from "../utils.ts";
import { hitFromLive, isSessionPinned, pinnedHitForSid } from "../pinned-sessions.ts";
import { cleanupStaleFilesViews, loadFilesView } from "../files-view-store.ts";
import { useApp } from "../context.ts";
import { useEffectEvent } from "../useEffectEvent.ts";
import { FilesPanes } from "./FilesPanes.tsx";
import { Timeline } from "./Timeline.tsx";
import { TimelinePanes } from "./TimelinePanes.tsx";
import { SessionRooms } from "./SessionRooms.tsx";
import { StatusPanel } from "./StatusPanel.tsx";
import { SessionInputComposer } from "./SessionInputComposer.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { sessionInputReadiness, terminalAbsenceNotice } from "./session-input.ts";
import { Tabs, type TabItem } from "./Tabs.tsx";

/** Shown wherever `hasTranscript` is false. Names all three sources that came
 * up empty (see hasSessionTranscript) and the one way left to open the
 * session, since a sid with no peer, no pinned/searched file and no agents row
 * is one nothing on this screen can resolve to a jsonl. Exported so the style
 * catalog's disabled-tab specimen shows the same words the app does. */
export const NO_TRANSCRIPT_MESSAGE =
  "transcript が見つかりません (ccmsg 未接続 + 実行中セッション一覧にも無し)。Session Search から開き直してください";

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
          title: NO_TRANSCRIPT_MESSAGE,
        },
    ...(hasTerminal
      ? [
          {
            id: "terminal",
            label: "Terminal",
            href: terminalHref(sid),
          } satisfies TabItem<SessionTab>,
        ]
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
  const stored = pinnedHitForSid(state.pinnedSessions, sid) ?? tree.searchHit;
  if (stored) return stored;
  const peer = state.peers.find((item) => item.sid === sid);
  const agent = state.agents.find((item) => item.sessionId === sid);
  return hitFromLive(sid, peer, agent);
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
  // Tabs opened at least once stay mounted (hidden) so switching back keeps
  // their scroll and local state. It remembers earlier renders' tabs, so it is
  // state, brought up to date during render: setting it here re-runs this
  // render before anything is committed.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SessionTab>>(() => new Set([tab]));
  if (!visitedTabs.has(tab)) setVisitedTabs(new Set([...visitedTabs, tab]));
  const rootRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>());

  // This view unmounts only when App's LRU drops the session (App.tsx). Its
  // cached transcript is then released: `SessionTreeState.timeline` is the
  // largest thing the store holds per session (megabytes for a long one) and
  // has no other release path, so keeping it would grow the store by a full
  // transcript for every session ever opened. Nothing is lost — Timeline's
  // revisit effect re-reads the tail on every arrival anyway. The rest of the
  // tree (dir listings, expanded set, selected path) is reused on revisit and
  // stays.
  useEffect(() => () => store.dispatch({ type: "timeline/evicted", sids: [sid] }), [store, sid]);

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
  // 接続中セッションが申告した transcript_path、無ければ sid から解決した
  // `<configDir>/projects/<project>/<sid>.jsonl` (daemon の resolveTranscript
  // allowVirtual)。early return より前 = hooks 位置で要るのでここで引く。
  const peer = state.peers.find((p) => p.sid === sid);
  // Terminal タブは daemon の config.json で terminal_gateway_url が設定されて
  // いるセッションでのみ表示する (issue 2026-07-21, kawaz r46m7)。iframe を出す
  // のは agent の hyoui_session_id が解決済みの時 (無いと iframe の src が組めない)。
  // 「設定していないユーザには存在しない機能」に倒す。
  const agentForSid = sid ? state.agents.find((a) => a.sessionId === sid) : undefined;
  const hyouiSessionId = agentForSid?.hyoui_session_id;
  const terminalGatewayUrl = state.terminalGatewayUrl;
  // 端末が無いと分かっているセッション (daemon の input_readiness が
  // no_terminal / ended) では、タブを出したうえで iframe の代わりに理由と次の
  // 行動を出す。黒いままの iframe では再描画待ちか端末が無いのか見分けが
  // つかない。
  const terminalAbsence = terminalAbsenceNotice(
    sessionInputReadiness(peer, state.sessionStatuses.get(sid)),
  );
  const hasTerminal = !!terminalGatewayUrl && (!!hyouiSessionId || terminalAbsence !== null);
  // Timeline / Status が使えるかの単一ゲート (DR-0021 §2.4/§3.1) — 導出は
  // hasSessionTranscript を見る。agent-only 行 (peer 無し、`claude agents
  // --json` に居る) でも jsonl は読めるので両タブとも出す。Timeline の live
  // tail だけは transcript_subscribe が接続中セッションを要求するため静的
  // read になる (Timeline 自身の refresh ボタンで読み直す)。Status の fold は
  // daemon 側が jsonl を直接 tail するので未接続でも更新が届く。接続したら
  // 5s の agents poll と peers push がこの component を再描画し、通常の
  // subscribe 経路に切り替わる。
  const storedHit = sid
    ? (pinnedHitForSid(state.pinnedSessions, sid) ?? tree.searchHit)
    : undefined;
  const hasTranscript = hasSessionTranscript(peer, storedHit?.file, !!agentForSid);
  // The pin button acts on this session's directory (DR-0021 §2.4): the live
  // peer's cwd when connected, else whatever record the session left. No cwd
  // means nothing to pin, so the button is not shown.
  const candidate = pinCandidate(state, sid, tree);
  const pinCwd = peer?.cwd ?? candidate.cwd;
  const pinHit = { ...candidate, cwd: pinCwd };
  const pinned = isSessionPinned(state.pinnedSessions, pinCwd);
  // Re-hello may keep the same sid while changing transcript/root metadata.
  // Include the concrete fold source in the subscription effect deps so the
  // daemon's subscribe path can invalidate/rebuild its DR-0020/DR-0024 cache.
  // A session with no peer folds from the sid alone (already a dep), so the
  // null here is itself the "virtual source" value — and a later connect flips
  // it to a string, re-subscribing onto the announced path.
  const statusSource = peer?.transcript_path
    ? `${peer.transcript_path}\n${peer.repo_root ?? peer.cwd}`
    : null;

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
  // 購読が失敗した理由。daemon が jsonl を解決できない (session_not_found /
  // not_found) セッションでは snapshot が永久に来ないので、StatusPanel を
  // 「読み込み中…」のまま固まらせずここで理由を出す。購読をやり直すたびに
  // null へ戻す。
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !sid || !needsStatus || !hasTranscript) return;
    if (state.connStatus !== "connected") return;
    setStatusError(null);
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
        if (cancelled) return;
        if (!res.ok) {
          setStatusError(res.error.msg);
          return;
        }
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
            ...(res.input_readiness ? { input_readiness: res.input_readiness } : {}),
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
  }, [active, sid, needsStatus, hasTranscript, statusSource, state.connStatus, store, ws]);

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

  // 保存 record の sweep (session-input-store.ts の下書き sweep と同じ 2 規則:
  // peers 不在 sid / 10 日超非アクティブ)。peers が hydrate する前 (空) は比較
  // 対象がないので待ち、以降は peers の件数が変わるたびに掃除し直す。反応する
  // のは件数だけで、その時点の state は Effect Event で読む。
  const sweepStaleFilesViews = useEffectEvent(() => cleanupStaleFilesViews(state));
  const peerCount = state.peers.length;
  useEffect(() => {
    if (peerCount > 0) sweepStaleFilesViews();
  }, [peerCount]);

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
        {pinCwd ? (
          <button
            type="button"
            class={"session-pin-toggle" + (pinned ? " active" : "")}
            aria-pressed={pinned}
            aria-label={pinned ? "ピン解除" : "ピン留め"}
            title={pinned ? "ピン解除" : "ピン留め"}
            onClick={() => store.dispatch({ type: "pinned/toggled", hit: pinHit })}
          >
            {pinned ? "⭐" : "☆"}
          </button>
        ) : null}
      </div>
      {visitedTabs.has("files") ? (
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
      {visitedTabs.has("timeline") ? (
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
                  key={sid}
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
            <p id="empty-state">{NO_TRANSCRIPT_MESSAGE}</p>
          )}
        </div>
      ) : null}
      {visitedTabs.has("terminal") && hasTerminal ? (
        <div class="session-tab-panel" hidden={tab !== "terminal"} data-session-tab="terminal">
          {terminalAbsence !== null || !hyouiSessionId ? (
            <div class="terminal-pane">
              <p id="empty-state">{terminalAbsence}</p>
            </div>
          ) : (
            <TerminalPanel hyouiSessionId={hyouiSessionId} gatewayUrl={terminalGatewayUrl} />
          )}
        </div>
      ) : null}
      {visitedTabs.has("status") ? (
        <div class="session-tab-panel" hidden={tab !== "status"} data-session-tab="status">
          {hasTranscript && !statusError ? (
            <StatusPanel
              snapshot={sessionStatus}
              sid={sid}
              onKill={(opts) => ws.sessionKill(sid, opts)}
              onLoadEnv={() => ws.sessionEnv(sid)}
            />
          ) : hasTranscript ? (
            <p id="empty-state">Status を読み込めません: {statusError}</p>
          ) : (
            <p id="empty-state">{NO_TRANSCRIPT_MESSAGE}</p>
          )}
        </div>
      ) : null}
      {visitedTabs.has("rooms") ? (
        <div class="session-tab-panel" hidden={tab !== "rooms"} data-session-tab="rooms">
          <SessionRooms sid={sid} state={state} />
        </div>
      ) : null}
      {/* DR-0035 §1 セッション宛の入力欄 (floating)。セッション選択中は tab
       * (files/timeline/status/rooms/terminal) によらず常時表示する —
       * position:fixed の floating FAB なので裏のタブコンテンツと干渉しない。
       * tab 切替を跨いでも同じ instance が生き続けるので、書きかけ text /
       * attachments state も保たれる (draft は localStorage にも保存)。
       * 出す条件は「その sid のセッションが今も生きていること」= peers に居る
       * (ccmsg 接続済み) か `claude agents` に居る (ccmsg 未起動だがプロセスは
       * 動いている)。入力はセッションの hooks module が受けるので、subscribe
       * の有無は関係しない。どちらにも居ない sid (pinned / 仮想閲覧の死んだ
       * セッション) は宛先が存在しないのでガードのまま。 */}
      {peer || agentForSid ? <SessionInputComposer sid={sid} state={state} /> : null}
    </main>
  );
}
