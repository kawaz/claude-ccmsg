// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useMemo, useRef, useState } from "preact/hooks";
import { type SessionPermit, type SessionSay, type SessionStatusSnapshot } from "@ccmsg/protocol";
import { type TimelineState } from "../../store.ts";
import { type AgentRef, agentTimelineHref, timelineHref } from "../../locator.ts";
import { useApp } from "../../context.ts";
import { sameJson, useStoreState } from "../../useStore.ts";
import { SayBubble, SayCallBubble } from "../TimelineItem.tsx";
import { TurnResponding } from "./TurnResponding.tsx";
import { useNow } from "../../useNow.ts";
import { useScrollHold } from "../../useScrollHold.ts";
import { miniSummaryLines, respondingSince } from "../../session-status-view.ts";
import { ContextLine } from "../RequestOverridePicker.tsx";
import { agentEngineLabelsByName, agentSayerLabel } from "../agent-tree-view.ts";
import {
  protocolSkewWarning,
  sessionRuntimeParts,
  staleClientWarning,
  type SessionRuntime,
} from "../../utils.ts";
import { hostClaudeVersion, lastSessionClaudeVersion } from "../../sidebar-globals.ts";
import { ccmsgUnitKey, type Segment } from "../../transcript-model.ts";
import { type FilePathResolveCtx } from "../../filepath-ref.ts";
import { hasTranslatorApi, type HostTranslateRequest } from "../../translate.ts";
import { forkDividerGroupIndex } from "../../fork-divider.ts";
import { SearchBar } from "../SearchBar.tsx";
import { TimelineToolbarBadges } from "./TimelineToolbarBadges.tsx";
import { badgeHref } from "../../notification-badges.ts";
import { replaceNavigation } from "../../navigation.ts";
import { ErrorView } from "../ErrorView.tsx";
import { useAutoOpenSettings } from "./useAutoOpenSettings.ts";
import { useSidePanel } from "./useSidePanel.ts";
import { useTimelineFolds } from "./useTimelineFolds.ts";
import { useForkOrigin } from "./useForkOrigin.ts";
import { useLiveTailSubscription } from "./useLiveTailSubscription.ts";
import { useTranscriptLoader } from "./useTranscriptLoader.ts";
import { useSayRead } from "./useSayRead.ts";
import { usePermitReadAll } from "./usePermitReadAll.ts";
import { useFilterScroll } from "./useFilterScroll.ts";
import { firstRowScrollAnchor, holdScrollAnchor } from "./scrollAnchor.ts";
import { useNotificationList } from "./useNotificationList.ts";
import { PermitRequestBubble } from "./PermitRequestBubble.tsx";
import { slotsByTime } from "../../time-slots.ts";
import { useTranscriptModel } from "./useTranscriptModel.ts";
import { useInViewSearch } from "./useInViewSearch.ts";
import { usePositionLanding, usePositionPin } from "./usePositionPin.ts";
import { useStickToBottom } from "./useStickToBottom.ts";
import { useUserTurnNav } from "./useUserTurnNav.ts";
import { useSelectionContainment } from "./useSelectionContainment.ts";
import {
  ItemRawContext,
  AgentEngineLabelsContext,
  AgentTimelineHrefsContext,
  FileToolSidContext,
  SessionFilePathCtxContext,
  TimelineAutoOpenContext,
  FoldOpenContext,
  type CcmsgRenderCtxValue,
  CcmsgRenderContext,
} from "./context.ts";
import { ItemRawToggle } from "./raw.tsx";
import { MemoFoldGroup } from "./folds.tsx";
import { BashRunCard } from "./tools.tsx";
import { type TranslationAvailability } from "./translation.ts";
import {
  UserPromptBubble,
  type BubbleActions,
  AssistantBubble,
  ApiErrorNotice,
} from "./bubbles.tsx";
import { CcmsgBubble } from "./ccmsg.tsx";
import { ForkDivider } from "./actions.tsx";

/** 過去分を読み込んだ後の画面: above は今の先頭の行を画面上で動かさず、below は
 * TL の最上部 (読み込んだ分の最も古い行がボタンの直下に来る)。 */
type OlderPlacement = "above" | "below";

/** TL の最上部に左から並べる順。 */
const OLDER_PLACEMENTS: readonly OlderPlacement[] = ["above", "below"];

const OLDER_LABELS: Record<OlderPlacement, string> = {
  above: "↑過去分を上に読み込む↑",
  below: "↓過去分を下に読み込む↓",
};

