// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { type ComponentChildren } from "preact";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type CommentBlock,
  type CommentRecord,
  type SessionPermit,
  type SessionSay,
  type SessionStatusSnapshot,
} from "@ccmsg/protocol";
import { type TimelineState } from "../../store.ts";
import { type AgentRef, type TimelineFilter, timelineHref } from "../../locator.ts";
import { useApp } from "../../context.ts";
import { sameJson, useStoreState } from "../../useStore.ts";
import { SayBubble, SayCallBubble } from "../TimelineItem.tsx";
import { TurnResponding } from "./TurnResponding.tsx";
import { useNow } from "../../useNow.ts";
import { centerTop, useScrollHold } from "../../useScrollHold.ts";
import { miniSummaryLines, respondingSince } from "../../session-status-view.ts";
import { ContextLine } from "../RequestOverridePicker.tsx";
import {
  agentEngineLabelsByName,
  agentSayerLabel,
  agentTimelineHrefsByName,
  answersNoTurn,
} from "../agent-tree-view.ts";
import {
  indexAgentsBySid,
  protocolSkewWarning,
  sessionRuntimeParts,
  sessionStatus as sessionRowStatus,
  staleClientWarning,
  toSessionRow,
  type SessionRuntime,
} from "../../utils.ts";
import { hostClaudeVersion, lastSessionClaudeVersion } from "../../sidebar-globals.ts";
import {
  ccmsgUnitKey,
  rowUuidIn,
  toolUseRowUuid,
  type BoundaryKind,
  type Segment,
  type TurnLine,
} from "../../transcript-model.ts";
import {
  bookmarkedFoldRows,
  listedBookmarks,
  listedPrompts,
  matchedFoldRows,
  type ListedBookmark,
} from "../../listed-bookmarks.ts";
import { type FilePathResolveCtx } from "../../filepath-ref.ts";
import { forkDividerGroupIndex } from "../../fork-divider.ts";
import { SearchBar } from "../SearchBar.tsx";
import { TimelineToolbarBadges } from "./TimelineToolbarBadges.tsx";
import { PaneTreeToggle } from "../PaneTreeToggle.tsx";
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
import { SearchForm } from "./SearchForm.tsx";
import { firstRowScrollAnchor, holdScrollAnchor, isRendered } from "./scrollAnchor.ts";
import { useNotificationList } from "./useNotificationList.ts";
import { PermitRequestBubble } from "./PermitRequestBubble.tsx";
import { useBookmarkRows } from "./useBookmarkRows.ts";
import { usePromptRows } from "./usePromptRows.ts";
import { useItemInView, useTailInView } from "./useItemInView.ts";
import { type PromptStepTargets } from "./PromptSteps.tsx";
import { MergedItem } from "./bookmark.tsx";
import { slotsByTime } from "../../time-slots.ts";
import { anchoredSlots, placedBtws, type PlacedBtw } from "../../btw-slots.ts";
import {
  commentBlocksOfLine,
  commentCounts,
  commentOnOfResponse,
  commentOnOfCcmsg,
  commentItemShown,
  commentShowTokens,
  commentPlaceRow,
  deliveredOutside,
  listedDrafts,
  pendingComments,
  placedDrafts,
  repliesOutside,
  sendAllItems,
  threadResolved,
  unsentComments,
  type CommentItemKind,
  type PlacedComment,
  type PlacedDraft,
  type PlacedReply,
} from "../../comment-view.ts";
import {
  CommentBubble,
  CommentFormFloat,
  CommentReplyRecordBubble,
  CommentsFilterHead,
  CommentTargetScope,
  itemCommentTarget,
  TimelineCommentsContext,
  useCommentShow,
  type CommentTarget,
  type TimelineComments,
} from "./comments.tsx";
import { SessionCommentsContext } from "./comment-context.ts";
import { useSessionCommentsState } from "../session-comments.ts";
import { SelectionToolbar } from "./comment-quotes.tsx";
import { BtwCommentBubble } from "./BtwCommentBubble.tsx";
import { DraftBubble } from "./draft-queue.tsx";
import { threadPlaces, type ListedItem, type ThreadPlace } from "../../comment-threads.ts";
import { useTranscriptModel } from "./useTranscriptModel.ts";
import { useInViewSearch } from "./useInViewSearch.ts";
import { usePositionLanding, usePositionPin } from "./usePositionPin.ts";
import { useStickToBottom } from "./useStickToBottom.ts";
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
  TimelineScrollHoldContext,
  TimelineBookmarksContext,
  TimelineFilterContext,
  TimelinePositionContext,
  type TimelineBookmarks,
  type TimelinePosition,
} from "./context.ts";
import { ItemRawToggle } from "./raw.tsx";
import { LineView, MemoFoldGroup } from "./folds.tsx";
import { BashRunCard } from "./tools.tsx";
import { useTranslationAvailability } from "./translation.ts";
import {
  MemoUserPromptBubble,
  type BubbleActions,
  MemoAssistantBubble,
  CommentReplyBubble,
  ApiErrorNotice,
  WaitingNotice,
} from "./bubbles.tsx";
import { CcmsgBubble } from "./ccmsg.tsx";
import { ForkDivider } from "./actions.tsx";
import { DayBand, DayGapMark, TurnIdleMark } from "./DayMarks.tsx";
import { useDayJump } from "./useDayJump.ts";
import { peerRepoSlug, peerWorkspaceLabel } from "../../peer-location.ts";
import { sessionBookmarkForSid, sessionBookmarkTitle } from "../../session-bookmarks.ts";
import {
  groupMarkKey,
  lastRowTime,
  localDayOf,
  shownItems,
  slotBubbleKey,
  slotBubbles,
  useDayMarks,
  type SlotBubble,
} from "./useDayMarks.ts";

/** What one row draws as, as an item of the Timeline (Timeline's itemBodies). */
interface ItemBody {
  /** Its key among the Timeline's items. */
  key: string;
  /** Its jsonl toggle and star stand just above it (a user's prompt, a
   * bubble at the right whose top right corner is its text). */
  controlsAbove: boolean;
  /** The filters that keep it shown (DR-0050 §5). */
  notifs?: readonly TimelineFilter[];
  /** What a comment on it is on (DR-0062 §2), when it can be commented on. */
  commentTarget?: CommentTarget;
  /** Its key among the 💬 filter's items (comment-threads.ts), when it is
   * one of them. */
  placeKey?: string;
  node: ComponentChildren;
}

/** No comments: what an agent's Timeline holds of them. */
const NO_COMMENTS: ReadonlyMap<string, CommentRecord> = new Map();

