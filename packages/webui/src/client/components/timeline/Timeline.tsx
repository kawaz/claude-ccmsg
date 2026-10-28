// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useMemo, useRef } from "preact/hooks";
import { type SessionStatusSnapshot } from "@ccmsg/protocol";
import { type TimelineState } from "../../store.ts";
import { type AgentRef, agentTimelineHref, timelineHref } from "../../locator.ts";
import { pushNavigation } from "../../navigation.ts";
import { forkPrefill, prefillSidebarState } from "../../session-creator.ts";
import { useApp } from "../../context.ts";
import { sameJson, useStoreState } from "../../useStore.ts";
import { SayBubble, SayRecordBubble } from "../TimelineItem.tsx";
import { TurnResponding } from "./TurnResponding.tsx";
import { useNow } from "../../useNow.ts";
import { useScrollHold } from "../../useScrollHold.ts";
import { miniSummaryLines, respondingSince } from "../../session-status-view.ts";
import { ContextLine } from "../RequestOverridePicker.tsx";
import { sessionProcessParts } from "../../utils.ts";
import { ccmsgUnitKey, type Segment } from "../../transcript-model.ts";
import { type FilePathResolveCtx } from "../../filepath-ref.ts";
import { hasTranslatorApi, type HostTranslateRequest } from "../../translate.ts";
import { forkActionState, liveChain } from "../../fork-point.ts";
import { forkDividerGroupIndex } from "../../fork-divider.ts";
import { inTimeOrder } from "../../say-merge.ts";
import { SearchBar } from "../SearchBar.tsx";
import { ErrorView } from "../ErrorView.tsx";
import { useAutoOpenSettings } from "./useAutoOpenSettings.ts";
import { useSidePanel } from "./useSidePanel.ts";
import { useTimelineFolds } from "./useTimelineFolds.ts";
import { useForkOrigin } from "./useForkOrigin.ts";
import { useLiveTailSubscription } from "./useLiveTailSubscription.ts";
import { useTranscriptLoader } from "./useTranscriptLoader.ts";
import { useSayBubbles } from "./useSayBubbles.ts";
import { PermitRequestBubble } from "./PermitRequestBubble.tsx";
import { usePermitBubbles } from "./usePermitBubbles.ts";
import { useTranscriptModel } from "./useTranscriptModel.ts";
import { useInViewSearch } from "./useInViewSearch.ts";
import { usePositionLanding, usePositionPin } from "./usePositionPin.ts";
import { useStickToBottom } from "./useStickToBottom.ts";
import { useUserTurnNav } from "./useUserTurnNav.ts";
import { useSelectionContainment } from "./useSelectionContainment.ts";
import {
  ItemRawContext,
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
  const hostTranslatorAvailable = useStoreState(store, (s) => s.hostTranslatorAvailable);
  const launchAvailable = useStoreState(store, (s) => s.launchAvailable);
  const peers = useStoreState(store, (s) => s.peers);
  // The session's process (uptime and Claude Code version for the ctx line).
  const sessionProcess = useStoreState(
    store,
    (s) => {
      const row = s.agents.find((candidate) => candidate.sessionId === sid);
      if (!row) return undefined;
      return {
        startedAt: row.startedAt,
        ...(row.version !== undefined ? { version: row.version } : {}),
      };
    },
    sameJson,
  );
  const rooms = useStoreState(store, (s) => s.rooms);
  const agentActive = !!(agent && (agent.agentId || agent.teammate));
  const pin = usePositionPin({ sid, currentPosition, agentActive });

  // browser は mount 時の feature detect、host は WS hello 後の daemon
  // capability probe。両方を同じ値オブジェクトに束ねて下位コンポーネントへ渡す。
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
    }),
    [hostTranslatorAvailable, browserTranslatorAvailable, hostTranslateRequest],
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
  const sayBubbles = useSayBubbles({ sid, agentTimeline: !!agent, groups });
  const says = sayBubbles.says;
  const permitBubbles = usePermitBubbles({ sid, agentTimeline: !!agent, groups });
  // The say and permission bubbles of one slot, in the order they happened.
  const bubbleNodes = (slot: number) =>
    inTimeOrder([
      ...(sayBubbles.slots[slot] ?? []).map((record) => ({
        ts: record.ts,
        node: (
          <SayRecordBubble
            key={`say-${record.id}`}
            record={record}
            now={now}
            readIds={sayBubbles.readTargets(record.id)}
            onRead={sayBubbles.markRead}
          />
        ),
      })),
      ...(permitBubbles.slots[slot] ?? []).map((request) => ({
        ts: request.ts,
        node: <PermitRequestBubble key={`permit-${request.id}`} request={request} now={now} />,
      })),
    ]).map((bubble) => bubble.node);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Every jump that should survive later growth (tail follow, pin landing,
  // search reveal, refresh, ⤓) goes through this instead of a one-off
  // scrollTop write; see useScrollHold.ts.
  const scrollHold = useScrollHold(scrollRef, tlLinesRef);

  const inViewSearch = useInViewSearch({
    sid,
    search,
    groups,
    ccmsgTargets,
    openFoldsAt: folds.openFoldsAt,
    foldMountRevision: folds.mountRevision,
    scrollHold,
  });
  const searchCtx = inViewSearch.searchCtx;

  const userNav = useUserTurnNav({ sid, agent, groups, end: timeline.end, scrollRef });
  // 側面パネルの「アクション」タブが選択中の項目に対して出せるもの。項目
  // クリックで付く位置選択 (`/timeline/<uuid>`) をそのまま入力に使う —
  // 選択モデルを 2 つ持たないのは 👤 nav に相乗りしていた時と同じ姿勢で、
  // 対象が user turn から「uuid を持つ全項目」に広がっただけ (kawaz r115 m7)。
  // 放棄された分岐上のレコードは resume が読み込まないので fork 地点にできない
  // (実測: `No message found`)。表示はするが fork だけ出さないための判定材料。
  const chain = useMemo(() => liveChain(parsed), [parsed]);
  const forkAction = useMemo(
    () => forkActionState(currentPosition, chain),
    [currentPosition, chain],
  );
  // 同じアクション一式を assistant バブルのハンバーガーからも開ける
  // (BubbleActions)。側面パネルと材料を共有するので、どちらから開いても
  // 「選択中の項目に対する fork / dump」という意味は 1 つのまま。
  // agent TL は位置選択を URL で表せない (selectPosition が no-op) ので
  // 渡さない = ハンバーガーを出さない。
  const bubbleActions = useMemo<BubbleActions | undefined>(
    () =>
      agentActive
        ? undefined
        : {
            sid,
            position: currentPosition,
            forkAction,
            launchAvailable,
            // cwd / model / effort は押した瞬間のこのセッションの値をリンクに
            // 載せる (forkPrefill)。リンクだけで同じフォームが開くように —
            // 貼っても、セッションが切れた後に開き直しても。
            onFork: (resumeAt: string) =>
              pushNavigation(
                `${location.pathname}${location.search}`,
                prefillSidebarState(forkPrefill(store.getState(), sid, resumeAt)),
              ),
            onSelect: pin.selectPosition,
          },
    [sid, currentPosition, forkAction, launchAvailable, pin.selectPosition, agentActive, store],
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
    timelineStatus: timeline.status,
    parsed,
    scrollRef,
    scrollHold,
    tracker: pin.tracker,
  });

  // 「更新」= tail の読み直しなので、完了後は末尾へ (kawaz r17 mid=26)。
  // replace で end が同値のままだと追記の追従が発火しないため、ここで明示的に
  // 飛ばし、更新直後に届く live tail への追従も続けさせる。
  function refresh() {
    void loader.refresh()?.then(stick.resumeFollowing);
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
    ? miniSummaryLines(
        sessionStatus,
        sessionProcess ? sessionProcessParts(sessionProcess, now) : [],
        requestOverride,
      )
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
                      {timeline.atStart ? null : (
                        <button
                          type="button"
                          disabled={timeline.status === "loading"}
                          onClick={loader.loadOlder}
                        >
                          older
                        </button>
                      )}
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
                          onToggleRegex={() => inViewSearch.changeSearch({ regex: !search.regex })}
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
                            disabled={userNav.currentIndex <= 0 || userNav.keys.length === 0}
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
                            disabled={userNav.keys.length === 0}
                            onClick={userNav.goPrev}
                            title="前のユーザ発言へ"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={userNav.keys.length === 0}
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
                    {timeline.status === "error" ? (
                      <ErrorView
                        mark="!"
                        tone="danger"
                        title="transcript を読み込めませんでした"
                        detail={timeline.error}
                        action={{ label: "再試行 (tail から読み直す)", onClick: refresh }}
                      />
                    ) : (
                      <div class="tl-lines" ref={tlLinesRef}>
                        {parsed.length === 0 &&
                        says.length === 0 &&
                        permitBubbles.requests.length === 0 ? (
                          <p class="tl-empty">(空の transcript)</p>
                        ) : (
                          <>
                            {sayBubbles.readError !== null ? (
                              <p class="tl-say-error">{sayBubbles.readError}</p>
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
                                      >
                                        <SayBubble
                                          label="PushNotification"
                                          text={boundary.text}
                                          ts={line.ts ?? ""}
                                          now={now}
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
                              // history, and each slot's say bubbles ahead of the
                              // first group that is newer than them.
                              .flatMap((node, i) => [
                                ...bubbleNodes(i),
                                ...(i === forkDividerIndex && forkOrigin
                                  ? [<ForkDivider key="fork-divider" origin={forkOrigin} />, node]
                                  : [node]),
                              ])}
                            {/* 読み込み済み window より新しい say (= 喋った turn の行が
                                まだ jsonl に無い live のケース) は末尾に出す。 */}
                            {bubbleNodes(groups.length)}
                            <TurnResponding
                              key={sid}
                              since={respondingAt}
                              onAbort={() => ws.turnAbort(sid)}
                            />
                          </>
                        )}
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
        </AgentTimelineHrefsContext.Provider>
      </SessionFilePathCtxContext.Provider>
    </FileToolSidContext.Provider>
  );
}
