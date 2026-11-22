import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { AgentInfo, LlmRequestInfo, PeerInfo } from "@ccmsg/protocol";
import { sessionHref, timelineHref } from "../locator.ts";
import { NotificationBadges, NotificationCountBadges } from "./NotificationBadges.tsx";
import { type NotificationCounts, rowBadgeKinds } from "../notification-badges.ts";
import { pushNavigation } from "../navigation.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import type { AppState } from "../store.ts";
import {
  formatAgentLiveState,
  formatSidebarBadge,
  sessionRowModelEffort,
  type ModelEffortInfo,
  type ModelEffortSource,
} from "../session-status-view.ts";
import {
  badgeLabel,
  formatDuration,
  indexAgentsBySid,
  offlineAgentRows,
  sessionRowTitle,
  sessionBadges,
  sessionStatus,
  type SessionStatus,
  staleClientWarning,
  shortSid,
  toSessionRow,
  sayUnreadBySid,
  permitUnreadBySid,
  type SessionRow,
} from "../utils.ts";
import {
  type SessionBookmark,
  type SessionBookmarkRow,
  sessionBookmarkRows,
  sessionBookmarkLabel,
} from "../session-bookmarks.ts";
import {
  parseSessionFilter,
  sessionBookmarkFilterFields,
  sessionBookmarkRowTitle,
  sessionMatchesFilter,
  sessionRowFilterFields,
} from "../session-filter.ts";
import {
  BOOKMARKS_FOLD_KEY,
  NON_INTERACTIVE_FOLD_KEY,
  splitInteractive,
  loadSessionFoldStates,
  OTHERS_LABEL,
  repoName,
  type SessionGroupNode,
  sessionTree,
  type SessionTreeNode,
  storeSessionFold,
} from "../session-tree.ts";
import { Avatar } from "../avatar.tsx";
import { CacheRing } from "./CacheRing.tsx";
import { useCacheRing } from "../useCacheRing.ts";
import { Fold } from "./Fold.tsx";
import { useSharedNow } from "../useSharedNow.ts";
import { StarMark } from "./StarMark.tsx";

/** How often a row's idle time advances. */
const IDLE_TICK_MS = 10_000;

/** A row's idle time (since `since`, ISO). The only part of the list that
 * moves with the clock, so it alone renders on the tick: the rows, the tree
 * and its sums stay as they are until their data changes. Every row shares
 * one interval (useSharedNow), so they advance together in one render. */
function SessionIdle({ since }: { since: string }) {
  const now = useSharedNow(IDLE_TICK_MS);
  return <span class="session-idle">{formatDuration(now - new Date(since).getTime())}</span>;
}

/** 行アイテム全体をセッション選択にする click ハンドラ。行の
 * 中で実際に文字があるのは 1 行目の `<a>` だけで、他の 3 行や行末の余白は
 * どれだけ広くても不感帯だった — 見た目が 1 個のカードなら、カードのどこを
 * 押しても選択になるのが読み手の期待。
 *
 * 素通しする (= 行選択を起こさない) のは 3 つ:
 * - **`a` / `button` / `input` などの上**: それぞれ自前の答えを持つ。1 行目の
 *   `<a>` は同じ遷移先なので二重発火を避けるだけだが、⭐ / ▶ ボタンは
 *   「選択」とは別の操作なので拾わせてはいけない。
 * - **修飾キー付き**: Shift/Cmd/Ctrl/Alt+click は「新しいウィンドウで」
 *   「新しいタブで」「選択を広げる」等のブラウザ側の意味を持つ。行の余白でそれを横取りしても行き先は用意できない。
 * - **テキスト選択が残っている時**: sid や path はマウスでなぞって読む対象
 *   (行の CSS で text カーソルを当てている)。ドラッグ選択の終わりにも click は飛ぶので、
 *   選択が生きている間は遷移させない。
 *
 * キーボード経路は 1 行目の `<a>` がそのまま担う (行に role="button" +
 * tabIndex を足すと、同じ行き先に tab stop が 2 つ並ぶだけになる)。 */
function selectSessionOnRowClick(sid: string): (e: MouseEvent) => void {
  return (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (
      e.target instanceof Element &&
      e.target.closest("a, button, input, textarea, select, summary")
    ) {
      return;
    }
    if (window.getSelection()?.isCollapsed === false) return;
    pushNavigation(sessionHref(sid));
  };
}

/** sid の左に置く「今このセッションが何で走っているか」を `model/effort`
 * (`fable/low`) の 1 要素で出す。effort が報告されていない行は model だけで
 * `/` は付けない。値が立たない行では何も描かない — 詳細は
 * formatSessionModelEffort。 */
function SessionModelEffort({ info }: { info: ModelEffortInfo | null }) {
  if (!info) return null;
  return (
    <span class="session-model">{info.effort ? `${info.model}/${info.effort}` : info.model}</span>
  );
}

/** One row of the Sessions list: stacked elements — `repo@ws` (with the avatar
 * and the 🔔🔐 badges inline at its head), the title, the first 8 characters
 * of the session UUID, and (only for a row with neither repo nor ws) the
 * project path. Every line starts at the row's left edge. Only the first line is strong; the others are
 * dim (r135m18), so a scan down the list reads as a list of workspaces, with
 * each row's detail available without competing for attention. Within the
 * first line `@ws` is coloured as one unit including the `@`: rows of the same
 * repo differ only in their worktree, so that is the part worth finding.
 *
 * The path line is truncated from the LEFT so the leaf directory
 * stays on screen. `row` is a merged
 * SessionRow (see utils.ts's toSessionRow/offlineAgentRows) — either a
 * connected peer (optionally agent-enriched) or an agent-only "ccmsg 未起動"
 * row.
 *
 * kawaz 2026-07-12: the row's former "▷" sibling-workspace expansion was
 * removed — the request behind it ("三角押したら wt/ws が下に開いてそっちの
 * ファイルも見れるように") turned out to be a Files-tree concern, not a
 * SESSIONS-list concern, so it now lives as FileTree's ws-rooted top level
 * instead (see workspaceRootEntries in utils.ts). */
