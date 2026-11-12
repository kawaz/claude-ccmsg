import { useEffect, useMemo, useState } from "preact/hooks";
import type { AgentInfo, LlmRequestInfo, PeerInfo } from "@ccmsg/protocol";
import { sessionHref, timelineHref } from "../locator.ts";
import { NotificationBadges } from "./NotificationBadges.tsx";
import { rowBadgeKinds } from "../notification-badges.ts";
import { pushNavigation } from "../navigation.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import type { AppState } from "../store.ts";
import {
  formatAgentLiveState,
  formatSessionModelEffort,
  formatSidebarBadge,
  type ModelEffortInfo,
  type ModelEffortSource,
} from "../session-status-view.ts";
import {
  badgeLabel,
  formatDuration,
  groupSessionsBySection,
  indexAgentsBySid,
  lastPathSegment,
  offlineAgentRows,
  sessionRowTitle,
  sessionBadges,
  staleClientWarning,
  shortSid,
  toSessionRow,
  sayUnreadBySid,
  permitUnreadBySid,
  type SessionRow,
} from "../utils.ts";
import {
  type Pin,
  pinnedRows,
  pinnedSessionLabel,
  pinnedSessionTitle,
} from "../pinned-sessions.ts";
import { Avatar } from "../avatar.tsx";
import { CacheRing } from "./CacheRing.tsx";
import { useCacheRing } from "../useCacheRing.ts";
import { KeepaliveControl } from "./KeepaliveControl.tsx";
import { Fold } from "./Fold.tsx";

const TICK_MS = 10_000;

/** Re-renders every `TICK_MS` so idle-time text keeps advancing. Lives here
 * (not in Sidebar) so the tick never touches `peers`/sortKey and can't
 * trigger Sidebar's `sortPeers` memo — row text moves, row order doesn't,
 * until the next actual peers update (see Sidebar.tsx). */
function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
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

/** sid の右に並ぶ「今このセッションが何で走っているか」。
 * 値が立たない行では何も描かない — 詳細は formatSessionModelEffort。
 *
 * model と effort は別々の要素にする (kawaz r259m5): 行が狭まった時に
 * `[e8c38f…] [fable…] [low]` のように各自が自分の幅の中で省略されるのが期待
 * される見え方で、1 要素に連結するとその途中状態を作れない。 */
function SessionModelEffort({ info }: { info: ModelEffortInfo | null }) {
  if (!info) return null;
  return (
    <>
      <span class="session-model" title={info.title}>
        {info.model}
      </span>
      {info.effort ? (
        <span class="session-effort" title={info.title}>
          {info.effort}
        </span>
      ) : null}
    </>
  );
}