export function Timeline({
  sid,
  timeline,
  search,
  sessionStatus,
  agent,
  active,
  visible,
}: {
  sid: string;
  timeline: TimelineState;
  search: { queryText: string; caseSensitive: boolean; regex: boolean };
  /** DR-0025 Phase 2: when present, the pane targets the named subagent /
   * workflow-agent / teammate transcript under `sid` instead of `sid`'s own.
   * All transcriptRead calls forward the agent params; transcript_subscribe
   * is skipped (agent transcripts have no live push, DR-0025 §2.2). Store's
   * `applyLocatorChanged` clears the sid's TimelineState whenever the agent
   * ref changes, so the initial-load effect refetches without needing an
   * agent-keyed cache. */
  agent?: AgentRef | null;
  /** DR-0020 §2.1 TL 下ミニパネル用の folded status snapshot — subscribe の
   * ライフサイクル自体は SessionView が Status タブと共有して管理する
   * (このコンポーネントは受け取って要約を出すだけ)。undefined = まだ届いて
   * いない (subscribe 直後のごく短い間) — パネル自体を隠す (下の
   * miniSummaryLines 呼び出し前にガード)。 */
  sessionStatus: SessionStatusSnapshot | undefined;
  active: boolean;
  /** Timeline タブが実際に画面に出ているか (`active` はセッション単位なので、
   * Files タブを見ている間も true のまま)。タブ往復では Timeline は unmount
   * されず scroller の scrollTop が残るため、「Timeline タブをクリックした
   * のに途中/一番上のまま」になる (kawaz r76 m47)。head 表示への遷移は
   * 「最新を見たい」意図なので、可視化された瞬間に末尾へ寄せ直す。 */
  visible: boolean;
}) {
  const { store, ws } = useApp();
  const currentPosition = useStoreState(store, (s) =>
    s.currentSid === sid ? (s.timelinePosition ?? "head") : "head",
  );
  // Which bubble kind the Timeline shows alone (DR-0050 §4). The URL only
  // carries it for the session's own Timeline, never an agent's.
  const currentFilter = useStoreState(store, (s) =>
    s.currentSid === sid && !agent ? s.timelineFilter : null,
  );
  const hostTranslatorAvailable = useStoreState(store, (s) => s.hostTranslatorAvailable);
  const plamoTranslateUrl = useStoreState(store, (s) => s.plamoTranslateUrl);
  const peers = useStoreState(store, (s) => s.peers);
  // What the session runs as, for the end of the ctx line: its process
  // (uptime, Claude Code version), its ccmsg, and the host's Claude Code
  // version the process's is compared with.
  const sessionRuntime = useStoreState(
    store,
    (s): SessionRuntime => {
      const row = s.agents.find((candidate) => candidate.sessionId === sid);
      const peer = s.peers.find((p) => p.sid === sid);
      // A refused (major-off) client is the session's stale sidecar: its own
      // version is the one to show, not the working process's.
      const stale = peer ? staleClientWarning(peer) : null;
      const ccmsgVersion = stale ? peer?.stale_client?.version : peer?.ccmsg_version;
      const skew = stale ?? protocolSkewWarning(peer?.protocol, s.daemonInfo?.protocol);
      return {
        ...(row
          ? {
              process: {
                startedAt: row.startedAt,
                ...(row.version !== undefined ? { version: row.version } : {}),
              },
            }
          : {}),
        ...(ccmsgVersion !== undefined ? { ccmsgVersion } : {}),
        ...(skew !== null ? { clientWarning: { text: skew.text, tone: skew.tone } } : {}),
        hostClaudeVersion: hostClaudeVersion(
          lastSessionClaudeVersion(s.agents),
          s.hostClaudeVersion,
        ),
      };
    },
    sameJson,
  );
  const rooms = useStoreState(store, (s) => s.rooms);
  const agentActive = !!(agent && (agent.agentId || agent.teammate));
  const pin = usePositionPin({ sid, currentPosition, currentFilter, agentActive });

  // browser は mount 時の feature detect、host は WS hello 後の daemon
  // capability probe、plamo は hello の URL への `/health` (DR-0049)。両方を同じ値オブジェクトに束ねて下位コンポーネントへ渡す。
  const browserTranslatorAvailable = useMemo(() => hasTranslatorApi(), []);
  // 1 op = 1 英語段落: 各 ThinkingSegment の host 翻訳が独立に
  // ws.translate([paragraph]) を送り、segment ごとに完了した順で反映される
  // (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  const hostTranslateRequest = useMemo<HostTranslateRequest>(
    () => (texts) => ws.translate(texts),
    [ws],
  );
  const translationAvailability = useMemo<TranslationAvailability>(
    () => ({
      host: hostTranslatorAvailable,
      browser: browserTranslatorAvailable,
      hostRequest: hostTranslateRequest,
      ...(plamoTranslateUrl !== null ? { plamoUrl: plamoTranslateUrl } : {}),
    }),
    [hostTranslatorAvailable, browserTranslatorAvailable, hostTranslateRequest, plamoTranslateUrl],
  );
  // msg 時刻の相対時間表示 ("3h10m") 用の雑更新 tick (kawaz r17 mid=30):
  // 3 分おきの再描画で十分。
  const now = useNow();

  // agentKey identifies *which* subagent this drilldown Timeline belongs to,
  // for the per-agent auto-open storage key — agentId is the primary
  // identity, runId/teammate are fallbacks for refs that only carry those.
  const agentKey = agent?.agentId ?? agent?.runId ?? agent?.teammate;
  const autoOpen = useAutoOpenSettings({ sid, agentKey, agentActive });
  const tlLinesRef = useRef<HTMLDivElement | null>(null);
  const sidePanel = useSidePanel(tlLinesRef);
  useLiveTailSubscription({ sid, active, agentActive, timeline });
  useSelectionContainment();
  const forkOrigin = useForkOrigin({ sid, active, agentActive });
  const loader = useTranscriptLoader({ sid, agent, active, timeline });

  const { parsed, groups, boundaries, visibleCcmsgKeys, ccmsgTargets, itemRawLookup } =
    useTranscriptModel(timeline);
  // Null whenever the seam is outside the loaded window, so paging older is
  // what makes the divider appear rather than anything here.
  const forkDividerIndex = useMemo(
    () => forkDividerGroupIndex(groups, forkOrigin?.boundary_uuid),
    [groups, forkOrigin?.boundary_uuid],
  );
  const folds = useTimelineFolds(autoOpen.revision, groups);
  // A subagent's or teammate's say is drawn here too, at its time (DR-0050
  // §10): its row is in the agent's own transcript, so the daemon hands it.
  // An agent's Timeline draws its own says from its transcript instead.
  const allAgentSays = useStoreState(store, (s) => s.agentSays);
  const agentSays = useMemo(
    () => (agent ? [] : allAgentSays.filter((say) => say.session_id === sid)),
    [agent, allAgentSays, sid],
  );
  const agentSaySlots = useMemo(() => slotsByTime(groups, agentSays), [groups, agentSays]);
  // Under the 🔔 / 🔐 filter, every say / request for permission of the
  // session is shown (DR-0050 §5): the ones neither in the loaded window nor
  // among the workers' says above come from the daemon's list of them, at
  // their time. They are the filter's only, as they have no row here: taking
  // the filter off takes them out.
  const notificationList = useNotificationList({ sid, filter: agent ? null : currentFilter });
  const listedSays = useMemo((): readonly SessionSay[] => {
    if (currentFilter !== "say" || notificationList === undefined) return [];
    const drawn = new Set(agentSays.map((say) => say.tool_use_id));
    for (const boundary of boundaries) if (boundary?.kind === "say") drawn.add(boundary.toolUseId);
    return notificationList.says.filter((say) => !drawn.has(say.tool_use_id));
  }, [currentFilter, notificationList, agentSays, boundaries]);
  const listedSaySlots = useMemo(() => slotsByTime(groups, listedSays), [groups, listedSays]);
  const listedPermits = useMemo((): readonly SessionPermit[] => {
    if (currentFilter !== "permit" || notificationList === undefined) return [];
    const drawn = new Set<string>();
    for (const boundary of boundaries) {
      if (boundary?.kind === "permit") drawn.add(boundary.toolUseId);
    }
    return notificationList.permits.filter((permit) => !drawn.has(permit.tool_use_id));
  }, [currentFilter, notificationList, boundaries]);
  const listedPermitSlots = useMemo(
    () => slotsByTime(groups, listedPermits),
    [groups, listedPermits],
  );
  const mergedSayIds = useMemo(
    () => [...agentSays, ...listedSays].map((say) => say.tool_use_id),
    [agentSays, listedSays],
  );
  const sayRead = useSayRead({ sid, agentTimeline: !!agent, boundaries, mergedSayIds });
  const shownPermitIds = useMemo(
    () => [
      ...boundaries.flatMap((boundary) =>
        boundary?.kind === "permit" ? [boundary.toolUseId] : [],
      ),
      ...listedPermits.map((permit) => permit.tool_use_id),
    ],
    [boundaries, listedPermits],
  );
  const permitReadAll = usePermitReadAll({ shownIds: shownPermitIds });
  // フィルタ中の末尾の「全て既読」(DR-0050 §4) が既読にするもの: そのフィルタに
  // 出ている未読の say / 許可依頼。フィルタの無い間は無い (ボタンは隠れる)。
  const readAll =
    currentFilter === "say"
      ? { ids: sayRead.shownUnread, onRead: () => sayRead.markRead(sayRead.shownUnread) }
      : currentFilter === "permit"
        ? { ids: permitReadAll.unread, onRead: permitReadAll.markRead }
        : null;
  // The bubbles merged in by time before one group, in the order they were
  // made: the workers' says, and the filter's says and requests outside the
  // window.
  const bubbleNodes = (slot: number) =>
    [
      ...(listedPermitSlots[slot] ?? []).map((permit) => ({
        ts: permit.ts,
        node: listedPermitNode(permit),
      })),
      ...(agentSaySlots[slot] ?? []).map((say) => ({ ts: say.ts, node: mergedSayNode(say) })),
      ...(listedSaySlots[slot] ?? []).map((say) => ({
        ts: say.ts,
        node: mergedSayNode(say, { filterOnly: true }),
      })),
    ]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .map((item) => item.node);
  // The bubble of a say merged in by its time (a subagent's or teammate's, or
  // one outside the window): the say bubble the window's says use, with who
  // said it in its label's row when a worker did. It answers to the 🔔
  // filter; it is not a row of the window, so it carries no position. One
  // that is the filter's only says so (`data-filter-only`), so the scroll
  // kept on taking the filter off does not hold on to it.
  const mergedSayNode = (say: SessionSay, { filterOnly = false } = {}) => (
    <div
      key={`${filterOnly ? "listed" : "agent"}-say-${say.tool_use_id}`}
      class="tl-item"
      data-notif="say"
      data-filter-only={filterOnly ? "say" : undefined}
    >
      <SayCallBubble
        text={say.text}
        ts={say.ts}
        now={now}
        read={sayRead.readState(say.tool_use_id)}
        {...(say.agent_id !== undefined
          ? { sender: agentSayerLabel(sessionStatus?.agent_tree, say.agent_id) }
          : {})}
      />
    </div>
  );
  // The bubble of a request for permission outside the window (the 🔐
  // filter's only): the bubble the window's requests use. It is not a row of
  // the window, so it carries no position.
  const listedPermitNode = (permit: SessionPermit) => (
    <div
      key={`listed-permit-${permit.tool_use_id}`}
      class="tl-item"
      data-notif="permit"
      data-filter-only="permit"
    >
      <PermitRequestBubble
        request={{
          sid,
          toolUseId: permit.tool_use_id,
          ts: permit.ts,
          cwd: permit.cwd,
          permit: permit.permit,
        }}
        now={now}
        translationAvailability={translationAvailability}
      />
    </div>
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Every jump that should survive later growth (tail follow, pin landing,
  // search reveal, refresh, ⤓) goes through this instead of a one-off
  // scrollTop write; see useScrollHold.ts.
  const scrollHold = useScrollHold(scrollRef, tlLinesRef);
  useFilterScroll({ filter: currentFilter, position: currentPosition, scrollRef, scrollHold });

  const inViewSearch = useInViewSearch({
    sid,
    search,
    filtered: currentFilter !== null,
    groups,
    ccmsgTargets,
    openFoldsAt: folds.openFoldsAt,
    foldMountRevision: folds.mountRevision,
    scrollHold,
  });
  const searchCtx = inViewSearch.searchCtx;

  const userNav = useUserTurnNav({ sid, agent, groups, end: timeline.end, scrollRef });
  // assistant バブルのハンバーガーから開く、選択中の項目に対する dump
  // (BubbleActions)。項目クリックで付く位置選択 (`/timeline/<uuid>`) を
  // そのまま入力に使う。agent TL は位置選択を URL で表せない
  // (selectPosition が no-op) ので渡さない = ハンバーガーを出さない。
  const bubbleActions = useMemo<BubbleActions | undefined>(
    () =>
      agentActive
        ? undefined
        : {
            sid,
            position: currentPosition,
            onSelect: pin.selectPosition,
          },
    [sid, currentPosition, pin.selectPosition, agentActive],
  );

  // 末尾追従と位置への着地は、位置の状態 (pin.tracker) を戻り値で共有する。
  // scroller を測る (最下部なら位置を外す / 読書位置を覚える) のはスクロール
  // が起きた時だけなので、着地との間に宣言順の取り決めは無い。
  const stick = useStickToBottom({
    sid,
    end: timeline.end,
    atHead: currentPosition === "head",
    visible,
    content: groups,
    scrollRef,
    scrollHold,
    onScrollMeasured: pin.onScrollMeasured,
    onUserScrollIntent: pin.onUserScrollIntent,
  });
  usePositionLanding({
    sid,
    currentPosition,
    currentFilter,
    timelineStatus: timeline.status,
    parsed,
    scrollRef,
    scrollHold,
    tracker: pin.tracker,
  });

  // フィルタに該当するバブルが 1 つも無いか (§5)。say は daemon の一覧が
  // 届くまで決めない (届く前に「ありません」と出して、すぐ消すことになる)。
  const filterEmpty =
    currentFilter === "say"
      ? notificationList !== undefined &&
        agentSays.length === 0 &&
        listedSays.length === 0 &&
        !boundaries.some((b) => b?.kind === "say" || b?.kind === "push-notification")
      : currentFilter === "permit"
        ? notificationList !== undefined &&
          listedPermits.length === 0 &&
          !boundaries.some((b) => b?.kind === "permit")
        : false;

  // 「更新」= tail の読み直しなので、完了後は末尾へ (kawaz r17 mid=26)。
  // replace で end が同値のままだと追記の追従が発火しないため、ここで明示的に
  // 飛ばし、更新直後に届く live tail への追従も続けさせる。
  function refresh() {
    void loader.refresh()?.then(stick.resumeFollowing);
  }

  // 過去分は今の先頭の行の上に足される。読み込んだ後の画面は押したボタンで
  // 決まり、内容が伸びるたびに保ち直す (useScrollHold.ts) ので、読み込んだ行が
  // 描かれた後にずれた分だけ戻る。
  // - above (上に読み込む): ボタンの直下にあった今の先頭の行を、押した時の距離
  //   のまま動かさない (scrollAnchor.ts)。読み込んだ分はその上 (画面の外) に
  //   入り、遡って読み上げる。
  // - below (下に読み込む): TL の最上部に寄せて留める。読み込んだ分の最も古い
  //   行がボタンの直下に来て、上から順に読み進める。押した時に少しスクロール
  //   していても最上部へ: 読み込んで先頭に届けばボタン自体が消えて位置がずれる
  //   ので、押した時の位置を保つ意味が薄い。
  // 押した方のボタンだけを「読み込み中…」にする (読み込みが済んだら戻す)。
  const [olderPressed, setOlderPressed] = useState<OlderPlacement | null>(null);
  function loadOlder(placement: OlderPlacement) {
    const scroller = scrollRef.current;
    const lines = tlLinesRef.current;
    const anchor =
      placement === "above" && scroller && lines ? firstRowScrollAnchor(scroller, lines) : null;
    const read = loader.loadOlder();
    if (read === null) return;
    if (placement === "below") scrollHold.toTop();
    else if (anchor !== null) holdScrollAnchor(anchor, scrollHold);
    setOlderPressed(placement);
    void read.finally(() => setOlderPressed(null));
  }

  // フィルタを外す: ツールバーの選択中のバッジを押した時と同じ URL へ、同じく
  // 履歴を積まずに移る (DR-0050 §4)。
  function leaveFilter() {
    if (currentFilter === null) return;
    replaceNavigation(
      badgeHref(sid, currentFilter, { position: currentPosition, filter: currentFilter }),
    );
  }

  // behavior 指定なし = "auto" = 即座にジャンプ (kawaz r17 mid=54: smooth
  // エフェクトはウザいので削除)。
  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0 });
  }

  function scrollToBottom() {
    scrollHold.toBottom();
  }

  // TL 下ミニパネル (DR-0020 §2.1、issue 2026-07-17 #1/#5 で拡張): 走行中
  // 走行中 workflow の要約に加え、context 消費と活動中
  // teammates の要約行も含む (miniSummaryLines 参照)。ゼロ件 (snapshot 未着
  // 含む) ならパネル自体を出さない仕様 ("ゼロ件なら非表示")。
  // What the overrides put on the session's main-thread requests (DR-0041
  // §5), the same in every tab.
  const requestOverride = useStoreState(store, (s) => s.requestOverrides.get(sid), sameJson);
  const miniLines = sessionStatus
    ? miniSummaryLines(sessionStatus, sessionRuntimeParts(sessionRuntime, now), requestOverride)
    : [];
  // The session's own Timeline only: an agent's is not the main thread's turn.
  const respondingAt = agent ? null : respondingSince(sessionStatus);
  const agentTimelineHrefs = useMemo(() => {
    const hrefs = new Map<string, string>();
    if (!sessionStatus) return hrefs;

    const teammateNames = new Set<string>();
    for (const teammate of sessionStatus.teammates ?? []) {
      teammateNames.add(teammate.name);
      hrefs.set(teammate.name, agentTimelineHref(sid, { teammate: teammate.name }));
    }

    const ambiguousWorkflowNames = new Set<string>();
    for (const workflow of sessionStatus.workflows) {
      if (!workflow.run_id) continue;
      for (const workflowAgent of workflow.agents ?? []) {
        const name = workflowAgent.label;
        if (!name || teammateNames.has(name) || ambiguousWorkflowNames.has(name)) continue;
        if (hrefs.has(name)) {
          hrefs.delete(name);
          ambiguousWorkflowNames.add(name);
          continue;
        }
        hrefs.set(
          name,
          agentTimelineHref(sid, {
            runId: workflow.run_id,
            agentId: workflowAgent.agent_id,
          }),
        );
      }
    }
    return hrefs;
  }, [sessionStatus, sid]);

  const agentEngineLabels = useMemo(
    () => agentEngineLabelsByName(sessionStatus?.agent_tree),
    [sessionStatus],
  );

  // filepath 解決 ctx は「この pane が表示しているセッション自身」の cwd/
  // repo_root を使う (kawaz r46m62、TL は自セッションの発言表示なので発言者
  // = 自分)。peer 行がまだ届いていない (WS 接続直後などの短い間) は
  // undefined になり、LinkedMarkdownView がプレーンな MarkdownView に degrade
  // する — 同じ経路を ROOM 側 (filePathCtxForSender で送信者未解決時) も
  // 使っているので挙動は揃う。
  const selfPeer = useMemo(() => peers.find((p) => p.sid === sid), [peers, sid]);
  const sessionFilePathCtx = useMemo<FilePathResolveCtx | undefined>(
    () =>
      selfPeer
        ? { sid, cwd: selfPeer.cwd, repoRoot: selfPeer.repo_root, repo: selfPeer.repo }
        : undefined,
    [sid, selfPeer],
  );
  // r55 m14: peer 発 ccmsg は boundary から外れて fold group 内 (LineView →
  // PeerCcmsgLineView) で CcmsgBubble を描画するため、boundary 側 (下の
  // groups.map) と fold-group 側が **同一の可視 key 集合** (visibleCcmsgKeys、
  // 上の分類フェーズで確定) を参照する。どちらの経路も読むだけなので、
  // fold の開閉が何度起きても判定は変わらない。
  // Memoized because a context value is the one prop `memo` can't intercept:
  // a new object here re-renders every ccmsg bubble in the transcript, past
  // the memoized fold groups that would otherwise have been skipped.
  const ccmsgRenderValue = useMemo<CcmsgRenderCtxValue>(
    () => ({ now, rooms, peers, visibleCcmsgKeys }),
    [now, rooms, peers, visibleCcmsgKeys],
  );
  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  const agentLabel = agent
    ? agent.teammate
      ? `teammate ${agent.teammate}`
      : agent.runId
        ? `${agent.runId}/${agent.agentId}`
        : `${agent.agentId}`
    : null;
  return (
    <FileToolSidContext.Provider value={sid}>
      <SessionFilePathCtxContext.Provider value={sessionFilePathCtx}>
        <AgentTimelineHrefsContext.Provider value={agentTimelineHrefs}>
          <AgentEngineLabelsContext.Provider value={agentEngineLabels}>
            <TimelineAutoOpenContext.Provider value={autoOpen.context}>
              <FoldOpenContext.Provider value={folds.store}>
                <CcmsgRenderContext.Provider value={ccmsgRenderValue}>
                  <ItemRawContext.Provider value={itemRawLookup}>
                    <div
                      class="timeline-view"
                      ref={scrollRef}
                      style={{ "--tl-float-reserve": `${sidePanel.reserve}px` }}
                    >
                      {agentLabel ? (
                        <div class="tl-agent-header">
                          <span class="tl-agent-header-label">agent: {agentLabel}</span>
                          <a class="tl-agent-header-back" href={timelineHref(sid)}>
                            親セッションへ戻る
                          </a>
                        </div>
                      ) : null}
                      <div class="tl-toolbar">
                        {agent ? null : <TimelineToolbarBadges sid={sid} />}
                        <>
                          <SearchBar
                            words={inViewSearch.words}
                            queryText={search.queryText}
                            onQueryChange={(queryText) => inViewSearch.changeSearch({ queryText })}
                            caseSensitive={search.caseSensitive}
                            onToggleCaseSensitive={() =>
                              inViewSearch.changeSearch({ caseSensitive: !search.caseSensitive })
                            }
                            regexMode={search.regex}
                            onToggleRegex={() =>
                              inViewSearch.changeSearch({ regex: !search.regex })
                            }
                            matchCount={inViewSearch.matchCount}
                            currentIndex={inViewSearch.currentIndex}
                            onPrev={inViewSearch.prev}
                            onNext={inViewSearch.next}
                            hasError={inViewSearch.hasError}
                            targets={{
                              user: inViewSearch.targets.user,
                              onToggleUser: inViewSearch.targets.toggleUser,
                              ai: inViewSearch.targets.ai,
                              onToggleAI: inViewSearch.targets.toggleAI,
                              ccmsg: inViewSearch.targets.ccmsg,
                              onToggleCcmsg: inViewSearch.targets.toggleCcmsg,
                            }}
                            foldScope={{
                              searchClosedFolds: inViewSearch.foldScope.searchClosedFolds,
                              onToggle: inViewSearch.foldScope.toggle,
                            }}
                          />
                          <div class="tl-user-nav">
                            <button
                              type="button"
                              class="tl-user-nav-count"
                              disabled={
                                currentFilter !== null ||
                                userNav.currentIndex <= 0 ||
                                userNav.keys.length === 0
                              }
                              onClick={userNav.scrollToCurrent}
                              title="現在のユーザ発言へ戻る"
                            >
                              👤 {userNav.currentIndex}/{userNav.keys.length}
                            </button>
                            {/* disabled のみ「ユーザ発言が 1 件も無い」を基準にする — 境界での
                             * disabled (旧 currentUserIdx<=1 / >=length) は DR-0022 §2.2 の
                             * ループ仕様と両立しない (ループするボタンを境界で押せなくしては
                             * 意味がない)。 */}
                            <button
                              type="button"
                              disabled={currentFilter !== null || userNav.keys.length === 0}
                              onClick={userNav.goPrev}
                              title="前のユーザ発言へ"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={currentFilter !== null || userNav.keys.length === 0}
                              onClick={userNav.goNext}
                              title="次のユーザ発言へ"
                            >
                              ↓
                            </button>
                          </div>
                        </>
                        <button type="button" onClick={scrollToTop} title="最上部へ">
                          ⤒
                        </button>
                        <button type="button" onClick={scrollToBottom} title="最下部へ">
                          ⤓
                        </button>
                      </div>
                      {timeline.atStart ? null : (
                        <div class="tl-load-older">
                          {OLDER_PLACEMENTS.map((placement) => (
                            <button
                              key={placement}
                              type="button"
                              class="tl-wide-button"
                              data-placement={placement}
                              disabled={timeline.status === "loading"}
                              onClick={() => loadOlder(placement)}
                            >
                              {timeline.status === "loading" && olderPressed === placement
                                ? "読み込み中…"
                                : OLDER_LABELS[placement]}
                            </button>
                          ))}
                        </div>
                      )}
                      {timeline.status === "error" ? (
                        <ErrorView
                          mark="!"
                          tone="danger"
                          title="transcript を読み込めませんでした"
                          detail={timeline.error}
                          action={{ label: "再試行 (tail から読み直す)", onClick: refresh }}
                        />
                      ) : (
                        <div
                          class="tl-lines"
                          ref={tlLinesRef}
                          data-filter={currentFilter ?? undefined}
                        >
                          {parsed.length === 0 ? (
                            <p class="tl-empty">(空の transcript)</p>
                          ) : (
                            <>
                              {sayRead.readError !== null ? (
                                <p class="tl-say-error">{sayRead.readError}</p>
                              ) : null}
                              {permitReadAll.readError !== null ? (
                                <p class="tl-say-error">{permitReadAll.readError}</p>
                              ) : null}
                              {filterEmpty ? (
                                <p class="tl-filter-empty">
                                  {currentFilter === "say"
                                    ? "say はありません"
                                    : "許可依頼はありません"}
                                </p>
                              ) : null}
                              {groups
                                .map((group, i) => {
                                  if (group.kind === "fold") {
                                    return (
                                      <MemoFoldGroup
                                        key={group.entries[0].offset}
                                        entries={group.entries}
                                        translationAvailability={translationAvailability}
                                        searchCtx={searchCtx}
                                      />
                                    );
                                  }
                                  const { line, offset } = group;
                                  // line.kind !== "turn" (meta/broken) は classifyBoundaryLine が
                                  // 絶対に boundary と判定しない (groupTimelineLines がそれらを
                                  // fold group に送るので groups の "entry" 側には来ない) —
                                  // ここでの line.kind==="turn" ガードは型ナローイングのためだが、
                                  // 実データ上も自明に成り立つ。
                                  if (line.kind !== "turn") return null;
                                  // boundaries[i] は上の useMemo で groups と同じ index で
                                  // 計算済み (render のたびの再分類を避けるため)。
                                  const boundary = boundaries[i];
                                  if (boundary === undefined || boundary === null) return null;
                                  switch (boundary.kind) {
                                    case "user-prompt":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                        >
                                          <UserPromptBubble
                                            line={line}
                                            offsetKey={offset}
                                            navKey={`user:${offset}`}
                                            registerUserTurnRef={userNav.registerUserTurnRef}
                                            translationAvailability={translationAvailability}
                                            now={now}
                                            searchCtx={searchCtx}
                                            onUserTurnClick={userNav.onUserTurnClick}
                                            selected={userNav.selectedKey === `user:${offset}`}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "assistant-response":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                        >
                                          <AssistantBubble
                                            line={line}
                                            offset={offset}
                                            translationAvailability={translationAvailability}
                                            now={now}
                                            searchCtx={searchCtx}
                                            actions={bubbleActions}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "api-error":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                        >
                                          <ApiErrorNotice line={line} />
                                        </ItemRawToggle>
                                      );
                                    case "bash-command":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                        >
                                          <BashRunCard
                                            command={boundary.segment.command}
                                            output={boundary.segment.output}
                                            ts={line.ts}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "bash-command-output":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                        >
                                          <BashRunCard
                                            command={null}
                                            output={boundary.segment}
                                            ts={line.ts}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "push-notification":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                          notif="say"
                                        >
                                          <SayBubble
                                            label="PushNotification"
                                            text={boundary.text}
                                            ts={line.ts ?? ""}
                                            now={now}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "say":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                          notif="say"
                                        >
                                          <SayCallBubble
                                            text={boundary.text}
                                            ts={line.ts ?? ""}
                                            now={now}
                                            read={sayRead.readState(boundary.toolUseId)}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "permit":
                                      return (
                                        <ItemRawToggle
                                          key={offset}
                                          offset={offset}
                                          uuid={line.uuid}
                                          selectedPosition={currentPosition === line.uuid}
                                          onSelectPosition={pin.selectPosition}
                                          notif="permit"
                                        >
                                          <PermitRequestBubble
                                            request={{
                                              sid,
                                              toolUseId: boundary.toolUseId,
                                              ts: line.ts ?? "",
                                              cwd: boundary.cwd,
                                              permit: boundary.permit,
                                            }}
                                            now={now}
                                            translationAvailability={translationAvailability}
                                          />
                                        </ItemRawToggle>
                                      );
                                    case "ccmsg": {
                                      // raw タブ用の「この行に何が書いてあったか」:
                                      // extractCcmsgMessages が読むのと同じ text segment 結合
                                      // (subscribe / teammate-message wrapper の原文はそこにある)。
                                      const rawText = line.segments
                                        .filter(
                                          (s): s is Extract<Segment, { kind: "text" }> =>
                                            s.kind === "text",
                                        )
                                        .map((s) => s.text)
                                        .join("\n");
                                      return boundary.messages
                                        .map((m, j) => {
                                          if (!visibleCcmsgKeys.has(ccmsgUnitKey(offset, j)))
                                            return null;
                                          const navKey = `ccmsg:${offset}:${j}`;
                                          return (
                                            <ItemRawToggle
                                              key={`${offset}-${j}`}
                                              offset={offset}
                                              uuid={line.uuid}
                                              selectedPosition={currentPosition === line.uuid}
                                              onSelectPosition={pin.selectPosition}
                                            >
                                              <CcmsgBubble
                                                message={m}
                                                rawText={rawText}
                                                now={now}
                                                searchKey={ccmsgUnitKey(offset, j)}
                                                searchCtx={searchCtx}
                                                navKey={
                                                  userNav.keySet.has(navKey) ? navKey : undefined
                                                }
                                                registerUserTurnRef={userNav.registerUserTurnRef}
                                                onUserTurnClick={userNav.onUserTurnClick}
                                                selected={userNav.selectedKey === navKey}
                                                room={rooms.get(m.room)}
                                                peers={peers}
                                              />
                                            </ItemRawToggle>
                                          );
                                        })
                                        .filter((n) => n !== null);
                                    }
                                  }
                                })
                                // Index-aligned with `groups` on both counts: the seam
                                // splices in ahead of the first group of forked-off
                                // history, and each slot's permission bubbles ahead of
                                // the first group that is newer than them.
                                .flatMap((node, i) => [
                                  ...bubbleNodes(i),
                                  ...(i === forkDividerIndex && forkOrigin
                                    ? [<ForkDivider key="fork-divider" origin={forkOrigin} />, node]
                                    : [node]),
                                ])}
                              {/* 読み込み済み window より新しい許可依頼 (= 依頼した turn の行が
                                まだ jsonl に無い live のケース) は末尾に出す。 */}
                              {bubbleNodes(groups.length)}
                              <TurnResponding
                                key={sid}
                                since={respondingAt}
                                onAbort={() => ws.turnAbort(sid)}
                              />
                            </>
                          )}
                          {/* フィルタ中の最後のバブルの下 (DR-0050 §4) に「全て既読」、
                           * その下に「TL に戻る」。「全て既読」は普通のボタン (幅は
                           * 文字の分)、「TL に戻る」は押すとそこに TL が現れるので
                           * 横幅いっぱい。外しても同じ要素のまま隠すだけにして、§6 の
                           * 位置合わせが測る DOM を外す前と同じに保つ。 */}
                          <button
                            type="button"
                            class="tl-filter-read-all"
                            hidden={readAll === null}
                            disabled={readAll === null || readAll.ids.length === 0}
                            onClick={readAll?.onRead}
                          >
                            全て既読
                          </button>
                          <button
                            type="button"
                            class="tl-wide-button tl-filter-back"
                            hidden={currentFilter === null}
                            onClick={leaveFilter}
                          >
                            TL に戻る
                          </button>
                        </div>
                      )}
                      <div
                        ref={sidePanel.panelRef}
                        class={`tl-auto-open-float${sidePanel.open ? " tl-auto-open-float-open" : ""}`}
                      >
                        <button
                          type="button"
                          class="tl-auto-open-handle"
                          aria-label={sidePanel.open ? "パネルを閉じる" : "パネルを開く"}
                          aria-expanded={sidePanel.open}
                          onClick={sidePanel.toggle}
                        >
                          {sidePanel.open ? "›" : "‹"}
                        </button>
                        <div class="tl-float-body">
                          <fieldset
                            class="tl-auto-open"
                            aria-label="自動オープンする Timeline カテゴリ"
                          >
                            <legend>auto open</legend>
                            {(["U", "R", "C", "T", "A", "E"] as const).map((category) => {
                              const fixed = category === "U" || category === "R";
                              // C/T/A/E の checkbox 表示状態と toggle 対象キーの対応。
                              // U/R は境界要素なので常に表示 (fixed)。
                              const settingKey =
                                category === "C"
                                  ? "ccmsg"
                                  : category === "T"
                                    ? "thinking"
                                    : category === "E"
                                      ? "edit"
                                      : "agent";
                              return (
                                <label
                                  key={category}
                                  title={fixed ? "常に表示" : `${category} を自動オープン`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={fixed ? true : autoOpen.settings[settingKey]}
                                    disabled={fixed}
                                    onChange={() => {
                                      if (!fixed) autoOpen.toggle(settingKey);
                                    }}
                                  />
                                  {category}
                                </label>
                              );
                            })}
                            <span class="tl-auto-open-separator" aria-hidden="true" />
                            <label title="C/T/A/E を含む外側の fold を自動オープン">
                              <input
                                type="checkbox"
                                checked={autoOpen.settings.items}
                                onChange={() => autoOpen.toggle("items")}
                              />
                              N items
                            </label>
                          </fieldset>
                        </div>
                      </div>
                      <div class="tl-bottom-controls">
                        {/* 非対話 (kawaz r135m37): FAB と重なる位置にあり、
                         * ボタンだと誤クリックで Status タブへ飛ぶ事故が多い。
                         * 表示はそのまま残し、クリック導線だけ塞ぐ。 */}
                        {miniLines.length > 0 ? (
                          <div class="tl-status-mini">
                            {miniLines.map((line) =>
                              line.context ? (
                                <ContextLine
                                  key={line.kind}
                                  line={line.context}
                                  state={requestOverride}
                                  context={sessionStatus?.context}
                                  onChange={(patch) => ws.requestOverride(sid, patch)}
                                />
                              ) : (
                                <span
                                  key={`${line.kind}-${line.text}`}
                                  class={`tl-status-mini-line tl-status-mini-${line.kind}`}
                                >
                                  {line.text}
                                </span>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </ItemRawContext.Provider>
                </CcmsgRenderContext.Provider>
              </FoldOpenContext.Provider>
            </TimelineAutoOpenContext.Provider>
          </AgentEngineLabelsContext.Provider>
        </AgentTimelineHrefsContext.Provider>
      </SessionFilePathCtxContext.Provider>
    </FileToolSidContext.Provider>
  );
}