function SessionRowItem({
  row,
  currentSid,
  statusBadge,
  modelEffort,
  cacheRequest,
  sayUnread,
  permitUnread,
  placeLabel,
}: {
  row: SessionRow;
  currentSid: string | null;
  /** 1 行目の repo@ws の出し方 (RowPlaceLabel)。 */
  placeLabel: RowPlaceLabel;
  /** DR-0020 §2.1 サイドバーミニバッジ ("wf:1 bg:2 todo:3/5")。null = 出さな
   * い (走行中データなし、または今このセッションを開いていないので
   * subscribe していない — 下の SessionList の doc comment 参照)。 */
  statusBadge: string | null;
  /** sid の左に出す `model/effort` (formatSessionModelEffort の戻り)。
   * null = どの供給元も model を答えられなかった (未購読かつ直近リクエスト
   * 無し等) 行で、その場合は何も足さない。 */
  modelEffort: ModelEffortInfo | null;
  /** この sid の最後の LLM リクエスト — アイコンに巻く prompt cache リングの
   * 素材 (時刻はすべて epoch ミリ秒)。null = 直近のキャッシュ窓が既に閉じて
   * いる、または daemon が gateway の event stream を購読していない (どちらも
   * リング非表示)。kawaz r99m29: 行に要素は足さず、既存アイコンのボーダーで
   * 示す。 */
  cacheRequest: LlmRequestInfo | null;
  /** 未読の say 件数 (kawaz r244 m5-m6)。0 = マーカーを出さない。
   * 複数セッションが並走している時に「今喋ったのはどれか」を行から辿れる
   * ようにするためのもので、既読はセッションの TL の 🔔 バブル側で付ける。 */
  sayUnread: number;
  /** 未読の許可依頼の件数 (DR-0040)。0 = マーカーを出さない。 */
  permitUnread: number;
  /** daemon の protocol の版 (ping の `protocol`)。行の client の版と
   * minor が違えば黄色の印を出す (DR-0002 §4)。undefined = まだ知らない。 */
}) {
  const ring = useCacheRing(cacheRequest);
  const title = sessionRowTitle(row);
  // Straight from the row: a session that announced no repo/ws shows neither
  // (kawaz r135m16: 欠けたら欠けたなり). No substitute is invented here — the
  // one that used to exist borrowed the agent's name, which the title line
  // already shows.
  // What the headings above the row already say is not repeated (DR-0043
  // §10, RowPlaceLabel). The quick filter still reads the whole `owner/name`
  // (session-filter.ts).
  const repo = placeLabel === "slug" ? row.repo : placeLabel === "name" ? repoName(row.repo) : "";
  const wsLabel = placeLabel === "none" ? "" : row.ws;
  const titleCell = <span class="session-title">{title}</span>;
  // A row with no repo/ws to print (an agent-only row carries no VCS
  // metadata; a row of a repo group without a ws has only the repo, and the
  // one row of a repo group has both, which its heading already says) would
  // otherwise strand the avatar on a blank first line above the title — so for
  // those rows the title takes the first line's place. It keeps the dim
  // styling r135m18 asks for; what moves is only WHERE it sits, never what it
  // says.
  const hasRepoWs = Boolean(repo || wsLabel);
  // The path line stands in for a location the row does not have. A row of a
  // repo group has one (its heading), so it is not given the path.
  const hasLocation = Boolean(row.repo || row.ws);
  const badges = sessionBadges(row);
  const liveState = formatAgentLiveState(row.agent);

  const staleClient = staleClientWarning(row);
  const status = sessionStatus(row);

  return (
    <li
      class={
        (row.sid === currentSid ? "active session-row" : "session-row") +
        (status in SESSION_ROW_STATUS_CLASS ? ` ${SESSION_ROW_STATUS_CLASS[status]}` : "")
      }
      onClick={selectSessionOnRowClick(row.sid)}
    >
      <div class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}>
        <span class={row.connected ? "session-lead" : "session-lead session-disconnected"}>
          {/* prompt cache が生きている間だけアイコンの枠に輪が重なり、窓が
           * 閉じるまでかけて時計回りに欠けていく (CacheRing.tsx)。緑は会話が
           * 作った窓、黄は合図で延命している分 (llm-cache-view.ts)。
           * ラッパーはリングの有無に関わらず常設する: 条件付きで包むと
           * Avatar が remount され、リング開始のたびに再描画が走る。 */}
          <span class={ring ? `session-avatar-ring ${ring.class}` : "session-avatar-ring"}>
            <Avatar seed={row.sid} size={16} />
            {ring ? <CacheRing shape="rect" span={ring} /> : null}
          </span>
          {/* 古い ccmsg クライアント (典型的には upgrade 前から回り続けている
           * subscribe) は、拒否され続けても行の見た目を一切動かさない。未読
           * say と同じ「repo 名の直前」に出して、そのセッションだけの問題だと
           * 一目で分かるようにする。 */}
          {staleClient ? (
            <span class="session-stale-client" aria-label="ccmsg クライアントが古い">
              {staleClient.marker}
            </span>
          ) : null}
        </span>
        <SessionRowBadges sid={row.sid} sayUnread={sayUnread} permitUnread={permitUnread} />
        <a
          // Session rows always enter through the session root so the router can
          // restore that sid's recent tab/path. With no recent record the root
          // falls back to Timeline/head.
          href={sessionHref(row.sid)}
          class={row.connected ? "session-main-link" : "session-main-link session-disconnected"}
        >
          {/* 1 行目は repo@ws (kawaz r135m17 で title と入れ替え)。行の中で
           * 唯一の強い文字で、`@ws` は @ ごと別色 (r135m18) — worktree 名は
           * 同じ repo の行同士を見分ける唯一の手掛かりなので、repo 名の反復に
           * 埋もれさせない。どちらか欠けたら欠けたまま出す。 */}
          {repo ? <span class="session-line1-repo">{repo}</span> : null}
          {wsLabel ? <span class="session-line1-ws">{repo ? `@${wsLabel}` : wsLabel}</span> : null}
          {hasRepoWs ? null : titleCell}
        </a>
        {/* U3: busy/idle/done/offline no longer render per-row (kawaz: "busy
         * 表示邪魔") — that status now only shows via the row's section
         * heading (see SessionList's <Fold>). "bg" is a separate axis
         * (kind, not status) and stays on the row itself. */}
        {badges
          .filter((b) => b === "bg")
          .map((b) => (
            <span key={b} class={`session-badge session-badge-${b}`}>
              {badgeLabel(b)}
            </span>
          ))}
        {statusBadge ? <span class="session-status-badge">{statusBadge}</span> : null}
      </div>
      {/* 停止理由 (harness API エラー): なぜ止まっているかが分からないと
       * Error セクションに居ること自体が action に繋がらないので、色分けだけ
       * でなく本文も出す。"API Error: 500 {...}" のような長い JSON が来るため
       * 1 行に truncate。1 行目の badge 群とは
       * 別の行に置いて statusBadge の並びを崩さない。 */}
      {row.api_error ? <div class="session-error-text">{row.api_error.text}</div> : null}
      {/* 2 行目: セッション自身のタイトル (= /rename が設定し Claude Code が
       * name として返す文字列)。r135m17 で 1 行目から降り、以下 3 行は弱い
       * 文字 (r135m18)。repo/ws が無い行では上の 1 行目がこの内容を引き取って
       * いるので、ここは出さない。 */}
      {hasRepoWs ? <div class="session-line2">{titleCell}</div> : null}
      {/* 3 行目: 左から live dot と経過時間、model/effort、セッション UUID の
       * 先頭 8 文字。dot と経過時間は「いつから何の状態か」で 1 組なので、
       * 行の要素間隔より詰めて 1 つの塊に入れる。 */}
      <div class="session-line3">
        {liveState || row.last_activity_at ? (
          <span class="session-activity">
            {liveState ? (
              <span
                class={
                  "session-live-dot" +
                  (row.agent?.turn?.state === "responding" ? " session-live-dot-running" : "") +
                  (row.agent?.status === "waiting" ? " session-live-dot-waiting" : "")
                }
                aria-label={liveState}
              />
            ) : null}
            {row.last_activity_at ? <SessionIdle since={row.last_activity_at} /> : null}
          </span>
        ) : null}
        <SessionModelEffort info={modelEffort} />
        <span class="session-sid">{shortSid(row.sid)}</span>
      </div>
      {/* 4 行目: project path。repo も ws も無い行だけに出す (それ以外は
       * repo@ws か組の見出しが場所を示す)。左を省略して右端 (= worktree 名
       * まで) を常時見せる。 */}
      {hasLocation ? null : (
        <div class="session-line4">
          <span class="session-cwd">
            {/* direction:rtl が ellipsis を行頭側へ回す一方、パスの `/` のような
             * 中立文字はその方向で並べ替えられてしまう (`/a/b` が `a/b/` に
             * 見える)。中身を bdi の LTR 分離レベルに閉じ込めると、並べ替えは
             * 外側の 1 要素だけに効き、パス本文は元の順序のまま残る。 */}
            <bdi dir="ltr">{row.cwd}</bdi>
          </span>
        </div>
      )}
    </li>
  );
}