/** One row of the Sessions list (kawaz r135m16 §1, order per r135m17): four
 * stacked elements — `repo@ws`, the title, the full session UUID, and
 * the project path. Only the first line is strong; the other three are dim
 * (r135m18), so a scan down the list reads as a list of workspaces, with each
 * row's detail available without competing for attention. Within the first
 * line `@ws` is coloured as one unit including the `@`: rows of the same repo
 * differ only in their worktree, so that is the part worth finding.
 *
 * The sid is printed whole rather than truncated because its whole job here
 * is to be copied elsewhere, and the path is truncated from the LEFT so the
 * leaf directory — again the part that differs between worktrees — stays on
 * screen. `row` is a merged
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
}: {
  row: SessionRow;
  currentSid: string | null;
  /** DR-0020 §2.1 サイドバーミニバッジ ("wf:1 bg:2 todo:3/5")。null = 出さな
   * い (走行中データなし、または今このセッションを開いていないので
   * subscribe していない — 下の SessionList の doc comment 参照)。 */
  statusBadge: string | null;
  /** sid の右に出す `{model} {effort}` (formatSessionModelEffort の戻り)。
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
  const repo = row.repo;
  const wsLabel = row.ws;
  const titleCell = (
    <span class="session-title" title={title}>
      {title}
    </span>
  );
  // An agent-only row has no repo/ws at all (the agents rows carry no VCS
  // metadata), and rendering its first line empty would strand the avatar on
  // a blank line above the title — so for those rows the title takes the
  // first line's place. It keeps the dim styling r135m18 asks for; what moves
  // is only WHERE it sits, never what it says.
  const hasRepoWs = Boolean(repo || wsLabel);
  const badges = sessionBadges(row);
  const liveState = formatAgentLiveState(row.agent);
  const idleMs = row.last_activity_at
    ? Date.now() - new Date(row.last_activity_at).getTime()
    : null;

  const titleParts = [row.cwd];
  // The row itself now shows repo@ws but not branch (kawaz r135m16's four
  // elements have no slot for it); hover keeps it reachable.
  if (row.branch) titleParts.push(`branch: ${row.branch}`);
  if (row.connected_at) titleParts.push(`connected: ${row.connected_at}`);
  if (row.last_activity_at) titleParts.push(`last activity: ${row.last_activity_at}`);
  if (liveState) titleParts.push(`status: ${liveState}`);
  else if (row.agent) titleParts.push("hooks module 無し: 応答中かは分からない");
  if (row.agent) {
    titleParts.push(`kind: ${row.agent.kind}`);
    titleParts.push(`started: ${new Date(row.agent.startedAt).toISOString()}`);
  }
  if (!row.connected) titleParts.push("ccmsg 未起動 (agents の行のみで検出)");
  // 停止理由は行内には 1 行分しか出せない (下の session-error-text は CSS で
  // 省略される) ので、全文は hover の title 側で読めるようにしておく。
  if (row.api_error)
    titleParts.push(
      `API error${row.api_error.kind !== undefined ? ` ${row.api_error.kind}` : ""} (${row.api_error.timestamp}):\n${row.api_error.text}`,
    );
  const staleClient = staleClientWarning(row);
  if (staleClient) titleParts.push(staleClient.text);

  return (
    <li
      class={row.sid === currentSid ? "active session-row" : "session-row"}
      title={titleParts.join("\n")}
      onClick={selectSessionOnRowClick(row.sid)}
    >
      <div class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}>
        <span class={row.connected ? "session-lead" : "session-lead session-disconnected"}>
          {/* prompt cache が生きている間だけアイコンの枠に輪が重なり、窓が
           * 閉じるまでかけて時計回りに欠けていく (CacheRing.tsx)。緑は会話が
           * 作った窓、黄は合図で延命している分 (llm-cache-view.ts)。
           * ラッパーはリングの有無に関わらず常設する: 条件付きで包むと
           * Avatar が remount され、リング開始のたびに再描画が走る。 */}
          <span
            class={ring ? `session-avatar-ring ${ring.class}` : "session-avatar-ring"}
            style={ring?.style}
          >
            <Avatar seed={row.sid} size={16} />
            {ring ? <CacheRing shape="rect" /> : null}
          </span>
          {/* 古い ccmsg クライアント (典型的には upgrade 前から回り続けている
           * subscribe) は、拒否され続けても行の見た目を一切動かさない。未読
           * say と同じ「repo 名の直前」に出して、そのセッションだけの問題だと
           * 一目で分かるようにする。 */}
          {staleClient ? (
            <span
              class="session-stale-client"
              title={staleClient.text}
              aria-label="ccmsg クライアントが古い"
            >
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
        {liveState ? (
          <span
            class={
              "session-live-dot" +
              (row.agent?.turn?.state === "responding" ? " session-live-dot-running" : "") +
              (row.agent?.status === "waiting" ? " session-live-dot-waiting" : "")
            }
            title={liveState}
            aria-label={liveState}
          />
        ) : null}
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
        {idleMs !== null && <span class="session-idle">{formatDuration(idleMs)}</span>}
      </div>
      {/* 停止理由 (harness API エラー): なぜ止まっているかが分からないと
       * Error セクションに居ること自体が action に繋がらないので、色分けだけ
       * でなく本文も出す。"API Error: 500 {...}" のような長い JSON が来るため
       * 1 行に truncate (全文は上の title に入っている)。1 行目の badge 群とは
       * 別の行に置いて statusBadge の並びを崩さない。 */}
      {row.api_error ? <div class="session-error-text">{row.api_error.text}</div> : null}
      {/* 2 行目: セッション自身のタイトル (= /rename が設定し Claude Code が
       * name として返す文字列)。r135m17 で 1 行目から降り、以下 3 行は弱い
       * 文字 (r135m18)。repo/ws が無い行では上の 1 行目がこの内容を引き取って
       * いるので、ここは出さない。 */}
      {hasRepoWs ? <div class="session-line2">{titleCell}</div> : null}
      {/* 3 行目: セッション UUID 全長 (kawaz r135m16)。短縮しないのは、この行
       * の用途が「他所に貼るために丸ごとコピーする」ことだから。 */}
      <div class="session-line3">
        <span class="session-sid" title={row.sid}>
          {row.sid}
        </span>
        <SessionModelEffort info={modelEffort} />
        <KeepaliveControl sid={row.sid} request={cacheRequest} />
      </div>
      {/* 4 行目: project path。左を省略して右端 (= worktree 名まで) を常時
       * 見せる。全文は行の title 属性で読める。 */}
      <div class="session-line4" title={row.cwd}>
        <span class="session-cwd">
          {/* direction:rtl が ellipsis を行頭側へ回す一方、パスの `/` のような
           * 中立文字はその方向で並べ替えられてしまう (`/a/b` が `a/b/` に
           * 見える)。中身を bdi の LTR 分離レベルに閉じ込めると、並べ替えは
           * 外側の 1 要素だけに効き、パス本文は元の順序のまま残る。 */}
          <bdi dir="ltr">{row.cwd}</bdi>
        </span>
      </div>
    </li>
  );
}