/** What a comment replying to the comment `cid` is on (DR-0062 §2). */
function replyTarget(cid: string): CommentTarget {
  return { key: `c:${cid}`, anchor: { kind: "comment", cid } };
}

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
  /** DR-0025 §6: when present, the pane targets the named subagent /
   * workflow-agent / teammate transcript under `sid` instead of `sid`'s own.
   * All transcriptRead calls and the transcript_subscribe forward the agent
   * params, so the pane reads and follows the agent's transcript live. Store's
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
  const peers = useStoreState(store, (s) => s.peers);
  // Whether the session is Waiting, by the sidebar's own reading of its row
  // (DR-0059): the session's Timeline only, since an agent's is not where the
  // session's dialog is.
  const waiting = useStoreState(store, (s) => {
    if (agent) return false;
    const peer = s.peers.find((p) => p.sid === sid);
    if (!peer) return false;
    const row = s.agents.find((candidate) => candidate.sessionId === sid);
    const agentsBySid = indexAgentsBySid(row ? [row] : []);
    return sessionRowStatus(toSessionRow(peer, agentsBySid, s.sessionErrors)) === "waiting";
  });
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

  const translationAvailability = useTranslationAvailability();
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
  useLiveTailSubscription({ sid, active, agent: agent ?? null, timeline });
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Every jump that should survive later growth (tail follow, pin landing,
  // search reveal, refresh, ⤓) goes through this instead of a one-off
  // scrollTop write; see useScrollHold.ts.
  const scrollHold = useScrollHold(scrollRef);
  useFilterScroll({ filter: currentFilter, position: currentPosition, scrollRef, scrollHold });

  const inViewSearch = useInViewSearch({
    sid,
    search,
    filtered: currentFilter !== null && currentFilter !== "search",
    stepping: !!agent,
    groups,
    ccmsgTargets,
    openFoldsAt: folds.openFoldsAt,
    foldMountRevision: folds.mountRevision,
    scrollHold,
  });
  const searchCtx = inViewSearch.searchCtx;

  // A subagent's or teammate's say is drawn here too, at its time (DR-0050
  // §10): its row is in the agent's own transcript, so the daemon hands it.
  // An agent's Timeline draws its own says from its transcript instead.
  const allAgentSays = useStoreState(store, (s) => s.agentSays);
  const agentSays = useMemo(
    () => (agent ? [] : allAgentSays.filter((say) => say.session_id === sid)),
    [agent, allAgentSays, sid],
  );
  const agentSaySlots = useMemo(() => slotsByTime(groups, agentSays), [groups, agentSays]);
  // The session's comments (DR-0062 §12, §13). An agent's Timeline has none
  // (§2): its items are not commented on.
  const sessionComments = useStoreState(store, (s) => (agent ? undefined : s.comments.get(sid)));
  const commentThreads = useStoreState(store, (s) =>
    agent ? undefined : s.commentThreads.get(sid),
  );
  const commentRecords = sessionComments ?? NO_COMMENTS;
  const commentCountMap = useMemo(() => commentCounts(commentRecords.values()), [commentRecords]);
  // The person's prompts in the window that are comments sent, by offset:
  // drawn as their comment bubbles (§12).
  const commentRows = useMemo(() => {
    const rows = new Map<number, CommentBlock[]>();
    if (agent) return rows;
    groups.forEach((group, i) => {
      if (group.kind !== "entry" || group.line.kind !== "turn") return;
      if (boundaries[i]?.kind !== "user-prompt") return;
      const blocks = commentBlocksOfLine(group.line);
      if (blocks !== null) rows.set(group.offset, blocks);
    });
    return rows;
  }, [agent, groups, boundaries]);
  // The agent's replies in the window (§12): the rows of their
  // `comment_reply` calls, by the reply's cid.
  const replyRows = useMemo(() => {
    const rows = new Map<string, { offset: number; uuid: string | undefined }>();
    if (agent) return rows;
    groups.forEach((group, i) => {
      const boundary = boundaries[i];
      if (group.kind !== "entry" || group.line.kind !== "turn") return;
      if (boundary?.kind !== "comment-reply") return;
      rows.set(boundary.cid, { offset: group.offset, uuid: group.line.uuid });
    });
    return rows;
  }, [agent, groups, boundaries]);
  // The rows the 💬 filter shows: the comments sent and the agent's replies.
  const commentRowOffsets = useMemo(
    () => new Set([...commentRows.keys(), ...[...replyRows.values()].map((row) => row.offset)]),
    [commentRows, replyRows],
  );
  // The comments sent whose row is not in the window yet are drawn from their
  // records where they were sent (§11); under the 💬 filter the unsent ones
  // too, where they belong (P10).
  const windowCommentCids = useMemo(
    () => new Set([...commentRows.values()].flat().map((block) => block.comment)),
    [commentRows],
  );
  const commentPendingSlots = useMemo(
    () =>
      anchoredSlots(
        groups,
        pendingComments(commentRecords.values()).filter(
          (placed) => !windowCommentCids.has(placed.comment.cid),
        ),
        (placed: PlacedComment) => placed.after,
        (placed: PlacedComment) => placed.ts,
        timeline.atStart,
      ),
    [groups, commentRecords, windowCommentCids, timeline.atStart],
  );
  // The btw comments (§12, §14): the question with its answer, where it was
  // sent (what its fork read up to). Under the 💬 filter the unsent ones too,
  // and none out of sight (one older than the window at its top), as the
  // unsent comments are.
  const btwCommentSlots = useMemo(
    () =>
      anchoredSlots(
        groups,
        placedBtws(commentRecords.values(), currentFilter === "comment"),
        (placed: PlacedBtw) => placed.after,
        (placed: PlacedBtw) => placed.ts,
        currentFilter === "comment" || timeline.atStart,
      ),
    [groups, commentRecords, currentFilter, timeline.atStart],
  );
  // Every unsent one is drawn (one older than the window at its top), as it
  // is sent from where it is shown (§13): none is placed out of sight.
  const commentUnsentSlots = useMemo(
    () =>
      anchoredSlots(
        groups,
        currentFilter === "comment"
          ? unsentComments(commentRecords, (cid) => replyRows.get(cid)?.uuid)
          : [],
        (placed: PlacedComment) => placed.after,
        (placed: PlacedComment) => placed.ts,
        true,
      ),
    [groups, commentRecords, currentFilter, replyRows],
  );
  // The FAB's drafts not seen arriving yet (§15), under the 💬 filter among
  // the comments, where they were written (sent) as the unsent comments are.
  const sessionDrafts = useStoreState(store, (s) => (agent ? undefined : s.promptDrafts.get(sid)));
  const draftList = useMemo(() => listedDrafts(sessionDrafts), [sessionDrafts]);
  const draftSlots = useMemo(
    () =>
      anchoredSlots(
        groups,
        currentFilter === "comment" ? placedDrafts(draftList) : [],
        (placed: PlacedDraft) => placed.after,
        (placed: PlacedDraft) => placed.ts,
        true,
      ),
    [groups, draftList, currentFilter],
  );
  // Under the 💬 filter, the comments outside the window too (§13, P10), at
  // their time: the delivered ones whose row is not read, and the ones not
  // seen yet that stand before the window.
  const commentListedSlots = useMemo(() => {
    if (currentFilter !== "comment") return slotsByTime<PlacedComment>(groups, []);
    const placed = new Set(commentPendingSlots.flat().map((p) => p.comment.cid));
    return slotsByTime(groups, [
      ...deliveredOutside(commentRecords.values(), windowCommentCids),
      ...pendingComments(commentRecords.values()).filter(
        (p) => !windowCommentCids.has(p.comment.cid) && !placed.has(p.comment.cid),
      ),
    ]);
  }, [currentFilter, groups, commentRecords, windowCommentCids, commentPendingSlots]);
  // Under the 💬 filter, the agent's replies outside the window too, from
  // their records at their time (§13, P10).
  const commentReplyListedSlots = useMemo(
    () =>
      slotsByTime<PlacedReply>(
        groups,
        currentFilter === "comment"
          ? repliesOutside(commentRecords.values(), new Set(replyRows.keys()))
          : [],
      ),
    [currentFilter, groups, commentRecords, replyRows],
  );
  // The one comment form open (DR-0062 §3), the item whose 💬 was pressed
  // (its comments are the selected ones under the 💬 filter, §12), and
  // what the 💬 filter's head shows (§13: not kept, as it was each time the
  // filter is entered).
  // The form and the selection are the session's screen's, shared with its
  // Files (a comment on a file opens the same one form, and its 💬 selects
  // here).
  const ownSessionComments = useSessionCommentsState(undefined, undefined);
  const commentHost = useContext(SessionCommentsContext) ?? ownSessionComments;
  const commentForm = commentHost.form;
  const openCommentForm = commentHost.openForm;
  const closeCommentForm = commentHost.closeForm;
  const selectedAsked = commentHost.selected;
  const selectedComments = selectedAsked?.value ?? null;
  const setSelectedComments = commentHost.select;
  const [commentShow, setCommentShow] = useCommentShow([sid, currentFilter]);
  // What 全部送信 sends: the unsent ones shown (§13), the comments first.
  const sendAll = useMemo(
    () => sendAllItems(commentRecords, commentThreads, draftList, commentShow),
    [commentRecords, commentThreads, draftList, commentShow],
  );
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
  // The session's bookmarks (DR-0058): the items' ☆ / ⭐, and under the ⭐
  // filter the bookmarked items, those outside the window from the rows the
  // daemon reads for them (useBookmarkRows), at their time. An agent's
  // Timeline has none: its items select no position to come back to.
  const bookmarkUuids = useStoreState(store, (s) => (agent ? undefined : s.bookmarks.get(sid)));
  const marked = useMemo(() => new Set(bookmarkUuids ?? []), [bookmarkUuids]);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const bookmarks = useMemo<TimelineBookmarks | null>(
    () =>
      agent
        ? null
        : {
            marked,
            set: (uuid, on) => {
              void ws
                .bookmarkSet(sid, uuid, on)
                .then((res) => setBookmarkError(res.ok ? null : res.error.msg))
                .catch(() =>
                  setBookmarkError("接続エラーのためブックマークを変えられませんでした"),
                );
            },
          },
    [agent, marked, ws, sid],
  );
  const bookmarkRows = useBookmarkRows({
    sid,
    filter: agent ? null : currentFilter,
    uuids: bookmarkUuids,
  });
  const windowUuids = useMemo(
    () => new Set(parsed.flatMap((line) => (line.kind === "turn" && line.uuid ? [line.uuid] : []))),
    [parsed],
  );
  const listedBookmarkItems = useMemo(
    (): readonly ListedBookmark[] =>
      currentFilter !== "bookmark"
        ? []
        : [
            ...(bookmarkRows === undefined
              ? []
              : listedBookmarks(bookmarkRows, marked, windowUuids)),
            ...bookmarkedFoldRows(groups, marked),
          ],
    [currentFilter, bookmarkRows, marked, windowUuids, groups],
  );
  const listedBookmarkSlots = useMemo(
    () => slotsByTime(groups, listedBookmarkItems),
    [groups, listedBookmarkItems],
  );
  // The person's prompts in the window, in order: the items drawn as the bubble
  // at the right that are positions (the 👤 filter's kind). An agent's
  // Timeline has none of the session's (DR-0054 §10, DR-0058 §3).
  const windowPrompts = useMemo((): readonly string[] => {
    if (agent) return [];
    return groups.flatMap((group, i) =>
      group.kind === "entry" &&
      group.line.kind === "turn" &&
      group.line.uuid !== undefined &&
      boundaries[i]?.kind === "user-prompt"
        ? [group.line.uuid]
        : [],
    );
  }, [agent, groups, boundaries]);
  // Under the 👤 filter, the person's prompts outside the window too (DR-0058
  // §11), from the rows the daemon reads as possible prompts, at their time.
  // While older rows are left unread, the same rows put the window's prompts in
  // the session's whole order, for the 「↑前 | 次↓」 (DR-0058 §3).
  const promptRows = usePromptRows({
    sid,
    filter: agent ? null : currentFilter,
    outsideWindow: !agent && parsed.length > 0 && !timeline.atStart,
  });
  // The prompts before the window, in the file's order (parsed once per answer).
  const promptRowsListed = useMemo(
    () => (promptRows === undefined ? undefined : listedPrompts(promptRows, new Set())),
    [promptRows],
  );
  // The session's prompts in order, as far as known: the ones before the
  // window (all older than it: the window reaches the transcript's end), then
  // the window's. `olderKnown` is false while the rows before the window are
  // not in, when the window's first prompt has no known previous one.
  const promptOrder = useMemo(() => {
    const older =
      timeline.atStart || promptRowsListed === undefined
        ? []
        : promptRowsListed.flatMap((item) => (windowUuids.has(item.uuid) ? [] : [item.uuid]));
    const order = [...older, ...windowPrompts];
    return {
      index: new Map(order.map((uuid, i) => [uuid, i])),
      order,
      olderKnown: timeline.atStart || promptRowsListed !== undefined,
    };
  }, [timeline.atStart, promptRowsListed, windowUuids, windowPrompts]);
  const promptStepsOf = (uuid: string): PromptStepTargets | undefined => {
    const i = promptOrder.index.get(uuid);
    if (i === undefined) return undefined;
    const prev = promptOrder.order[i - 1];
    const next = promptOrder.order[i + 1];
    return {
      prev: prev !== undefined && (i > 0 || promptOrder.olderKnown) ? prev : null,
      next: next ?? null,
      onStep: pin.landOn,
    };
  };
  // The person's newest prompt in the window, for the 「↑最新のプロンプトへ移動↑」
  // at the end (DR-0054 §10). A prompt not read into the window is not looked
  // for.
  const latestPrompt = windowPrompts.at(-1) ?? null;
  const latestPromptInView = useItemInView({
    scrollRef,
    uuid: latestPrompt,
    content: groups,
  });
  // The end of the list in sight or not, for the 「↓先頭に移動↓」 floating at the
  // bottom (DR-0054 §11).
  const tailRef = useRef<HTMLDivElement>(null);
  const tailInView = useTailInView({ scrollRef, tailRef, content: groups });
  const listedPromptItems = useMemo(
    (): readonly ListedBookmark[] =>
      currentFilter !== "prompt" || promptRowsListed === undefined
        ? []
        : promptRowsListed.filter((item) => !windowUuids.has(item.uuid)),
    [currentFilter, promptRowsListed, windowUuids],
  );
  const listedPromptSlots = useMemo(
    () => slotsByTime(groups, listedPromptItems),
    [groups, listedPromptItems],
  );
  // Under the 🔍 filter, the rows the in-view search matched (DR-0022 §3):
  // the window's boundary items stay where they are (the filter's CSS keeps
  // them), and a fold's rows are drawn apart at their time, as ⭐ does.
  const searchHits = inViewSearch.hitOffsets;
  const listedSearchItems = useMemo(
    (): readonly ListedBookmark[] =>
      currentFilter !== "search" ? [] : matchedFoldRows(groups, searchHits),
    [currentFilter, groups, searchHits],
  );
  const listedSearchSlots = useMemo(
    () => slotsByTime(groups, listedSearchItems),
    [groups, listedSearchItems],
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
  // window. Each comes after the marks of its day, when it has any.
  const slots = useMemo(
    () => ({
      listedPermits: listedPermitSlots,
      agentSays: agentSaySlots,
      listedSays: listedSaySlots,
      listedBookmarks: listedBookmarkSlots,
      listedPrompts: listedPromptSlots,
      listedSearch: listedSearchSlots,
      btwComments: btwCommentSlots,
      commentPending: commentPendingSlots,
      commentUnsent: commentUnsentSlots,
      drafts: draftSlots,
      commentListed: commentListedSlots,
      commentReplyListed: commentReplyListedSlots,
    }),
    [
      btwCommentSlots,
      commentPendingSlots,
      commentUnsentSlots,
      draftSlots,
      commentListedSlots,
      commentReplyListedSlots,
      listedPermitSlots,
      agentSaySlots,
      listedSaySlots,
      listedBookmarkSlots,
      listedPromptSlots,
      listedSearchSlots,
    ],
  );
  // Where each item of the 💬 filter stands, by thread (DR-0062 §13, P10):
  // the items in the order drawn (each slot's merged bubbles, then the
  // group's rows of comments and replies), placed by comment-threads.ts.
  const commentPlaces = useMemo(() => {
    if (currentFilter !== "comment") return new Map<string, ThreadPlace>();
    const kindOf = (cid: string): CommentItemKind => {
      const record = commentRecords.get(cid);
      return {
        kind: record?.author === "user" && record.btw ? "btw" : "comment",
        unsent: record?.author === "user" && record.status === "draft",
        resolved: threadResolved(commentRecords, commentThreads, cid),
      };
    };
    const cidItem = (cid: string): ListedItem => ({ key: `c:${cid}`, cid, ...kindOf(cid) });
    const listed: ListedItem[] = [];
    const pushSlot = (slot: number) => {
      for (const bubble of slotBubbles(slot, slots)) {
        switch (bubble.kind) {
          case "btw-comment": {
            const { question, answers } = bubble.item;
            listed.push({
              ...cidItem(question.cid),
              kind: "btw",
              also: answers.map((answer) => answer.cid),
            });
            break;
          }
          case "draft":
            listed.push({
              key: `d:${bubble.item.draft.id}`,
              kind: "draft",
              unsent: bubble.item.draft.status === "queued",
              resolved: false,
            });
            break;
          case "comment-pending":
          case "comment-listed":
          case "comment-unsent":
            listed.push(cidItem(bubble.item.comment.cid));
            break;
          case "comment-reply-listed":
            listed.push(cidItem(bubble.item.reply.cid));
            break;
          default:
            break;
        }
      }
    };
    groups.forEach((group, i) => {
      pushSlot(i);
      if (group.kind !== "entry") return;
      for (const block of commentRows.get(group.offset) ?? []) listed.push(cidItem(block.comment));
      const boundary = boundaries[i];
      if (boundary?.kind === "comment-reply") listed.push(cidItem(boundary.cid));
    });
    pushSlot(groups.length);
    return threadPlaces(listed, commentRecords, commentShow);
  }, [
    currentFilter,
    groups,
    boundaries,
    slots,
    commentRows,
    commentRecords,
    commentThreads,
    commentShow,
  ]);
  const bubbleNode = (bubble: SlotBubble) => {
    switch (bubble.kind) {
      case "listed-permit":
        return listedPermitNode(bubble.item);
      case "agent-say":
        return mergedSayNode(bubble.item);
      case "listed-say":
        return mergedSayNode(bubble.item, { filterOnly: true });
      case "listed-bookmark":
        return listedBookmarkNodes(bubble.item);
      case "listed-prompt":
        return listedPromptNodes(bubble.item);
      case "listed-search":
        return listedSearchNode(bubble.item);
      case "btw-comment": {
        const { question } = bubble.item;
        return (
          <MergedItem
            key={`btw-comment-${question.cid}`}
            notif="comment"
            place={commentPlaces.get(`c:${question.cid}`)}
          >
            <BtwCommentBubble btw={bubble.item} now={now} />
          </MergedItem>
        );
      }
      case "comment-pending": {
        const { comment } = bubble.item;
        return (
          <MergedItem
            key={`comment-pending-${comment.cid}`}
            notif="comment"
            place={commentPlaces.get(`c:${comment.cid}`)}
          >
            <CommentTargetScope target={replyTarget(comment.cid)}>
              <CommentBubble cid={comment.cid} ts={bubble.item.ts} now={now} />
            </CommentTargetScope>
          </MergedItem>
        );
      }
      case "comment-listed": {
        const { comment } = bubble.item;
        const row = comment.row_uuid;
        return (
          <MergedItem
            key={`comment-listed-${comment.cid}`}
            notif="comment"
            filterOnly="comment"
            place={commentPlaces.get(`c:${comment.cid}`)}
            {...(row !== undefined ? { uuid: row, onActivate: () => jumpToRow(row) } : {})}
          >
            <CommentTargetScope target={replyTarget(comment.cid)}>
              <CommentBubble cid={comment.cid} ts={bubble.item.ts} now={now} />
            </CommentTargetScope>
          </MergedItem>
        );
      }
      case "comment-reply-listed": {
        const { reply } = bubble.item;
        return (
          <MergedItem
            key={`comment-reply-listed-${reply.cid}`}
            notif="comment"
            filterOnly="comment"
            place={commentPlaces.get(`c:${reply.cid}`)}
          >
            <CommentTargetScope target={replyTarget(reply.cid)}>
              <CommentReplyRecordBubble reply={reply} now={now} />
            </CommentTargetScope>
          </MergedItem>
        );
      }
      case "comment-unsent":
        return (
          <MergedItem
            key={`comment-unsent-${bubble.item.comment.cid}`}
            notif="comment"
            filterOnly="comment"
            place={commentPlaces.get(`c:${bubble.item.comment.cid}`)}
          >
            <CommentBubble
              cid={bubble.item.comment.cid}
              ts={bubble.item.comment.written.at}
              now={now}
            />
          </MergedItem>
        );
      case "draft":
        return (
          <MergedItem
            key={`draft-${bubble.item.draft.id}`}
            notif="comment"
            filterOnly="comment"
            place={commentPlaces.get(`d:${bubble.item.draft.id}`)}
          >
            <DraftBubble draft={bubble.item.draft} now={now} />
          </MergedItem>
        );
    }
  };
  const bubbleNodes = (slot: number) =>
    slotBubbles(slot, slots).flatMap((bubble) => [
      ...dayMarkNodes(slotBubbleKey(bubble)),
      bubbleNode(bubble),
    ]);
  // The day bands and gaps (DR-0054), decided over the items each view shows
  // (all of them, and each filter's bubbles; an agent's Timeline has no
  // filter), and placed right above the item they belong to.
  const shownAll = useMemo(
    () =>
      shownItems({
        groups,
        boundaries,
        visibleCcmsgKeys,
        slots,
        filter: null,
        marked,
        commentRows: commentRowOffsets,
      }),
    [groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  const shownSay = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "say",
            marked,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  const shownPermit = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "permit",
            marked,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  const shownPrompt = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "prompt",
            marked,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  const shownSearch = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "search",
            marked,
            searchHits,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, searchHits, commentRowOffsets],
  );
  const shownBookmark = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "bookmark",
            marked,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  const shownComment = useMemo(
    () =>
      agent
        ? []
        : shownItems({
            groups,
            boundaries,
            visibleCcmsgKeys,
            slots,
            filter: "comment",
            marked,
            commentRows: commentRowOffsets,
          }),
    [agent, groups, boundaries, visibleCcmsgKeys, slots, marked, commentRowOffsets],
  );
  // Today is the browser's calendar day now. It moves on with the Timeline's
  // own clock (useNow), so the mark of today moves to the next day's band
  // within one of its ticks after midnight.
  const today = localDayOf(now);
  const dayMarks = useDayMarks(
    {
      all: shownAll,
      prompt: shownPrompt,
      search: shownSearch,
      say: shownSay,
      permit: shownPermit,
      bookmark: shownBookmark,
      comment: shownComment,
    },
    today,
  );
  const dayMarkNodes = (key: string) => {
    const marks = dayMarks.above.get(key);
    if (marks === undefined) return [];
    return [
      ...marks.gaps.map(({ gap, views }) => (
        <DayGapMark key={`gap-${views.join("-")}-${key}`} gap={gap} views={views} />
      )),
      <DayBand
        key={marks.bandKey}
        day={marks.day}
        views={marks.band}
        top={marks.top}
        today={marks.day === today}
        onStep={dayJump.step}
      />,
    ];
  };
  // The band of today below the last item, when that item started on an
  // earlier day (DR-0054 §1).
  const tailBandNode = () => {
    const tail = dayMarks.tail;
    if (tail === null) return null;
    return <DayBand key={tail.key} day={tail.day} views={tail.views} today onStep={dayJump.step} />;
  };
  // The bubble of a say merged in by its time (a subagent's or teammate's, or
  // one outside the window): the say bubble the window's says use, with who
  // said it in its label's row when a worker did. It answers to the 🔔
  // filter; it is not a row of the window, so it carries no position. One
  // that is the filter's only says so (`data-filter-only`), so the scroll
  // kept on taking the filter off does not hold on to it; a click on it moves
  // to its row in the Timeline (DR-0058 §6). A worker's say has no row in the
  // session's transcript, so a click on it does nothing.
  const mergedSayNode = (say: SessionSay, { filterOnly = false } = {}) => (
    <MergedItem
      key={`${filterOnly ? "listed" : "agent"}-say-${say.tool_use_id}`}
      notif="say"
      {...(filterOnly
        ? { filterOnly: "say", onActivate: () => jumpToToolUse(say.tool_use_id) }
        : {})}
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
    </MergedItem>
  );
  // The bubble of a request for permission outside the window (the 🔐
  // filter's only): the bubble the window's requests use. It is not a row of
  // the window, so it carries no position; a click on it reads the older
  // pages until its row is in and moves there (DR-0058 §6).
  const listedPermitNode = (permit: SessionPermit) => (
    <MergedItem
      key={`listed-permit-${permit.tool_use_id}`}
      notif="permit"
      filterOnly="permit"
      onActivate={() => jumpToToolUse(permit.tool_use_id)}
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
    </MergedItem>
  );
  // A bookmarked item outside the window (the ⭐ filter's only, DR-0058 §5):
  // the item its row draws as in the window, with its star, and no position
  // or jsonl. A click on it reads the older pages until its row is in and
  // moves there.
  const listedBookmarkNodes = (item: ListedBookmark) =>
    (item.boundary === null || item.line.kind !== "turn"
      ? [
          {
            key: "row",
            controlsAbove: false,
            node: (
              <LineView
                line={item.line}
                offset={item.offset}
                translationAvailability={translationAvailability}
                foldGroupOpen
                searchCtx={undefined}
                bare
              />
            ),
          },
        ]
      : itemBodies(item.boundary, item.line, null)
    ).map((body) => (
      <MergedItem
        key={`listed-bookmark-${item.uuid}-${body.key}`}
        controlsAbove={body.controlsAbove}
        filterOnly="bookmark"
        uuid={item.uuid}
        onActivate={() => jumpToRow(item.uuid)}
      >
        {body.node}
      </MergedItem>
    ));
  // A fold's row the in-view search matched (the 🔍 filter's only, DR-0022
  // §3): the row as the fold draws it, apart, with its matches painted (the
  // copy's units are painted as the window's are). A click on it moves to its
  // row in the Timeline, opening the fold (DR-0058 §2).
  const listedSearchNode = (item: ListedBookmark) => (
    <MergedItem
      key={`listed-search-${item.uuid}`}
      notif="search"
      filterOnly="search"
      uuid={item.uuid}
      onActivate={() => jumpToRow(item.uuid)}
    >
      <LineView
        line={item.line}
        offset={item.offset}
        translationAvailability={translationAvailability}
        foldGroupOpen
        searchCtx={inViewSearch.copySearchCtx}
        bare
      />
    </MergedItem>
  );
  // A prompt of the person's outside the window (the 👤 filter's only,
  // DR-0058 §11): the bubble its row draws as in the window, with its star,
  // and no position or jsonl. A click on it reads the older pages until its
  // row is in and moves there.
  const listedPromptNodes = (item: ListedBookmark) =>
    (item.boundary === null || item.line.kind !== "turn"
      ? []
      : itemBodies(item.boundary, item.line, null)
    ).map((body) => (
      <MergedItem
        key={`listed-prompt-${item.uuid}-${body.key}`}
        controlsAbove={body.controlsAbove}
        notif="prompt"
        filterOnly="prompt"
        uuid={item.uuid}
        onActivate={() => jumpToRow(item.uuid)}
      >
        {body.node}
      </MergedItem>
    ));

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
  // 日付の帯の ↑ / ↓ (DR-0054 §9)。端では ⤒ / ⤓ と同じことをし、前の帯を
  // 探す読み足しは「過去分を上に読み込む」を使う。読者自身のスクロールで探索を
  // 手放す。
  const dayJump = useDayJump({
    sid,
    filter: currentFilter,
    linesRef: tlLinesRef,
    scrollHold,
    loadOlder: () => loadOlder("above"),
    atStart: () => store.getState().sessionTrees.get(sid)?.timeline.atStart === true,
    toTop: scrollToTop,
    toBottom: scrollToBottom,
  });
  const stick = useStickToBottom({
    sid,
    end: timeline.end,
    atHead: currentPosition === "head",
    visible,
    content: groups,
    scrollRef,
    scrollHold,
    onScrollMeasured: pin.onScrollMeasured,
    onUserScrollIntent: () => {
      pin.onUserScrollIntent();
      dayJump.cancel();
    },
  });
  // The rows of the window drawn as items, by uuid: the boundary bubbles and
  // a fold's rows (a position may be either, DR-0058 §2).
  const rowOffsets = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of groups) {
      const entries = group.kind === "fold" ? group.entries : [group];
      for (const { line, offset } of entries) {
        if (line.kind !== "broken" && line.uuid !== undefined) map.set(line.uuid, offset);
      }
    }
    return map;
  }, [groups]);
  const rowOffset = useCallback((uuid: string) => rowOffsets.get(uuid), [rowOffsets]);
  const seek = useStoreState(store, (s) => s.currentSid === sid && !agent && s.timelineSeek);
  // The loader's function is made anew each render; read it through a ref so
  // the landing's effect does not run again for that alone.
  const loaderRef = useRef(loader);
  useLayoutEffect(() => {
    loaderRef.current = loader;
  });
  const seekOlder = useCallback(
    (uuid: string) => loaderRef.current.loadOlderUntil((lines) => rowUuidIn(lines, uuid)),
    [],
  );
  // A position with `seek=true` that the transcript does not have, read to
  // its start (DR-0058 §2): said in one line while the Timeline is at its
  // tail.
  const [missingPosition, setMissingPosition] = useState<string | null>(null);
  usePositionLanding({
    sid,
    currentPosition,
    currentFilter,
    timelineStatus: timeline.status,
    parsed,
    scrollRef,
    scrollHold,
    tracker: pin.tracker,
    rowOffset,
    openFoldsAt: folds.openFoldsAt,
    mountRevision: folds.mountRevision,
    seek,
    seekOlder,
    onMissing: setMissingPosition,
  });

  // 💬 のフィルタに出ているものがあるか: 窓の行のブロック、記録から描く
  // もの、未送信のもの、窓の外のもの、btw、FAB の下書きのうち、ヘッダの
  // チェックボックスで隠れていないもの (DR-0062 §13)。
  const commentOf = (cid: string): CommentItemKind => {
    const record = commentRecords.get(cid);
    return {
      kind: record?.author === "user" && record.btw ? "btw" : "comment",
      unsent: record !== undefined && record.author === "user" && record.status === "draft",
      resolved: threadResolved(commentRecords, commentThreads, cid),
    };
  };
  const commentsShown =
    currentFilter === "comment" &&
    [
      ...[
        ...windowCommentCids,
        ...replyRows.keys(),
        ...[commentPendingSlots, commentUnsentSlots, commentListedSlots].flatMap((slotList) =>
          slotList.flat().map((placed) => placed.comment.cid),
        ),
        ...commentReplyListedSlots.flat().map((placed) => placed.reply.cid),
        ...btwCommentSlots.flat().map((placed) => placed.question.cid),
      ].map(commentOf),
      ...draftSlots.flat().map(
        ({ draft }): CommentItemKind => ({
          kind: "draft",
          unsent: draft.status === "queued",
          resolved: false,
        }),
      ),
    ].some((item) => commentItemShown(commentShow, item));
  // フィルタに該当するバブルが 1 つも無いか (§5)。say は daemon の一覧が
  // 届くまで決めない (届く前に「ありません」と出して、すぐ消すことになる)。
  // ブックマークも daemon の行の答えが届くまで決めない (DR-0058 §5)。
  const filterEmpty =
    currentFilter === "comment"
      ? !commentsShown
      : currentFilter === "search"
        ? searchHits.size === 0
        : currentFilter === "prompt"
          ? promptRows !== undefined &&
            listedPromptItems.length === 0 &&
            !boundaries.some((b) => b?.kind === "user-prompt")
          : currentFilter === "say"
            ? notificationList !== undefined &&
              agentSays.length === 0 &&
              listedSays.length === 0 &&
              !boundaries.some((b) => b?.kind === "say" || b?.kind === "push-notification")
            : currentFilter === "permit"
              ? notificationList !== undefined &&
                listedPermits.length === 0 &&
                !boundaries.some((b) => b?.kind === "permit")
              : currentFilter === "bookmark"
                ? bookmarkRows !== undefined &&
                  listedBookmarkItems.length === 0 &&
                  !groups.some(
                    (group, i) =>
                      group.kind === "entry" &&
                      group.line.kind === "turn" &&
                      group.line.uuid !== undefined &&
                      marked.has(group.line.uuid) &&
                      (boundaries[i] ?? null) !== null,
                  )
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
  // 読み込みが済んだら解決する (読み込めない時は null)。日付の帯の ↑ が前の帯を
  // 探して読み足す時も、上に読み込むこの経路を使う (useDayJump.ts)。
  const [olderPressed, setOlderPressed] = useState<OlderPlacement | null>(null);
  function loadOlder(placement: OlderPlacement): Promise<void> | null {
    const scroller = scrollRef.current;
    const lines = tlLinesRef.current;
    const anchor =
      placement === "above" && scroller && lines ? firstRowScrollAnchor(scroller, lines) : null;
    const read = loader.loadOlder();
    if (read === null) return null;
    if (placement === "below") scrollHold.toTop();
    else if (anchor !== null) holdScrollAnchor(anchor, scrollHold);
    setOlderPressed(placement);
    return read.finally(() => setOlderPressed(null));
  }

  // フィルタの間の項目のクリック (DR-0058 §6、say / 許可依頼 / ブックマークの
  // どのフィルタも): フィルタを外してその項目の行の位置へ移り、TL 表示領域の
  // 一番上に着地させる (外からその位置へ来た時と同じ、DR-0050 §6)。窓の外の
  // 項目は、行が窓に入るまで過去分を 1 ページずつ読む (次のページは前のページが
  // 入ってから)。読み込みの間は行の列を aria-busy にして、どの項目のクリックも
  // 受けない。読み終えた時にまだこのセッションの同じフィルタを見ている時だけ
  // 移る: 読み込みの間に人が移った先から引き戻さない。
  const [jumping, setJumping] = useState(false);
  function jumpTo(find: (lines: readonly string[]) => string | null) {
    if (jumping) return;
    const loaded = find(timeline.lines);
    if (loaded !== null) {
      pin.landOn(loaded);
      return;
    }
    const filter = currentFilter;
    setJumping(true);
    void loader
      .loadOlderUntil(find)
      .then((uuid) => {
        const state = store.getState();
        if (uuid === null || state.currentSid !== sid || state.timelineFilter !== filter) return;
        pin.landOn(uuid);
      })
      .finally(() => setJumping(false));
  }
  function jumpToToolUse(toolUseId: string) {
    jumpTo((lines) => toolUseRowUuid(lines, toolUseId));
  }
  function jumpToRow(uuid: string) {
    jumpTo((lines) => rowUuidIn(lines, uuid));
  }
  // 窓の行の項目のクリック: フィルタの無い間は位置の選択 (と解除)、フィルタの
  // 間はその項目の位置へ移る。
  const onItemClick = currentFilter === null ? pin.selectPosition : jumpToRow;
  // Every item reads the position and the click from one context value, which
  // changes only with the position: the click is read through a ref, so the
  // memoized fold rows are not re-rendered by each render of this Timeline.
  const onItemClickRef = useRef(onItemClick);
  useLayoutEffect(() => {
    onItemClickRef.current = onItemClick;
  });
  const selectItem = useCallback((uuid: string) => onItemClickRef.current(uuid), []);
  const positionValue = useMemo<TimelinePosition>(
    () => ({ position: currentPosition, select: selectItem }),
    [currentPosition, selectItem],
  );
  // What the items read of the session's comments (DR-0062 §12). The move to
  // a comment's place is read through a ref, as the click above, so the value
  // changes only with the comments and the form.
  const jumpToRowRef = useRef(jumpToRow);
  useLayoutEffect(() => {
    jumpToRowRef.current = jumpToRow;
  });
  const jumpToCommentPlace = useCallback((uuid: string) => jumpToRowRef.current(uuid), []);
  // The 💬 of an item pressed (§12): its comments become the selected ones,
  // and once the 💬 filter draws one of them it is brought into view. The
  // person asked for the move, so it is a short smooth one (DR-0056); it runs
  // after the filter's own landing (useFilterScroll), which it replaces.
  const selectionToShowRef = useRef<string | null>(null);
  const selectComments = useCallback(
    (key: string) => setSelectedComments(key),
    [setSelectedComments],
  );
  // Each press (here or in Files) is brought into view once drawn.
  useLayoutEffect(() => {
    if (selectedAsked !== null) selectionToShowRef.current = selectedAsked.value;
  }, [selectedAsked]);
  // Leaving the 💬 filter lets the selection go: entering it again by the
  // toolbar's badge selects nothing.
  const filterBeforeRef = useRef(currentFilter);
  useLayoutEffect(() => {
    const before = filterBeforeRef.current;
    filterBeforeRef.current = currentFilter;
    if (before === "comment" && currentFilter !== "comment") {
      selectionToShowRef.current = null;
      setSelectedComments(null);
    }
  }, [currentFilter, setSelectedComments]);
  useLayoutEffect(() => {
    if (currentFilter !== "comment" || selectionToShowRef.current === null) return;
    const selected = tlLinesRef.current?.querySelector<HTMLElement>("[data-comment-selected]");
    if (selected === null || selected === undefined || !isRendered(selected)) return;
    selectionToShowRef.current = null;
    scrollHold.toElement(selected, centerTop, "user");
  });
  // The bubbles that can be commented on (their regions, comment-quotes.tsx),
  // and the comments whose quote a bubble drawn now does not find again
  // (DR-0062 §2), by region: the 💬 filter says so of them. Changed only when
  // what is lost changes, as each region reports whenever it draws.
  const [commentRegions] = useState(() => new WeakMap<Element, CommentTarget>());
  const [lostByRegion] = useState(() => new Map<Element, readonly string[]>());
  const [lostQuotes, setLostQuotes] = useState<ReadonlySet<string>>(() => new Set());
  const reportLostQuotes = useCallback(
    (region: Element, lost: readonly string[] | null) => {
      if (lost === null || lost.length === 0) lostByRegion.delete(region);
      else lostByRegion.set(region, lost);
      const next = new Set([...lostByRegion.values()].flat());
      setLostQuotes((before) =>
        before.size === next.size && [...next].every((cid) => before.has(cid)) ? before : next,
      );
    },
    [lostByRegion],
  );
  const commentsValue = useMemo<TimelineComments | null>(
    () =>
      agent
        ? null
        : {
            sid,
            records: commentRecords,
            threads: commentThreads,
            counts: commentCountMap,
            form: commentForm,
            openForm: openCommentForm,
            closeForm: closeCommentForm,
            jumpToRow: jumpToCommentPlace,
            rowOf: (cid: string) =>
              commentPlaceRow(commentRecords, cid, (reply) => replyRows.get(reply)?.uuid),
            selected: selectedComments,
            select: selectComments,
            regions: commentRegions,
            lost: lostQuotes,
            reportLost: reportLostQuotes,
          },
    [
      agent,
      sid,
      commentRecords,
      commentThreads,
      commentCountMap,
      commentForm,
      openCommentForm,
      closeCommentForm,
      jumpToCommentPlace,
      replyRows,
      selectedComments,
      selectComments,
      commentRegions,
      lostQuotes,
      reportLostQuotes,
    ],
  );

  // フィルタを外す: ツールバーの選択中のバッジを押した時と同じ URL へ、同じく
  // 履歴を積まずに移る (DR-0050 §4)。
  function leaveFilter() {
    if (currentFilter === null) return;
    replaceNavigation(
      badgeHref(sid, currentFilter, { position: currentPosition, filter: currentFilter }),
    );
  }

  // ⤒ / ⤓ (と、端に着いた日付の帯の ↑ / ↓) はユーザの操作なので、どちらへ
  // 動いたかを目で追える短い smooth で動かす (DR-0056)。
  function scrollToTop() {
    scrollHold.toTop("user");
  }

  function scrollToBottom() {
    scrollHold.toBottom("user");
  }

  // TL 下ミニパネル (DR-0020 §2.1、issue 2026-07-17 #1/#5 で拡張): 走行中
  // 走行中 workflow の要約に加え、context 消費と活動中
  // teammates の要約行も含む (miniSummaryLines 参照)。ゼロ件 (snapshot 未着
  // 含む) ならパネル自体を出さない仕様 ("ゼロ件なら非表示")。
  // The session's own peer row (its repository and workspace go to the mini
  // panel, its cwd to the filepath resolution below).
  const selfPeer = useMemo(() => peers.find((p) => p.sid === sid), [peers, sid]);
  // What the overrides put on the session's main-thread requests (DR-0041
  // §5), the same in every tab.
  const requestOverride = useStoreState(store, (s) => s.requestOverrides.get(sid), sameJson);
  // The session's name, resolved as the Status tab's NAME is (the live
  // agent's, else the bookmark's).
  const sessionName = useStoreState(store, (s) => {
    const row = s.agents.find((candidate) => candidate.sessionId === sid);
    const bookmark = sessionBookmarkForSid(s.sessionBookmarks, sid);
    return bookmark ? sessionBookmarkTitle(bookmark, row) : (row?.name ?? "");
  });
  const miniLines = sessionStatus
    ? miniSummaryLines(
        sessionStatus,
        sessionRuntimeParts(sessionRuntime, now),
        requestOverride,
        selfPeer
          ? {
              repo: peerRepoSlug(selfPeer),
              url: selfPeer.repository?.url,
              ws: peerWorkspaceLabel(selfPeer),
              sessionName,
            }
          : { repo: "", sessionName },
      )
    : [];
  // The session's own Timeline only: an agent's is not the main thread's turn.
  const respondingAt = agent ? null : respondingSince(sessionStatus);
  // When the last turn ended, for the mark at the bottom (DR-0054 §4): shown
  // while the session's hooks module says the thread this Timeline shows (the
  // main thread, or the agent) answers none, and dated by the last row the
  // transcript has (a turn's rows are written as it ends). Without the
  // module's word there is no mark.
  const lastRowAt = useMemo(() => lastRowTime(parsed), [parsed]);
  const turnEndedAt = answersNoTurn(sessionStatus, agent ?? null) ? lastRowAt : null;
  const agentTimelineHrefs = useMemo(
    () => agentTimelineHrefsByName(sid, sessionStatus),
    [sessionStatus, sid],
  );

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
  // Keyed on the fields it is made of, not on the peer row: the peers list is
  // pushed again whenever a session's activity moves (DR-0053 §5), and a new
  // context value re-renders every bubble that reads it, past their memo.
  const selfCwd = selfPeer?.cwd;
  const selfRepoRoot = selfPeer?.repo_root;
  const selfRepo = selfPeer ? peerRepoSlug(selfPeer) : undefined;
  const sessionFilePathCtx = useMemo<FilePathResolveCtx | undefined>(
    () =>
      selfCwd !== undefined
        ? { sid, cwd: selfCwd, repoRoot: selfRepoRoot, repo: selfRepo }
        : undefined,
    [sid, selfCwd, selfRepoRoot, selfRepo],
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
  // What one row draws as, by its boundary kind: the item's content, whether
  // it is a bubble (`.tl-bubble` with a BubbleFooter, which takes the jsonl
  // toggle), and the filter that keeps it shown (DR-0050 §5). A ccmsg row
  // draws one item per message. `offset` is the row's in the window; null for
  // a bookmarked row outside it (DR-0058 §5), which has no search unit and no
  // dump menu (it is not a position), and draws all its ccmsg messages.
  function itemBodies(boundary: BoundaryKind, line: TurnLine, offset: number | null): ItemBody[] {
    const key = offset === null ? "row" : String(offset);
    const search = offset === null ? undefined : searchCtx;
    // A comment can be made on the window's rows of the session's own
    // Timeline (DR-0062 §2): a row outside the window (a filter's) has no
    // position to stand by.
    const uuid = agent || offset === null ? undefined : line.uuid;
    const targetOf = (body: Omit<ItemBody, "commentTarget">, at: CommentTarget | undefined) =>
      at === undefined ? body : { ...body, commentTarget: at };
    switch (boundary.kind) {
      case "user-prompt": {
        // A prompt of comments sent is drawn as their bubbles (§12): still a
        // person's prompt (the 👤 filter's, ↑前 | 次↓) and a comment (💬). A
        // block whose cid the daemon has no record of is not replied to.
        const blocks = offset !== null ? commentRows.get(offset) : commentBlocksOfLine(line);
        if (blocks !== undefined && blocks !== null) {
          return blocks.map((block, j) =>
            targetOf(
              {
                key: `${key}-c${j}`,
                controlsAbove: true,
                notifs: ["prompt", "comment"],
                placeKey: `c:${block.comment}`,
                node: <CommentBubble cid={block.comment} block={block} ts={line.ts} now={now} />,
              },
              agent || !commentRecords.has(block.comment) ? undefined : replyTarget(block.comment),
            ),
          );
        }
        return [
          {
            key,
            controlsAbove: true,
            notifs: ["prompt"],
            node: (
              <MemoUserPromptBubble
                line={line}
                offsetKey={offset ?? -1}
                translationAvailability={translationAvailability}
                now={now}
                searchCtx={search}
              />
            ),
          },
        ];
      }
      case "assistant-response": {
        return [
          {
            key,
            controlsAbove: false,
            ...(uuid !== undefined
              ? { commentTarget: itemCommentTarget(uuid, commentOnOfResponse(line)) }
              : {}),
            node: (
              <MemoAssistantBubble
                line={line}
                offset={offset ?? -1}
                translationAvailability={translationAvailability}
                now={now}
                searchCtx={search}
                actions={offset === null ? undefined : bubbleActions}
              />
            ),
          },
        ];
      }
      case "api-error":
        return [{ key, controlsAbove: false, node: <ApiErrorNotice line={line} /> }];
      case "bash-command":
        return [
          {
            key,
            controlsAbove: false,
            node: (
              <BashRunCard
                command={boundary.segment.command}
                output={boundary.segment.output}
                ts={line.ts}
              />
            ),
          },
        ];
      case "bash-command-output":
        return [
          {
            key,
            controlsAbove: false,
            node: <BashRunCard command={null} output={boundary.segment} ts={line.ts} />,
          },
        ];
      case "push-notification":
        return [
          {
            key,
            controlsAbove: false,
            notifs: ["say"],
            node: (
              <SayBubble
                label="PushNotification"
                text={boundary.text}
                ts={line.ts ?? ""}
                now={now}
              />
            ),
          },
        ];
      case "say":
        return [
          {
            key,
            controlsAbove: false,
            notifs: ["say"],
            node: (
              <SayCallBubble
                text={boundary.text}
                ts={line.ts ?? ""}
                now={now}
                read={sayRead.readState(boundary.toolUseId)}
              />
            ),
          },
        ];
      case "permit":
        return [
          {
            key,
            controlsAbove: false,
            notifs: ["permit"],
            node: (
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
            ),
          },
        ];
      case "comment-reply":
        // The agent's reply (§12): a reply to it answers the reply (its cid),
        // as a reply to a comment's bubble does. A reply whose cid the daemon
        // has no record of is not replied to.
        return [
          targetOf(
            {
              key,
              controlsAbove: false,
              notifs: ["comment"],
              placeKey: `c:${boundary.cid}`,
              node: (
                <CommentReplyBubble
                  cid={boundary.cid}
                  replyTo={boundary.replyTo}
                  body={boundary.body}
                  ts={line.ts}
                  now={now}
                  translationAvailability={translationAvailability}
                  searchKey={`${key}-${String(
                    line.segments.findIndex(
                      (segment) =>
                        segment.kind === "tool-use" && segment.toolUseId === boundary.toolUseId,
                    ),
                  )}`}
                  searchCtx={search}
                />
              ),
            },
            agent || !commentRecords.has(boundary.cid) ? undefined : replyTarget(boundary.cid),
          ),
        ];
      case "ccmsg": {
        // raw タブ用の「この行に何が書いてあったか」:
        // extractCcmsgMessages が読むのと同じ text segment 結合
        // (subscribe / teammate-message wrapper の原文はそこにある)。
        const rawText = line.segments
          .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
          .map((s) => s.text)
          .join("\n");
        return boundary.messages.flatMap((m, j): ItemBody[] => {
          if (offset !== null && !visibleCcmsgKeys.has(ccmsgUnitKey(offset, j))) return [];
          return [
            targetOf(
              {
                key: `${key}-${j}`,
                controlsAbove: false,
                node: (
                  <CcmsgBubble
                    message={m}
                    rawText={rawText}
                    now={now}
                    searchKey={ccmsgUnitKey(offset ?? -1, j)}
                    searchCtx={search}
                    room={rooms.get(m.room)}
                    peers={peers}
                  />
                ),
              },
              uuid === undefined ? undefined : itemCommentTarget(uuid, commentOnOfCcmsg(m)),
            ),
          ];
        });
      }
    }
  }

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
                    <TimelineScrollHoldContext.Provider value={scrollHold}>
                      <TimelineBookmarksContext.Provider value={bookmarks}>
                        <TimelineFilterContext.Provider value={currentFilter}>
                          <TimelinePositionContext.Provider value={positionValue}>
                            <TimelineCommentsContext.Provider value={commentsValue}>
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
                                  <PaneTreeToggle pane="timeline" />
                                  {agent ? null : <TimelineToolbarBadges sid={sid} />}
                                  {/* The session's own TL searches through the 🔍 filter
                                   * (DR-0022 §2): its toolbar has the 🔍 badge alone, and
                                   * the form is the filter's. An agent's TL has no filter,
                                   * so it keeps the bar with ↑↓ through the matches. */}
                                  {agent ? (
                                    <SearchBar
                                      words={inViewSearch.words}
                                      queryText={search.queryText}
                                      onQueryChange={(queryText) =>
                                        inViewSearch.changeSearch({ queryText })
                                      }
                                      caseSensitive={search.caseSensitive}
                                      onToggleCaseSensitive={() =>
                                        inViewSearch.changeSearch({
                                          caseSensitive: !search.caseSensitive,
                                        })
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
                                  ) : null}
                                  <div class="tl-toolbar-end">
                                    <button type="button" onClick={scrollToTop} title="最上部へ">
                                      ⤒
                                    </button>
                                    <button type="button" onClick={scrollToBottom} title="最下部へ">
                                      ⤓
                                    </button>
                                  </div>
                                  {/* 💬 のフィルタのヘッダ (DR-0062 §13): sticky なツールバーの
                                   * 中の 1 行。フィルタの間だけ出し、外した間も同じ要素のまま
                                   * 隠す。 */}
                                  {agent ? null : (
                                    <CommentsFilterHead
                                      hidden={currentFilter !== "comment"}
                                      sid={sid}
                                      show={commentShow}
                                      onShow={setCommentShow}
                                      items={sendAll}
                                    />
                                  )}
                                </div>
                                {/* フィルタ中は出さない: 並ぶのは notification_list の全
                                 * say / 全許可依頼で、過去分を読んでも変わらない (DR-0050
                                 * §5)。「TL に戻る」と同じく同じ要素を hidden で隠すだけに
                                 * して、フィルタの切り替えで要素を作り直さない。 */}
                                {timeline.atStart ? null : (
                                  <div class="tl-load-older" hidden={currentFilter !== null}>
                                    {OLDER_PLACEMENTS.map((placement) => (
                                      <button
                                        key={placement}
                                        type="button"
                                        class="tl-wide-button"
                                        data-placement={placement}
                                        disabled={timeline.status === "loading"}
                                        onClick={() => void loadOlder(placement)}
                                      >
                                        {timeline.status === "loading" && olderPressed === placement
                                          ? "読み込み中…"
                                          : OLDER_LABELS[placement]}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {agent ? null : (
                                  <SearchForm
                                    hidden={currentFilter !== "search"}
                                    words={inViewSearch.words}
                                    queryText={search.queryText}
                                    onQueryChange={(queryText) =>
                                      inViewSearch.changeSearch({ queryText })
                                    }
                                    caseSensitive={search.caseSensitive}
                                    onToggleCaseSensitive={() =>
                                      inViewSearch.changeSearch({
                                        caseSensitive: !search.caseSensitive,
                                      })
                                    }
                                    regexMode={search.regex}
                                    onToggleRegex={() =>
                                      inViewSearch.changeSearch({ regex: !search.regex })
                                    }
                                    hasError={inViewSearch.hasError}
                                    targets={{
                                      user: inViewSearch.targets.user,
                                      onToggleUser: inViewSearch.targets.toggleUser,
                                      ai: inViewSearch.targets.ai,
                                      onToggleAI: inViewSearch.targets.toggleAI,
                                      ccmsg: inViewSearch.targets.ccmsg,
                                      onToggleCcmsg: inViewSearch.targets.toggleCcmsg,
                                    }}
                                    hitCount={searchHits.size}
                                    olderButton={
                                      timeline.atStart
                                        ? null
                                        : {
                                            label:
                                              timeline.status === "loading" &&
                                              olderPressed === "below"
                                                ? "読み込み中…"
                                                : "過去分を読む",
                                            disabled: timeline.status === "loading",
                                            onPress: () => void loadOlder("below"),
                                          }
                                    }
                                  />
                                )}
                                {timeline.status === "error" ? (
                                  <ErrorView
                                    mark="!"
                                    tone="danger"
                                    title="transcript を読み込めませんでした"
                                    detail={timeline.error}
                                    action={{
                                      label: "再試行 (tail から読み直す)",
                                      onClick: refresh,
                                    }}
                                  />
                                ) : (
                                  <div
                                    class="tl-lines"
                                    ref={tlLinesRef}
                                    data-filter={currentFilter ?? undefined}
                                    data-comment-show={
                                      currentFilter === "comment"
                                        ? commentShowTokens(commentShow)
                                        : undefined
                                    }
                                    data-at-start={timeline.atStart ? "" : undefined}
                                    aria-busy={jumping ? "true" : undefined}
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
                                        {bookmarkError !== null ? (
                                          <p class="tl-say-error">{bookmarkError}</p>
                                        ) : null}
                                        {missingPosition !== null && currentPosition === "head" ? (
                                          <p class="tl-say-error tl-position-missing">
                                            位置 {missingPosition} は、このセッションの transcript
                                            を先頭まで読んでも見つかりませんでした
                                          </p>
                                        ) : null}
                                        {filterEmpty ? (
                                          <p class="tl-filter-empty">
                                            {currentFilter === "search"
                                              ? inViewSearch.words.length === 0
                                                ? "検索語を入れると、一致した項目だけが並びます"
                                                : "読み込み済みの範囲に一致はありません"
                                              : currentFilter === "prompt"
                                                ? "ユーザの発言はありません"
                                                : currentFilter === "say"
                                                  ? "say はありません"
                                                  : currentFilter === "permit"
                                                    ? "許可依頼はありません"
                                                    : currentFilter === "comment"
                                                      ? "コメントはありません"
                                                      : "ブックマークはありません"}
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
                                            if (boundary === undefined || boundary === null)
                                              return null;
                                            const bodies = itemBodies(boundary, line, offset);
                                            // A row of several items (a prompt of several
                                            // comments) carries its ↑前 | 次↓ on the first.
                                            const items = bodies.map((body, j) => (
                                              <ItemRawToggle
                                                key={body.key}
                                                offset={offset}
                                                uuid={line.uuid}
                                                controlsAbove={body.controlsAbove}
                                                searchHit={searchHits.has(offset)}
                                                {...(j === 0 &&
                                                body.notifs?.includes("prompt") === true &&
                                                line.uuid !== undefined
                                                  ? { promptSteps: promptStepsOf(line.uuid) }
                                                  : {})}
                                                {...(body.notifs !== undefined
                                                  ? { notifs: body.notifs }
                                                  : {})}
                                                {...(body.commentTarget !== undefined
                                                  ? { commentTarget: body.commentTarget }
                                                  : {})}
                                                place={
                                                  body.placeKey === undefined
                                                    ? undefined
                                                    : commentPlaces.get(body.placeKey)
                                                }
                                              >
                                                {body.node}
                                              </ItemRawToggle>
                                            ));
                                            // A row of one item stands in the list as itself (a
                                            // ccmsg row of several, as their list).
                                            return boundary.kind === "ccmsg" || items.length > 1
                                              ? items
                                              : (items[0] ?? null);
                                          })
                                          // Index-aligned with `groups` on both counts: the seam
                                          // splices in ahead of the first group of forked-off
                                          // history, and each slot's merged-in bubbles ahead of
                                          // the first group that is newer than them. The marks of
                                          // a group's day sit right above it, below the seam.
                                          .flatMap((node, i) => {
                                            const group = groups[i];
                                            const marks =
                                              group === undefined
                                                ? []
                                                : dayMarkNodes(groupMarkKey(group));
                                            return [
                                              ...bubbleNodes(i),
                                              ...(i === forkDividerIndex && forkOrigin
                                                ? [
                                                    <ForkDivider
                                                      key="fork-divider"
                                                      origin={forkOrigin}
                                                    />,
                                                  ]
                                                : []),
                                              ...marks,
                                              node,
                                            ];
                                          })
                                          // The merged-in bubbles newer than every group end
                                          // the same list, not one of their own: a newer row
                                          // moves such a bubble from the end to its slot, and
                                          // Preact matches keys within one list only, so in a
                                          // list of its own it would be drawn anew (its
                                          // element and state gone).
                                          // What stands at the end comes last in the same
                                          // list: the time since the last turn, the band of
                                          // today (the gap above a band, as in the middle),
                                          // then 応答中 (what runs now, today), Waiting...,
                                          // and the way back to the newest prompt (DR-0054
                                          // §10). The band of
                                          // today is keyed by its day as the bands above are
                                          // (useDayMarks), so when an item of today comes in
                                          // it moves up above the item instead of being
                                          // drawn anew.
                                          .concat(
                                            bubbleNodes(groups.length),
                                            turnEndedAt !== null ? (
                                              <TurnIdleMark key="turn-idle" endedAt={turnEndedAt} />
                                            ) : null,
                                            tailBandNode(),
                                            <TurnResponding
                                              key={`responding-${sid}`}
                                              since={respondingAt}
                                              onAbort={() => ws.turnAbort(sid)}
                                            />,
                                            waiting ? <WaitingNotice key="waiting" /> : null,
                                            // Shown while the newest prompt is not in sight, and
                                            // never under a filter: the element stays, hidden,
                                            // so the filter does not redraw the list.
                                            latestPrompt === null ? null : (
                                              <button
                                                key="latest-prompt"
                                                type="button"
                                                class="tl-latest-prompt"
                                                hidden={
                                                  currentFilter !== null ||
                                                  latestPromptInView !== false
                                                }
                                                onClick={() => jumpToRow(latestPrompt)}
                                              >
                                                ↑最新のプロンプトへ移動↑
                                              </button>
                                            ),
                                          )}
                                      </>
                                    )}
                                    {/* フィルタ中の最後のバブルの下 (DR-0050 §4) に「全て既読」、
                                     * その下に「TL に戻る」。「全て既読」は普通のボタン (幅は
                                     * 文字の分)、「TL に戻る」は押すとそこに TL が現れるので
                                     * 横幅いっぱい。「全て既読」は既読にする未読がある間だけ
                                     * 出す (無ければ押すものが無いので出さない)。出さない間も
                                     * フィルタを外した間も同じ要素のまま隠すだけにして、§6 の
                                     * 位置合わせが測る DOM を外す前と同じに保つ。 */}
                                    <button
                                      type="button"
                                      class="tl-filter-read-all"
                                      hidden={readAll === null || readAll.ids.length === 0}
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
                                {/* 末尾の番兵と、そこから表示領域の下に浮かせる「↓先頭に移動↓」
                                 * (DR-0054 §11)。番兵が表示領域の下にある間だけ出す。 */}
                                <div class="tl-tail" ref={tailRef} />
                                <div class="tl-bottom-pill-slot">
                                  <button
                                    type="button"
                                    class="tl-bottom-pill"
                                    hidden={tailInView !== false}
                                    onClick={scrollToBottom}
                                  >
                                    ↓先頭に移動↓
                                  </button>
                                </div>
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
                                            title={
                                              fixed ? "常に表示" : `${category} を自動オープン`
                                            }
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
                                        ) : line.repo ? (
                                          <span
                                            key={line.kind}
                                            class="tl-status-mini-line tl-status-mini-repo"
                                          >
                                            {line.repo.name !== undefined ? (
                                              line.repo.href !== undefined ? (
                                                <a
                                                  class="ctx-link"
                                                  href={line.repo.href}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                >
                                                  {line.repo.name}
                                                </a>
                                              ) : (
                                                <span data-part="repo">{line.repo.name}</span>
                                              )
                                            ) : null}
                                            {line.repo.ws !== undefined ? (
                                              <span data-part="ws">@{line.repo.ws}</span>
                                            ) : null}
                                            {line.repo.sessionName !== undefined ? (
                                              <>
                                                {line.repo.name !== undefined ? " " : null}
                                                <span data-part="session-name">
                                                  {line.repo.sessionName}
                                                </span>
                                              </>
                                            ) : null}
                                          </span>
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
                              <CommentFormFloat />
                              <SelectionToolbar />
                            </TimelineCommentsContext.Provider>
                          </TimelinePositionContext.Provider>
                        </TimelineFilterContext.Provider>
                      </TimelineBookmarksContext.Provider>
                    </TimelineScrollHoldContext.Provider>
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