/** One row of the sidebar's Bookmarks section (DR-0021 §2.4/§3.2). Deliberately
 * NOT a `SessionRowItem` reuse — a bookmarked entry is a `SessionBookmark`, not
 * a `SessionRow` (no `agent`/`connected_at`/`last_activity_at` to show), and
 * forcing it through the same merge shape `toSessionRow` builds would need a
 * lot of made-up filler fields. What it does share is the element
 * layout (`repo@ws` / title / short sid / path for a row without repo/ws) and the two live
 * sources those elements come from when this bookmark's session is running: `peer`
 * supplies repo/ws and decides the badge text (no peer = "仮想", the daemon
 * resolves this sid via virtualConfigDirs, DR-0021 §3.1), `agent` supplies the
 * title — see sessionBookmarkLabel / sessionBookmarkTitle, which fall back to the
 * bookmark's own frozen record when the session is not running. Every bookmark enters
 * through the session root so recent restoration is identical to a live
 * session row. */
function SessionBookmarkItem({
  bookmark,
  currentSid,
  peer,
  agent,
  modelEffort,
  sayUnread,
  permitUnread,
  onRemoveBookmark,
}: {
  bookmark: SessionBookmark;
  currentSid: string | null;
  peer: PeerInfo | undefined;
  agent: AgentInfo | undefined;
  /** sid の左に出す `model/effort`。走っているブックマークなら live 観測、止まって
   * いるブックマークなら検索ヒットに凍結された値が採用される (SessionList の
   * resolveModelEffort 参照)。 */
  modelEffort: ModelEffortInfo | null;
  /** 未読の say 件数。ブックマークは下の status セクションから除外されている
   * (SessionList の filter) ので、ここに出さないとブックマークしたセッションの
   * 🔔 がどこにも出なくなる。 */
  sayUnread: number;
  /** 未読の許可依頼の件数。ブックマークに出す理由は sayUnread と同じ。 */
  permitUnread: number;
  onRemoveBookmark: () => void;
}) {
  const { repo, ws: wsLabel } = sessionBookmarkLabel(bookmark, peer);
  // Same tail as sessionRowTitle: a bookmark whose session never renamed itself
  // (and whose transcript held no custom-title for Session Search to read)
  // still gets a non-blank line rather than a gap where a title goes. The
  // quick filter reads the same function, so it matches what is printed.
  const title = sessionBookmarkRowTitle(bookmark, agent);
  const titleCell = <span class="session-title">{title}</span>;
  // With no repo/ws to print, the title takes the first line's place instead
  // of leaving the avatar stranded on a blank one (SessionRowItem's own
  // hasRepoWs branch, same reasoning).
  const hasRepoWs = Boolean(repo || wsLabel);

  return (
    <li
      class={bookmark.sid === currentSid ? "active session-row" : "session-row"}
      onClick={selectSessionOnRowClick(bookmark.sid)}
    >
      <div class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}>
        <span class="session-lead">
          <Avatar seed={bookmark.sid} size={16} />
        </span>
        <SessionRowBadges sid={bookmark.sid} sayUnread={sayUnread} permitUnread={permitUnread} />
        <a href={sessionHref(bookmark.sid)} class="session-main-link">
          {repo ? <span class="session-line1-repo">{repo}</span> : null}
          {wsLabel ? <span class="session-line1-ws">{repo ? `@${wsLabel}` : wsLabel}</span> : null}
          {hasRepoWs ? null : titleCell}
        </a>
        {peer === undefined ? <span class="session-badge session-badge-offline">仮想</span> : null}
        <button
          type="button"
          class="session-bookmark-remove-btn"
          aria-label="ブックマーク解除"
          onClick={onRemoveBookmark}
        >
          <StarMark on fit />
        </button>
      </div>
      {hasRepoWs ? <div class="session-line2">{titleCell}</div> : null}
      <div class="session-line3">
        <SessionModelEffort info={modelEffort} />
        <span class="session-sid">{shortSid(bookmark.sid)}</span>
      </div>
      {!hasRepoWs && bookmark.cwd ? (
        <div class="session-line4">
          <span class="session-cwd">
            <bdi dir="ltr">{bookmark.cwd}</bdi>
          </span>
        </div>
      ) : null}
    </li>
  );
}