/** One row of the sidebar's Pinned section (DR-0021 §2.4/§3.2). Deliberately
 * NOT a `SessionRowItem` reuse — a pinned entry is a `Pin`, not
 * a `SessionRow` (no `agent`/`connected_at`/`last_activity_at` to show), and
 * forcing it through the same merge shape `toSessionRow` builds would need a
 * lot of made-up filler fields. What it does share is the four-element
 * layout (`repo@ws` / title / full sid / path, kawaz r135m16) and the two live
 * sources those elements come from when this pin's session is running: `peer`
 * supplies repo/ws and decides the badge text (no peer = "仮想", the daemon
 * resolves this sid via allowVirtual, DR-0021 §3.1), `agent` supplies the
 * title — see pinnedSessionLabel / pinnedSessionTitle, which fall back to the
 * pin's own frozen record when the session is not running. Every pin enters
 * through the session root so recent restoration is identical to a live
 * session row. */
function PinnedSessionRow({
  pin,
  currentSid,
  peer,
  agent,
  modelEffort,
  sayUnread,
  permitUnread,
  onUnpin,
}: {
  pin: Pin;
  currentSid: string | null;
  peer: PeerInfo | undefined;
  agent: AgentInfo | undefined;
  /** sid の右に出す `{model} {effort}`。走っているピンなら live 観測、止まって
   * いるピンなら検索ヒットに凍結された値が採用される (SessionList の
   * resolveModelEffort 参照)。 */
  modelEffort: ModelEffortInfo | null;
  /** 未読の say 件数。ピンは下の status セクションから除外されている
   * (SessionList の filter) ので、ここに出さないとピン留めしたセッションの
   * 🔔 がどこにも出なくなる。 */
  sayUnread: number;
  /** 未読の許可依頼の件数。ピンに出す理由は sayUnread と同じ。 */
  permitUnread: number;
  onUnpin: () => void;
}) {
  const { repo, ws: wsLabel } = pinnedSessionLabel(pin, peer);
  // Same tail as sessionRowTitle: a pin whose session never renamed itself
  // (and whose transcript held no custom-title for Session Search to read)
  // still gets a non-blank line rather than a gap where a title goes.
  const title =
    pinnedSessionTitle(pin, agent) || lastPathSegment(pin.cwd ?? "") || shortSid(pin.sid);
  const titleCell = (
    <span class="session-title" title={title}>
      {title}
    </span>
  );
  // With no repo/ws to print, the title takes the first line's place instead
  // of leaving the avatar stranded on a blank one (SessionRowItem's own
  // hasRepoWs branch, same reasoning).
  const hasRepoWs = Boolean(repo || wsLabel);

  return (
    <li
      class={pin.sid === currentSid ? "active session-row" : "session-row"}
      title={pin.cwd ?? undefined}
      onClick={selectSessionOnRowClick(pin.sid)}
    >
      <div class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}>
        <span class="session-lead">
          <Avatar seed={pin.sid} size={16} />
        </span>
        <SessionRowBadges sid={pin.sid} sayUnread={sayUnread} permitUnread={permitUnread} />
        <a href={sessionHref(pin.sid)} class="session-main-link">
          {repo ? <span class="session-line1-repo">{repo}</span> : null}
          {wsLabel ? <span class="session-line1-ws">{repo ? `@${wsLabel}` : wsLabel}</span> : null}
          {hasRepoWs ? null : titleCell}
        </a>
        {peer === undefined ? (
          <span
            class="session-badge session-badge-offline"
            title="ccmsg 未接続 (daemon の仮想 session 経由で閲覧)"
          >
            仮想
          </span>
        ) : null}
        <button
          type="button"
          class="pinned-unpin-btn"
          aria-label="ピン解除"
          title="ピン解除"
          onClick={onUnpin}
        >
          ⭐
        </button>
      </div>
      {hasRepoWs ? <div class="session-line2">{titleCell}</div> : null}
      <div class="session-line3">
        <span class="session-sid" title={pin.sid}>
          {pin.sid}
        </span>
        <SessionModelEffort info={modelEffort} />
      </div>
      {pin.cwd ? (
        <div class="session-line4" title={pin.cwd}>
          <span class="session-cwd">
            <bdi dir="ltr">{pin.cwd}</bdi>
          </span>
        </div>
      ) : null}
    </li>
  );
}