/** Sidebar "Bookmarks" section (DR-0021 §2.4/§3.2, DR-0043 §11): a place
 * for sessions to wake up and resume later — one per issue, put aside until
 * the other side answers, then woken with the context it had. A fold, closed
 * until the reader opens it (the state is stored), and shown even with no
 * bookmark (the heading alone: `(0)` and the marker say it is empty): always
 * there, rarely in the way. Below Errors / Waiting and above the tree,
 * regardless of the search panel being open/closed (see Sidebar.tsx's doc
 * comment). While the quick filter narrows, it is shown only with a match,
 * and then open, as the tree's folds are. A bookmarked session that is
 * running is in the tree too.
 *
 * A bookmark is a directory, and the rows under it are sessionBookmarkRows' answer: every
 * connected session in that directory, else the session frozen at bookmark time.
 * The count in the summary is of bookmarked directories — under the quick filter,
 * of the directories that still have a matching row (DR-0043 §9). */
function SessionBookmarksSection({
  rows,
  filtering,
  unread,
  peersBySid,
  agentsBySid,
  currentSid,
  sayUnreadBy,
  permitUnreadBy,
  resolveModelEffort,
}: {
  /** sessionBookmarkRows' answer, already narrowed by the quick filter (SessionList
   * computes it once, since the filter's "該当なし" needs the count too). */
  rows: readonly SessionBookmarkRow[];
  /** The quick filter is narrowing (`rows` holds the matches only). */
  filtering: boolean;
  /** The 🔔🔐 sum of `rows`' sessions (SessionList derives it with them). */
  unread: NotificationCounts;
  peersBySid: Map<string, PeerInfo>;
  /** agents rows keyed by sid — the section's source for a
   * live session's title, indexed once by SessionList for both it and the
   * status sections below. */
  agentsBySid: Map<string, AgentInfo>;
  currentSid: string | null;
  /** sid → 未読 say 件数 (SessionList が unreadSays から数えたもの)。 */
  sayUnreadBy: Map<string, number>;
  /** sid → 未読の許可依頼の件数 (SessionList が permitUnread から数えたもの)。 */
  permitUnreadBy: Map<string, number>;
  /** SessionList が組み立てた model/effort の解決子 — ブックマークは live/凍結の両方を
   * 供給元に持つので、第 2 引数に凍結値 (検索ヒット) を渡す。 */
  resolveModelEffort: (sid: string, frozen?: ModelEffortSource) => ModelEffortInfo | null;
}) {
  const { store } = useApp();
  if (filtering && rows.length === 0) return null;
  const bookmarkCount = new Set(rows.map((row) => row.key)).size;
  return (
    <SessionListFold
      foldKey={BOOKMARKS_FOLD_KEY}
      class="session-section session-copy-section session-bookmarks-section"
      summaryClass="session-section-summary"
      defaultOpen={false}
      summary={`Bookmarks (${bookmarkCount})`}
      unread={unread}
      filtering={filtering}
    >
      {rows.length === 0 ? null : (
        <ul class="session-section-list">
          {rows.map(({ key, bookmark }) => (
            <SessionBookmarkItem
              key={bookmark.sid}
              bookmark={bookmark}
              currentSid={currentSid}
              peer={peersBySid.get(bookmark.sid)}
              agent={agentsBySid.get(bookmark.sid)}
              modelEffort={resolveModelEffort(bookmark.sid, bookmark)}
              sayUnread={sayUnreadBy.get(bookmark.sid) ?? 0}
              permitUnread={permitUnreadBy.get(bookmark.sid) ?? 0}
              onRemoveBookmark={() => store.dispatch({ type: "session-bookmarks/removed", key })}
            />
          ))}
        </ul>
      )}
    </SessionListFold>
  );
}