/** Sidebar "Pinned" section (DR-0021 §2.4/§3.2): always shown when at least
 * one directory is pinned, positioned above the status-grouped sections below
 * — pins are a deliberate user choice ("I want to keep finding this one"),
 * so they stay visible regardless of the search panel being open/closed
 * (see Sidebar.tsx's doc comment).
 *
 * A pinned sid appears here and nowhere else among the status sections below:
 * SessionList filters them out before grouping (kawaz 2026-08-31), because a
 * pinned row already prefers the live PeerInfo/AgentInfo when the session is
 * connected, so the second copy carried no information the first one lacked.
 *
 * A pin is a directory, and the rows under it are pinnedRows' answer: every
 * connected session in that directory, else the session frozen at pin time.
 * The count in the summary is of pinned directories. */
function PinnedSessionsSection({
  pinnedSessions,
  peers,
  agentsBySid,
  currentSid,
  sayUnreadBy,
  permitUnreadBy,
  resolveModelEffort,
}: {
  pinnedSessions: Map<string, Pin>;
  peers: readonly PeerInfo[];
  /** agents rows keyed by sid — the section's source for a
   * live session's title, indexed once by SessionList for both it and the
   * status sections below. */
  agentsBySid: Map<string, AgentInfo>;
  currentSid: string | null;
  /** sid → 未読 say 件数 (SessionList が unreadSays から数えたもの)。 */
  sayUnreadBy: Map<string, number>;
  /** sid → 未読の許可依頼の件数 (SessionList が permitUnread から数えたもの)。 */
  permitUnreadBy: Map<string, number>;
  /** SessionList が組み立てた model/effort の解決子 — ピンは live/凍結の両方を
   * 供給元に持つので、第 2 引数に凍結値 (検索ヒット) を渡す。 */
  resolveModelEffort: (sid: string, frozen?: ModelEffortSource) => ModelEffortInfo | null;
}) {
  const { store } = useApp();
  const rows = useMemo(
    () => pinnedRows(pinnedSessions, peers, agentsBySid),
    [pinnedSessions, peers, agentsBySid],
  );
  const peersBySid = useMemo(() => new Map(peers.map((p) => [p.sid, p] as const)), [peers]);
  if (rows.length === 0) return null;
  return (
    <Fold
      open
      class="session-section pinned-section"
      summaryClass="session-section-summary"
      summary={`Pinned (${pinnedSessions.size})`}
    >
      <ul class="session-section-list">
        {rows.map(({ key, pin }) => (
          <PinnedSessionRow
            key={pin.sid}
            pin={pin}
            currentSid={currentSid}
            peer={peersBySid.get(pin.sid)}
            agent={agentsBySid.get(pin.sid)}
            modelEffort={resolveModelEffort(pin.sid, pin)}
            sayUnread={sayUnreadBy.get(pin.sid) ?? 0}
            permitUnread={permitUnreadBy.get(pin.sid) ?? 0}
            onUnpin={() => store.dispatch({ type: "pinned/removed", key })}
          />
        ))}
      </ul>
    </Fold>
  );
}

/** Extra class for a status section's `<Fold>`, for the two sections that
 * need the reader's attention:
 * - `waiting`: ユーザ対応を促す強調 (warn 色 + 跳ねアニメーション、
 *   composer-fab-draft と同系。kawaz r46 mid=42)
 * - `error`: harness API エラーで停止中 (danger 色)。跳ねは付けない —
 *   同時に出た時 waiting と見分けが付かなくなるため、区別は色だけで付ける。
 * Kept as a lookup rather than a chain of ternaries in the JSX: a third
 * highlighted section would otherwise nest the conditional one level deeper
 * each time. */
const SESSION_SECTION_CLASS: Record<string, string> = {
  waiting: "session-section session-section-waiting",
  error: "session-section session-section-error",
};

function sectionClass(key: string): string {
  return SESSION_SECTION_CLASS[key] ?? "session-section";
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
    />
  );
}

function sessionListSlice(state: AppState) {
  return {
    agents: state.agents,
    sessionStatuses: state.sessionStatuses,
    sessionErrors: state.sessionErrors,
    llmRequests: state.llmRequests,
    pinnedSessions: state.pinnedSessions,
    unreadSays: state.unreadSays,
    permitUnread: state.permitUnread,
  };
}