/** How a row prints where it is (`repo@ws`) on its first line (DR-0043 §10):
 * what the headings above it already say is not repeated.
 * - `slug`: `owner/name@ws`, in a flat list (Errors / Waiting) where no
 *   heading names the owner, as a Bookmarks row does
 * - `name`: `name@ws`, under an owner's prefix group, whose heading names
 *   neither the owner's repository nor tells them apart
 * - `ws`: the ws alone, under a repo group of two or more sessions (its
 *   heading is the name) or `others` (no repository)
 * - `none`: nothing, under a repo group of one session, whose heading says
 *   `name @ws` */
type RowPlaceLabel = "slug" | "name" | "ws" | "none";

/** Extra class of a row whose status needs the reader (DR-0043 §12), the
 * same wherever the row is (the Errors / Waiting sections, the tree):
 * - `waiting`: ユーザ対応を促す跳ねアニメーション (composer-fab-draft と同系。
 *   kawaz r46 mid=42)
 * - `error`: harness API エラーで停止中。跳ねは付けない — 同時に出た時
 *   waiting と見分けが付かなくなるため。行は停止理由の文 (danger 色) を出す。 */
const SESSION_ROW_STATUS_CLASS: Partial<Record<SessionStatus, string>> = {
  waiting: "session-row-waiting",
  error: "session-row-error",
};

/** A section of the rows of one status that needs the reader (DR-0043 §12):
 * `Errors (n)` / `Waiting (n)`, flat, in the list's order. Not rendered with
 * no row; open whenever it appears, and the reader's open/close is not
 * stored, so the next time it appears it is open again. The rows are copies
 * of rows in the tree below. */
function SessionStatusSection({
  sectionClass,
  label,
  rows,
  renderRow,
}: {
  sectionClass: string;
  label: string;
  rows: readonly SessionRow[];
  renderRow: (row: SessionRow, placeLabel: RowPlaceLabel) => ComponentChildren;
}) {
  if (rows.length === 0) return null;
  return (
    <Fold
      open
      class={`session-section session-copy-section ${sectionClass}`}
      summaryClass="session-section-summary"
      summary={`${label} (${rows.length})`}
    >
      <ul class="session-section-list">{rows.map((row) => renderRow(row, "slug"))}</ul>
    </Fold>
  );
}

/** 行の 🔔🔐 (DR-0050 §7)。アイコンと repo 名の間 (kawaz r244m13: 行末の弱い
 * badge 位置では絶対気づかない。1 行目の視線の起点に割り込ませて、鳴ったこと
 * を見逃させない)。出すのは未読が 1 以上の種類だけ (TL のヘッダは常に両方)。
 * 押すとそのセッションの TL をその種類のフィルタで開く。行の link の中に link は入れられないので、
 * 行の link の兄弟に置く。 */
function SessionRowBadges({
  sid,
  sayUnread,
  permitUnread,
}: {
  sid: string;
  sayUnread: number;
  permitUnread: number;
}) {
  const counts = { say: sayUnread, permit: permitUnread };
  const kinds = rowBadgeKinds(counts);
  if (kinds.length === 0) return null;
  return (
    <NotificationBadges
      class="session-row-badges"
      kinds={kinds}
      counts={counts}
      selected={null}
      hrefOf={(kind) => timelineHref(sid, "head", kind)}
      showTitle={false}
    />
  );
}

/** The SESSIONS quick filter's box (DR-0043 §9), at the top of the fold's
 * body. Same box as the Files pane's name search (FileTree's `.tree-search`):
 * a `type="search"` input, and Esc empties it rather than only blurring —
 * the text is what is hiding rows, so "get me out of the filter" and "empty
 * the box" are one intent. The placeholder names what it narrows by, so it
 * does not read as the 🔍 Session Search beside the heading (which searches
 * transcripts). */
function SessionFilterBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div class="session-filter">
      <input
        type="search"
        class="session-filter-input"
        placeholder="Filter sessions by name"
        aria-label="セッションを名前で絞り込む (空白区切りで AND、-語 で除外)"
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
          }
        }}
      />
    </div>
  );
}

/** One fold of the SESSIONS list whose state the reader keeps: the owner →
 * group tree's folds (DR-0043 §10) and the Bookmarks section (§11).
 *
 * The element owns whether it is open. The fold reads its stored state (else
 * its own `defaultOpen`) once, when it appears, and hands it to the element;
 * after that nothing in the list's state follows the fold, so opening or
 * closing it renders nothing (the 🔔🔐 sum is always in the heading, and CSS
 * shows it only while the fold is closed). The reader's opening and closing
 * is stored from the element's `toggle`. While the quick filter is narrowing
 * the fold appears open (what is left is what matched) and nothing is
 * stored; SessionList mounts the folds afresh when the filter starts and
 * ends, so they come back as stored.
 *
 * Design rationale: not a controlled `open`. Setting `open` from state in the
 * heading's click renders before the browser flips the element (the click's
 * microtask), and the browser's flip then undoes it: the first click did
 * nothing. And every fold's state in the list's state rendered the whole list
 * on each click. */
function SessionListFold({
  foldKey,
  class: className,
  summaryClass = "session-tree-summary",
  defaultOpen = true,
  summary,
  unread,
  filtering,
  children,
}: {
  foldKey: string;
  class: string;
  summaryClass?: string;
  defaultOpen?: boolean;
  summary: ComponentChildren;
  /** The 🔔🔐 unread counts of the sessions inside, summed. Shown only while
   * the fold is closed: open, the rows show their own. */
  unread: NotificationCounts;
  /** The quick filter is narrowing: appear open, and store nothing. */
  filtering: boolean;
  children: ComponentChildren;
}) {
  const storedOrDefault = (): boolean => loadSessionFoldStates().get(foldKey) ?? defaultOpen;
  const [openAtFirst] = useState(() => filtering || storedOrDefault());
  return (
    <Fold
      class={className}
      summaryClass={summaryClass}
      summary={
        <>
          <span class="session-tree-name">{summary}</span>
          <NotificationCountBadges counts={unread} class="session-tree-badges" />
        </>
      }
      open={openAtFirst}
      onToggle={(e) => {
        if (filtering) return;
        // The element's appearing toggles it too, to what is stored already.
        const open = e.currentTarget.open;
        if (open !== storedOrDefault()) storeSessionFold(loadSessionFoldStates(), foldKey, open);
      }}
    >
      {children}
    </Fold>
  );
}

/** The list's tree: owners, each holding its groups (a prefix group or a
 * repository's group, session-tree.ts), each holding its sessions; and the
 * one group of sessions without a repository, last. The owner's heading
 * counts its sessions as a section's does, `(N)`; a group's heading is its
 * name alone, except a repository's group of one session with a ws, whose
 * heading is `name @ws` (the row then has nothing left to say on its first
 * line). A closed fold's heading carries the 🔔🔐 sum of what it folds. The
 * headings of the folds that hold the selected session (`currentSid`) carry
 * `session-tree-current`, derived here from the selection. */
function SessionTree({
  nodes,
  filtering,
  currentSid,
  unreadByKey,
  renderRow,
}: {
  nodes: readonly SessionTreeNode[];
  filtering: boolean;
  currentSid: string | null;
  /** Each fold's 🔔🔐 sum by its key (sessionTreeUnread). */
  unreadByKey: ReadonlyMap<string, NotificationCounts>;
  renderRow: (row: SessionRow, placeLabel: RowPlaceLabel) => ComponentChildren;
}) {
  const unread = (key: string): NotificationCounts => unreadByKey.get(key) ?? NO_UNREAD;
  const foldClass = (base: string, rows: readonly SessionRow[]): string =>
    currentSid !== null && rows.some((row) => row.sid === currentSid)
      ? `${base} session-tree-current`
      : base;
  return (
    <>
      {nodes.map((node) =>
        node.kind === "others" ? (
          <SessionListFold
            key={node.key}
            foldKey={node.key}
            class={foldClass("session-tree-fold session-tree-others", node.rows)}
            summary={`${OTHERS_LABEL} (${node.rows.length})`}
            unread={unread(node.key)}
            filtering={filtering}
          >
            <ul class="session-section-list">{node.rows.map((row) => renderRow(row, "ws"))}</ul>
          </SessionListFold>
        ) : (
          <SessionListFold
            key={node.key}
            foldKey={node.key}
            class={foldClass("session-tree-fold session-tree-owner", node.rows)}
            summary={`${node.owner} (${node.rows.length})`}
            unread={unread(node.key)}
            filtering={filtering}
          >
            {node.groups.map((group) => {
              const { summary, placeLabel } = groupHeading(group);
              return (
                <SessionListFold
                  key={group.key}
                  foldKey={group.key}
                  class={foldClass(`session-tree-fold session-tree-${group.kind}`, group.rows)}
                  summary={summary}
                  unread={unread(group.key)}
                  filtering={filtering}
                >
                  <ul class="session-section-list">
                    {group.rows.map((row) => renderRow(row, placeLabel))}
                  </ul>
                </SessionListFold>
              );
            })}
          </SessionListFold>
        ),
      )}
    </>
  );
}

/** A group's heading and how its rows print their place (RowPlaceLabel). A
 * repository's group of one session with a ws says `name @ws`, with `@ws` as
 * a row's first line shows it, and its row says neither (kawaz 2026-11-21:
 * otherwise most rows' first line reads `main`). */
function groupHeading(group: SessionGroupNode): {
  summary: ComponentChildren;
  placeLabel: RowPlaceLabel;
} {
  if (group.kind === "prefix") return { summary: group.name, placeLabel: "name" };
  const [only, ...rest] = group.rows;
  if (only === undefined || rest.length > 0 || only.ws === "") {
    return { summary: group.name, placeLabel: "ws" };
  }
  return {
    summary: (
      <>
        {group.name} <span class="session-tree-ws">@{only.ws}</span>
      </>
    ),
    placeLabel: "none",
  };
}

const NO_UNREAD: NotificationCounts = { say: 0, permit: 0 };

/** The 🔔🔐 sum of `rows`' sessions. */
function unreadSum(
  rows: readonly { sid: string }[],
  sayUnreadBy: ReadonlyMap<string, number>,
  permitUnreadBy: ReadonlyMap<string, number>,
): NotificationCounts {
  let say = 0;
  let permit = 0;
  for (const row of rows) {
    say += sayUnreadBy.get(row.sid) ?? 0;
    permit += permitUnreadBy.get(row.sid) ?? 0;
  }
  return { say, permit };
}