/** Sidebar "Sessions" section (U1, developed from the DR-0008 peers list):
 * merges the ccmsg-connected `peers` (pre-sorted by Sidebar's name/created/
 * recent toggle — this component never reorders those) with the daemon's
 * agents rows (`agents`, read from the store with the rest of
 * `sessionListSlice`) so a session the agents rows list but whose ccmsg CLI hasn't connected yet still shows up, grouped
 * as its own "ccmsg 未起動" tail (see offlineAgentRows).
 *
 * U3 (kawaz 2026-07-11: "busy 表示邪魔。リスト側に busy とかのやつでセクション
 * 切ってフォルディングもできるように"): the merged rows are further split
 * into per-status sections (groupSessionsBySection, statuses as
 * sessionStatus's doc comment says), each its own `<Fold open>` so a section
 * can be collapsed — sort order (name/created/recent) still applies *within*
 * each section. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: readonly PeerInfo[];
  currentSid: string | null;
}) {
  useTick(TICK_MS);
  const { store } = useApp();
  const {
    agents,
    sessionStatuses,
    sessionErrors,
    llmRequests,
    pinnedSessions,
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
  // kawaz r259m64 (2026-09-04): ピン留めされたセッションも status セクション
  // に出す。以前は「Pinned に居る行は Busy から除外」だったが、行の並びが
  // prompt 順 (最後にユーザ入力した順) になったことで、status セクション側の
  // 位置にも読む価値が戻った (ピンは固定表示、こちらは時系列の位置)。
  const sections = useMemo(() => groupSessionsBySection(rows), [rows]);
  // 行に出す model/effort の供給元は 3 つあり、確度の高い順に並べる:
  //   1. context 観測 — model と effort の両方を持つが、entry があるのは
  //      SessionView が Status/Timeline を開いている sid だけ (statusBadge と
  //      同じ購読事情、下のコメント参照)。
  //   2. gateway の直近 LLM リクエスト — 全 sid 分がまとめて届くので購読に
  //      左右されないが、model しか分からない (effort は request に無い)。
  //   3. 呼び出し側が持つ凍結値 (ピンの検索ヒット等) — 走っていないセッション
  //      でも「最後に何で走っていたか」は答えられる。
  const resolveModelEffort = useMemo(
    () => (sid: string, frozen?: ModelEffortSource) =>
      formatSessionModelEffort([
        sessionStatuses.get(sid)?.context,
        { model: llmRequests.get(sid)?.model },
        frozen,
      ]),
    [sessionStatuses, llmRequests],
  );
  return (
    <div id="session-list">
      <PinnedSessionsSection
        pinnedSessions={pinnedSessions}
        peers={peers}
        agentsBySid={agentsBySid}
        currentSid={currentSid}
        sayUnreadBy={sayUnreadBy}
        permitUnreadBy={permitUnreadBy}
        resolveModelEffort={resolveModelEffort}
      />
      {sections.map((section) => (
        <Fold
          key={section.key}
          open
          class={sectionClass(section.key)}
          summaryClass="session-section-summary"
          summary={`${section.label} (${section.rows.length})`}
        >
          <ul class="session-section-list">
            {section.rows.map((row) => (
              <SessionRowItem
                key={row.sid}
                row={row}
                currentSid={currentSid}
                // kawaz r99m1: Pinned にも同じ sid が出ている場合、選択中の
                // 二重ハイライトが紛らわしいので、こちら (下側) を弱める。
                // DR-0020 §2.1 (a) 実装コスト判断: 全 peer 分を常時
                // subscribe すると常駐コストが人数分乗るため、SessionView が
                // 実際に Status/Timeline タブを開いているセッションだけ
                // sessionStatuses に entry を持つ (SessionView.tsx の購読
                // effect 参照)。よってバッジが出るのは currentSid の行だけ
                // — 他行は subscribe していないので常に null (「ゼロ件」で
                // はなく「未購読」、意図的にバッジ非表示のまま)。
                statusBadge={
                  row.sid === currentSid ? formatSidebarBadge(sessionStatuses.get(row.sid)) : null
                }
                // statusBadge と違い全行に出す: prompt cache は daemon 側で
                // 全 sid 分まとめて届くので、購読の有無に左右されない。
                modelEffort={resolveModelEffort(row.sid)}
                cacheRequest={llmRequests.get(row.sid) ?? null}
                sayUnread={sayUnreadBy.get(row.sid) ?? 0}
                permitUnread={permitUnreadBy.get(row.sid) ?? 0}
              />
            ))}
          </ul>
        </Fold>
      ))}
    </div>
  );
}