/** Every fold of the tree's 🔔🔐 sum, by its key. */
function sessionTreeUnread(
  nodes: readonly SessionTreeNode[],
  sayUnreadBy: ReadonlyMap<string, number>,
  permitUnreadBy: ReadonlyMap<string, number>,
): ReadonlyMap<string, NotificationCounts> {
  const sums = new Map<string, NotificationCounts>();
  for (const node of nodes) {
    sums.set(node.key, unreadSum(node.rows, sayUnreadBy, permitUnreadBy));
    if (node.kind === "owner") {
      for (const group of node.groups) {
        sums.set(group.key, unreadSum(group.rows, sayUnreadBy, permitUnreadBy));
      }
    }
  }
  return sums;
}

function sessionListSlice(state: AppState) {
  return {
    agents: state.agents,
    sessionStatuses: state.sessionStatuses,
    sessionErrors: state.sessionErrors,
    llmRequests: state.llmRequests,
    requestOverrides: state.requestOverrides,
    sessionBookmarks: state.sessionBookmarks,
    unreadSays: state.unreadSays,
    permitUnread: state.permitUnread,
  };
}

/** Sidebar "Sessions" section (U1, developed from the DR-0008 peers list):
 * merges the ccmsg-connected `peers` (pre-sorted by Sidebar's name/created/
 * recent toggle — this component never reorders those) with the daemon's
 * agents rows (`agents`, read from the store with the rest of
 * `sessionListSlice`) so a session the agents rows list but whose ccmsg CLI
 * hasn't connected yet still shows up (see offlineAgentRows).
 *
 * From the top (DR-0043 §10–§12): `Errors (n)` and `Waiting (n)` (the rows of
 * that status, shown only with a row), `Bookmarks (n)`, then every row in one
 * owner → group tree with `others` last. A row of the first three is also in
 * the tree. The list's sort order (name/created/recent) holds in each. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: readonly PeerInfo[];
  currentSid: string | null;
}) {
  const { store } = useApp();
  const {
    agents,
    sessionStatuses,
    sessionErrors,
    llmRequests,
    requestOverrides,
    sessionBookmarks,
    unreadSays,
    permitUnread,
  } = useStoreState(store, sessionListSlice, shallowEqual);
  // 未読の say は daemon が ev:"say_unread" で全件 push するので、TL を開いて
  // いないセッションの未読もここで数えられる。
  const sayUnreadBy = useMemo(() => sayUnreadBySid(unreadSays), [unreadSays]);
  const permitUnreadBy = useMemo(() => permitUnreadBySid(permitUnread), [permitUnread]);
  const agentsBySid = useMemo(() => indexAgentsBySid(agents), [agents]);
  const rows = useMemo(
    () => [
      ...peers.map((p) => toSessionRow(p, agentsBySid, sessionErrors)),
      ...offlineAgentRows(peers, agents),
    ],
    [peers, agents, agentsBySid, sessionErrors],
  );
  // Quick filter (DR-0043 §9). The text is this list's own UI state — not the
  // URL, not storage: it narrows what is on screen now and is gone on reload,
  // the way the Files pane's name box is. Matching is local and cheap, so it
  // runs on every keystroke with no debounce (Files debounces only because its
  // box starts a daemon walk).
  const [filterText, setFilterText] = useState("");
  const filter = useMemo(() => parseSessionFilter(filterText), [filterText]);
  // 行に出す model/effort は、Status タブの MODEL / EFFORT・TL 下の状態行と同じ
  // 決め方 (sessionRowModelEffort → requestValueInForce、DR-0041 §5) で、上書き
  // (requestOverrides、全セッション分が全タブに届く) を最初に見る。上書きの無い
  // field はセッション自身の値で、その供給元は確度の高い順に:
  //   1. context 観測 — model と effort の両方を持つが、entry があるのは
  //      SessionView が Status/Timeline を開いている sid だけ (statusBadge と
  //      同じ購読事情、下のコメント参照)。
  //   2. peers の行の model/effort — daemon が全セッション分を ev:"peers" で配る (module の facts、無ければ daemon がセッションを知った時に transcript を読んで取った最後の assistant 行の値。DR-0053 §4)。開いていない行にも、開いた後に別のセッションへ移った行にも出る。
  //   3. gateway の直近 LLM リクエスト — 全 sid 分がまとめて届くので購読に
  //      左右されないが、model しか分からない (effort は request に無い)。
  //   4. 呼び出し側が持つ凍結値 (ブックマークの検索ヒット等) — 走っていないセッション
  //      でも「最後に何で走っていたか」は答えられる。
  const peersBySid = useMemo(() => new Map(peers.map((p) => [p.sid, p] as const)), [peers]);
  const bookmarked = useMemo(
    () => sessionBookmarkRows(sessionBookmarks, peers, agentsBySid),
    [sessionBookmarks, peers, agentsBySid],
  );
  // Under a filter every section and the tree show only the matching rows
  // and count only them; a fold left with none is dropped (as the Files
  // search drops a group with no hits) — a heading with "(0)" under it would
  // only add lines to scan past.
  const shownBookmarks = useMemo(
    () =>
      filter
        ? bookmarked.filter(({ bookmark }) =>
            sessionMatchesFilter(
              sessionBookmarkFilterFields(
                bookmark,
                peersBySid.get(bookmark.sid),
                agentsBySid.get(bookmark.sid),
              ),
              filter,
            ),
          )
        : bookmarked,
    [bookmarked, filter, peersBySid, agentsBySid],
  );
  // A bookmarked session is in the tree too (kawaz r259m64): Bookmarks is a
  // fixed place, the tree the row's place in the sort order.
  const shownRows = useMemo(
    () =>
      filter
        ? rows.filter((row) => sessionMatchesFilter(sessionRowFilterFields(row), filter))
        : rows,
    [rows, filter],
  );
  // The sessions no person types into (`claude -p`, the SDKs, a btw's fork)
  // go apart, to the bottom (DR-0060 §11): they are neither in the tree nor
  // among the sessions waiting for the person.
  const { interactive: personRows, nonInteractive: nonInteractiveRows } = useMemo(
    () => splitInteractive(shownRows),
    [shownRows],
  );
  const errorRows = useMemo(
    () => personRows.filter((row) => sessionStatus(row) === "error"),
    [personRows],
  );
  const waitingRows = useMemo(
    () => personRows.filter((row) => sessionStatus(row) === "waiting"),
    [personRows],
  );
  // The tree and its folds' 🔔🔐 sums are derived from the rows and the
  // unread counts, and only when those change: opening and closing a fold
  // changes how they are shown, never what they are (SessionListFold).
  const tree = useMemo(() => sessionTree(personRows), [personRows]);
  const nonInteractiveUnread = useMemo(
    () => unreadSum(nonInteractiveRows, sayUnreadBy, permitUnreadBy),
    [nonInteractiveRows, sayUnreadBy, permitUnreadBy],
  );
  const treeUnread = useMemo(
    () => sessionTreeUnread(tree, sayUnreadBy, permitUnreadBy),
    [tree, sayUnreadBy, permitUnreadBy],
  );
  const bookmarksUnread = useMemo(
    () =>
      unreadSum(
        shownBookmarks.map(({ bookmark }) => bookmark),
        sayUnreadBy,
        permitUnreadBy,
      ),
    [shownBookmarks, sayUnreadBy, permitUnreadBy],
  );
  const filtering = filter !== null;
  const noMatch = filtering && shownBookmarks.length === 0 && shownRows.length === 0;
  const resolveModelEffort = useMemo(
    () => (sid: string, frozen?: ModelEffortSource) =>
      sessionRowModelEffort(sessionStatuses.get(sid)?.context, requestOverrides.get(sid), [
        peersBySid.get(sid),
        { model: llmRequests.get(sid)?.model },
        frozen,
      ]),
    [sessionStatuses, requestOverrides, peersBySid, llmRequests],
  );
  const renderRow = (row: SessionRow, placeLabel: RowPlaceLabel) => (
    <SessionRowItem
      key={row.sid}
      row={row}
      currentSid={currentSid}
      placeLabel={placeLabel}
      // 同じ sid が Errors / Waiting / Bookmarks と木の両方に出る時、選択中の
      // 塗りは木の行だけで、上の区画の行は枠だけに弱める (CSS の
      // .session-copy-section、DR-0043 §12)。
      // DR-0020 §2.1 (a) 実装コスト判断: 全 peer 分を常時
      // subscribe すると常駐コストが人数分乗るため、SessionView が
      // 実際に Status/Timeline タブを開いているセッションだけ
      // sessionStatuses に entry を持つ (SessionView.tsx の購読
      // effect 参照)。よってバッジが出るのは currentSid の行だけ
      // — 他行は subscribe していないので常に null (「ゼロ件」で
      // はなく「未購読」、意図的にバッジ非表示のまま)。
      statusBadge={row.sid === currentSid ? formatSidebarBadge(sessionStatuses.get(row.sid)) : null}
      // statusBadge と違い全行に出す: prompt cache は daemon 側で
      // 全 sid 分まとめて届くので、購読の有無に左右されない。
      modelEffort={resolveModelEffort(row.sid)}
      cacheRequest={llmRequests.get(row.sid) ?? null}
      sayUnread={sayUnreadBy.get(row.sid) ?? 0}
      permitUnread={permitUnreadBy.get(row.sid) ?? 0}
    />
  );
  return (
    <>
      <SessionFilterBox value={filterText} onChange={setFilterText} />
      <div id="session-list">
        {noMatch ? <p class="session-filter-empty">該当なし</p> : null}
        <SessionStatusSection
          key="errors"
          sectionClass="session-errors-section"
          label="Errors"
          rows={errorRows}
          renderRow={renderRow}
        />
        <SessionStatusSection
          key="waiting"
          sectionClass="session-waiting-section"
          label="Waiting"
          rows={waitingRows}
          renderRow={renderRow}
        />
        {/* The folds are mounted afresh when the quick filter starts and ends
         * (the key), so they appear open while it narrows and as stored after
         * (SessionListFold). */}
        <SessionBookmarksSection
          key={filtering ? "bookmarks-filtering" : "bookmarks"}
          rows={shownBookmarks}
          filtering={filtering}
          unread={bookmarksUnread}
          peersBySid={peersBySid}
          agentsBySid={agentsBySid}
          currentSid={currentSid}
          sayUnreadBy={sayUnreadBy}
          permitUnreadBy={permitUnreadBy}
          resolveModelEffort={resolveModelEffort}
        />
        <SessionTree
          key={filtering ? "tree-filtering" : "tree"}
          nodes={tree}
          filtering={filtering}
          currentSid={currentSid}
          unreadByKey={treeUnread}
          renderRow={renderRow}
        />
        {nonInteractiveRows.length > 0 ? (
          <SessionListFold
            key={filtering ? "non-interactive-filtering" : "non-interactive"}
            foldKey={NON_INTERACTIVE_FOLD_KEY}
            class="session-tree-fold session-tree-non-interactive"
            defaultOpen={false}
            summary={`Non-interactive (${nonInteractiveRows.length})`}
            unread={nonInteractiveUnread}
            filtering={filtering}
          >
            <ul class="session-section-list">
              {nonInteractiveRows.map((row) => renderRow(row, "slug"))}
            </ul>
          </SessionListFold>
        ) : null}
      </div>
    </>
  );
}
