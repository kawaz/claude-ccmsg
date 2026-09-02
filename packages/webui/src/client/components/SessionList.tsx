import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentInfo, LastLiveSession, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import { sessionHref } from "../locator.ts";
import { pushNavigation } from "../navigation.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { setSidDragPayload } from "../dnd.ts";
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
  formatRelativeAge,
  groupSessionsBySection,
  indexAgentsBySid,
  lastPathSegment,
  offlineAgentRows,
  sessionRowTitle,
  sessionBadges,
  shortSid,
  sortPinnedSessions,
  toSessionRow,
  sayUnreadBySid,
  type SessionRow,
} from "../utils.ts";
import { pinnedSessionLabel, pinnedSessionTitle } from "../pinned-sessions.ts";
import {
  lastLiveResumePrefill,
  lastLiveSessionTitle,
  sortLastLiveSessions,
  visibleLastLiveSessions,
} from "../last-live-sessions.ts";
import { Avatar } from "../avatar.tsx";
import { useCacheRing } from "../useCacheRing.ts";
import { CopyButton } from "./CopyButton.tsx";
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

/** How long a rename's outcome note stays on the row before clearing itself.
 * Not a poll: the note has no state to wait for (the authoritative title
 * arrives on its own via the agents poll), it just must not become permanent
 * sidebar furniture. */
const RENAME_NOTE_MS = 6000;

/** How long the session-id copy confirmation stays up — same 1.5s as
 * StatusPanel's CopyButton, so the two copy affordances feel identical. */
const COPIED_MARK_MS = 1500;

/** Shift+hover arming for a row's inert-by-default text (kawaz r135m41/42).
 * The sid and the title are primarily things to READ and select with the
 * mouse; their actions (copy, rename) fire only while Shift is held, so an
 * ordinary click can never trigger them. `armed` drives the affordance so the
 * two stay in sync — nothing looks clickable at a moment when clicking would
 * do nothing.
 *
 * The keydown/keyup listeners exist only while the pointer is over the
 * element (so Shift pressed *after* the pointer arrives still arms it) rather
 * than one always-on pair per row: the sidebar renders one of these per
 * session, twice. Entering resyncs from the event's own `shiftKey`, which
 * covers the state going stale while unhovered (Shift released over another
 * window, etc.). */
function useShiftHover(): {
  armed: boolean;
  handlers: { onMouseEnter: (e: MouseEvent) => void; onMouseLeave: () => void };
} {
  const [hovered, setHovered] = useState(false);
  const [shift, setShift] = useState(false);
  useEffect(() => {
    if (!hovered) return;
    const sync = (e: KeyboardEvent) => setShift(e.shiftKey);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
    };
  }, [hovered]);
  return {
    armed: hovered && shift,
    handlers: {
      onMouseEnter: (e: MouseEvent) => {
        setShift(e.shiftKey);
        setHovered(true);
      },
      onMouseLeave: () => setHovered(false),
    },
  };
}

/** 行アイテム全体をセッション選択にする click ハンドラ。行の
 * 中で実際に文字があるのは 1 行目の `<a>` だけで、他の 3 行や行末の余白は
 * どれだけ広くても不感帯だった — 見た目が 1 個のカードなら、カードのどこを
 * 押しても選択になるのが読み手の期待。
 *
 * 素通しする (= 行選択を起こさない) のは 4 つ:
 * - **Shift 押下中**: sid コピー / タイトル編集など、中の各パーツが自分の
 *   Shift 操作を持っている (useShiftHover)。押している間はパーツの担当。
 * - **`a` / `button` / `input` などの上**: それぞれ自前の答えを持つ。1 行目の
 *   `<a>` は同じ遷移先なので二重発火を避けるだけだが、⭐ / ▶ ボタンは
 *   「選択」とは別の操作なので拾わせてはいけない。
 * - **修飾キー付き**: Cmd/Ctrl/Alt+click は「新しいタブで」等のブラウザ側の
 *   意味を持つ。行の余白でそれを横取りしても行き先は用意できない。
 * - **テキスト選択が残っている時**: sid や path はマウスでなぞって読む対象
 *   (SessionIdText の doc 参照)。ドラッグ選択の終わりにも click は飛ぶので、
 *   選択が生きている間は遷移させない。
 *
 * キーボード経路は 1 行目の `<a>` がそのまま担う (行に role="button" +
 * tabIndex を足すと、同じ行き先に tab stop が 2 つ並ぶだけになる)。 */
function selectSessionOnRowClick(sid: string): (e: MouseEvent) => void {
  return (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as Element | null;
    if (target?.closest("a, button, input, textarea, select, summary")) return;
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

/** The session id, Shift+click-to-copy (kawaz r135m41). Plain text otherwise
 * — it is long, it is what the reader came to this line for, and a button
 * would both invite a click that is no longer wanted and fight the text
 * selection that is.
 *
 * A successful copy is reported by the shared CopyButton beside it (a ✓ for
 * 1.5s); the id itself only tints to the same accent, so that a Shift+click —
 * which never touches the button — still says something happened. A clipboard
 * rejection (insecure context, permission denied) shows nothing: the id is
 * fully visible in the row either way, and a success mark for a copy that did
 * not happen is worse than no mark. */
function SessionIdText({ sid }: { sid: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  const { armed, handlers } = useShiftHover();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  function markCopied(): void {
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_MARK_MS);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sid);
      markCopied();
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <span
        class={`session-sid${armed ? " armed" : ""}${copied ? " copied" : ""}`}
        title={`${sid}\nShift+クリックでコピー`}
        onClick={(e) => {
          if (e.shiftKey) void copy();
        }}
        {...handlers}
      >
        {sid}
      </span>
      {/* タップ用のコピー導線 (kawaz r244m20)。Shift+クリックはポインタと
       * 修飾キーが要るのでタッチ端末では踏めない — webui 共通のコピーボタン
       * (StatusPanel のメタ情報と同じもの) を sid の右に常設する。行 click は
       * button 上で素通しになる (selectSessionOnRowClick) ので、遷移との競合は
       * ない。成功の ✓ はボタン側が出すので、こちらは sid の色だけ合わせる。 */}
      <CopyButton value={sid} label="セッション ID" compact onCopied={markCopied} />
    </>
  );
}

/** The session's own title, editable in place (kawaz r135m42): plain text
 * that Shift+hover arms and Shift+click turns into an input *in the same
 * slot*, so the row neither grows a control of its own nor changes height
 * while editing.
 *
 * `editable` is false where the daemon has no terminal to type into
 * (session_rename answers `terminal_unavailable` without a hyoui session) —
 * arming an interaction that can only fail would be worse than leaving the
 * text inert.
 *
 * Being a lone input with no buttons, it can settle on plain Enter (no
 * Shift+Enter requirement as in RoomTitle, whose [保存] button is what a bare
 * Enter would otherwise race) and dismiss on plain blur (RoomTitle needs
 * outside-pointer detection precisely because a blur would eat its button's
 * click). Escape cancels either way. An IME's confirming Enter arrives with
 * `isComposing`, and the blur a candidate window can provoke is masked while
 * a composition is open — neither must be read as "the user is done".
 *
 * What this cannot do is show the result: `session_rename` only types
 * `/rename <title>` into the session's terminal (see SessionRenameRequest),
 * so a success closes the editor and leaves a "送信した" note while the row's
 * headline keeps reporting whatever `claude agents` reports, until a later
 * poll confirms it (or doesn't). */
function SessionTitle({
  sid,
  title,
  editable,
  onSent,
}: {
  sid: string;
  title: string;
  editable: boolean;
  onSent: (title: string) => void;
}) {
  const { ws } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { armed, handlers } = useShiftHover();
  // Escape and blur can both fire within one frame; only the first settles.
  const settledRef = useRef(false);
  // Read synchronously by the blur handler so that clicking away mid-send
  // cannot cancel the editor the pending error needs to land in.
  const savingRef = useRef(false);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // `autoFocus` is not enough here: the mousedown that opens the editor has
  // already focused the row's link (an agent-only row renders the title
  // inside it), and that focus survives the re-render. Without the input
  // holding focus, neither Enter nor blur — this editor's only two exits —
  // could ever fire. Selecting the draft as well matches what the click
  // asked for: replace this title.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function startEditing(): void {
    settledRef.current = false;
    savingRef.current = false;
    setDraft(title);
    setEditing(true);
  }

  function close(): void {
    setEditing(false);
    setError(null);
  }

  function cancel(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    close();
  }

  async function confirm(): Promise<void> {
    if (settledRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      cancel();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await ws.sessionRename(sid, trimmed);
      if (!res.ok) {
        // Keep the editor open with the draft intact so the user can fix a
        // rejected title (control characters, too long) or retry a failed
        // send without retyping.
        setError(res.error.msg);
        return;
      }
      settledRef.current = true;
      close();
      onSent(res.title);
    } catch {
      setError("接続エラーのため送信できませんでした");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    void confirm();
  }

  if (editing) {
    return (
      <span class="session-title-edit">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          // readOnly, not disabled: disabling the focused input blurs it, and
          // a rejected send would then leave its error stranded on an editor
          // the user can no longer type in or dismiss by clicking away.
          readOnly={saving}
          maxLength={200}
          placeholder="Enter で送信, Escape で中止"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onBlur={() => {
            if (savingRef.current || composingRef.current) return;
            cancel();
          }}
        />
        {error && <span class="session-rename-error">{error}</span>}
      </span>
    );
  }

  return (
    <>
      <span
        class={`session-title${editable && armed ? " armed" : ""}`}
        title={editable ? `${title}\nShift+クリックでタイトルを変更` : title}
        onClick={(e) => {
          if (!editable || !e.shiftKey) return;
          // An agent-only row renders this title inside the row's link (see
          // SessionRowItem's `hasRepoWs` branch); arming must not also navigate.
          e.preventDefault();
          startEditing();
        }}
        {...(editable ? handlers : {})}
      >
        {title}
      </span>
      {/* タップ用の編集導線 (kawaz r244m20)。記号は RoomTitle / SessionCreator
       * の編集ボタンと同じ ✎ — webui で「その場で書き換える」操作はどこでも
       * この字。Shift+クリックと同じ編集モードに
       * 入るだけで、編集可否の条件も同じ — editable でない行には出さない
       * (押しても失敗しかしない導線を置かない、という上の doc と同じ理由)。
       * repo/ws を持たない行ではこのタイトルが行の <a> の中に描かれるので、
       * 既定の遷移を止めてから編集を開く。 */}
      {editable ? (
        <button
          type="button"
          class="session-inline-icon-btn"
          title="タイトルを変更"
          aria-label="タイトルを変更"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            startEditing();
          }}
        >
          ✎
        </button>
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
  cacheTs,
  sayUnread,
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
  /** この sid の最後の LLM リクエスト時刻 (epoch 秒) — アイコンに巻く prompt
   * cache リング (5 分で消える) の起点。null = 直近 5 分にリクエスト無し、
   * または daemon が gateway の event stream を購読していない (どちらもリング
   * 非表示)。kawaz r99m29: 行に要素は足さず、既存アイコンのボーダーで示す。 */
  cacheTs: number | null;
  /** 未読の `ccmsg say` 件数 (kawaz r244 m5-m6)。0 = マーカーを出さない。
   * 複数セッションが並走している時に「今喋ったのはどれか」を行から辿れる
   * ようにするためのもので、既読は 1on1 room の 📣 バブル側で付ける。 */
  sayUnread: number;
}) {
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const ring = useCacheRing(cacheTs);
  const title = sessionRowTitle(row);
  // Straight from the row: a session that announced no repo/ws shows neither
  // (kawaz r135m16: 欠けたら欠けたなり). No substitute is invented here — the
  // one that used to exist borrowed the agent's name, which the title line
  // already shows.
  const repo = row.repo;
  const wsLabel = row.ws;
  const titleCell = (
    <SessionTitle
      sid={row.sid}
      title={title}
      editable={Boolean(row.agent?.hyoui_session_id)}
      onSent={(sent) => setRenameNote(`/rename を送信: ${sent}`)}
    />
  );
  // An agent-only row has no repo/ws at all (claude agents reports no VCS
  // metadata), and rendering its first line empty would strand the avatar on
  // a blank line above the title — so for those rows the title takes the
  // first line's place. It keeps the dim styling r135m18 asks for; what moves
  // is only WHERE it sits, never what it says.
  const hasRepoWs = Boolean(repo || wsLabel);

  useEffect(() => {
    if (renameNote === null) return;
    const id = setTimeout(() => setRenameNote(null), RENAME_NOTE_MS);
    return () => clearTimeout(id);
  }, [renameNote]);
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
  if (row.agent) {
    titleParts.push(`kind: ${row.agent.kind}`);
    titleParts.push(`started: ${new Date(row.agent.startedAt).toISOString()}`);
  }
  if (!row.connected) titleParts.push("ccmsg 未起動 (claude agents のみで検出)");
  // 停止理由は行内には 1 行分しか出せない (下の session-error-text は CSS で
  // 省略される) ので、全文は hover の title 側で読めるようにしておく。
  if (row.api_error)
    titleParts.push(`API error (${row.api_error.timestamp}):\n${row.api_error.text}`);

  return (
    <li
      class={row.sid === currentSid ? "active session-row" : "session-row"}
      title={titleParts.join("\n")}
      onClick={selectSessionOnRowClick(row.sid)}
    >
      <div
        class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}
        // DR-0011 §1-4: drag onto a room's chat area to invite this session.
        // Only meaningful for a connected (ccmsg-started) row — invite needs
        // the sid to be in the daemon's live connection registry, which an
        // agents-only row (row.connected === false, "ccmsg 未起動") never is.
        draggable={row.connected}
        onDragStart={
          row.connected
            ? (e) => {
                if (e.dataTransfer) setSidDragPayload(e.dataTransfer, row.sid);
              }
            : undefined
        }
      >
        <a
          // Session rows always enter through the session root so the router can
          // restore that sid's recent tab/path. With no recent record the root
          // falls back to Timeline/head.
          href={sessionHref(row.sid)}
          class={row.connected ? "session-main-link" : "session-main-link session-disconnected"}
        >
          {/* prompt cache が生きている間だけアイコンに緑リングが巻かれ、
           * 5 分かけて時計回りに消える (app.css の .cache-ring)。ラッパーは
           * リングの有無に関わらず常設する: 条件付きで包むと Avatar が
           * remount され、リング開始のたびに再描画が走る。 */}
          <span
            class={ring ? `session-avatar-ring ${ring.class}` : "session-avatar-ring"}
            style={ring?.style}
          >
            <Avatar seed={row.sid} size={16} />
          </span>
          {/* 未読 say の 📣 は repo 名の直前 (kawaz r244m13: 行末の弱い
           * badge 位置では絶対気づかない)。1 行目の視線の起点 = アイコンと
           * repo の間に割り込ませて、鳴ったことを見逃させない。 */}
          {sayUnread > 0 ? (
            <span
              class="session-say-unread"
              title={`未読の say ${sayUnread} 件 — 1on1 room の say バブルで既読にできます`}
              aria-label={`未読の say ${sayUnread} 件`}
            >
              📣{sayUnread > 1 ? sayUnread : ""}
            </span>
          ) : null}
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
              (row.agent?.status === "running" ? " session-live-dot-running" : "") +
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
      {/* 2 行目: セッション自身のタイトル (= /rename が設定し claude agents が
       * name として返す文字列)。r135m17 で 1 行目から降り、以下 3 行は弱い
       * 文字 (r135m18)。repo/ws が無い行では上の 1 行目がこの内容を引き取って
       * いるので、ここは出さない。 */}
      {hasRepoWs ? <div class="session-line2">{titleCell}</div> : null}
      {/* Best-effort の顛末 (SessionRenameRequest 参照): 「送った」までしか
       * 言えないので、タイトル自体は agents poll が更新するまで元のまま。 */}
      {renameNote ? <div class="session-rename-note">{renameNote}</div> : null}
      {/* 3 行目: セッション UUID 全長 (kawaz r135m16)。短縮しないのは、この行
       * の用途が「他所に貼るために丸ごとコピーする」ことだから。 */}
      <div class="session-line3">
        <SessionIdText sid={row.sid} />
        <SessionModelEffort info={modelEffort} />
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
 * NOT a `SessionRowItem` reuse — a pinned entry is a `SessionSearchHit`, not
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
  hit,
  currentSid,
  peer,
  agent,
  modelEffort,
  sayUnread,
  onUnpin,
}: {
  hit: SessionSearchHit;
  currentSid: string | null;
  peer: PeerInfo | undefined;
  agent: AgentInfo | undefined;
  /** sid の右に出す `{model} {effort}`。走っているピンなら live 観測、止まって
   * いるピンなら検索ヒットに凍結された値が採用される (SessionList の
   * resolveModelEffort 参照)。 */
  modelEffort: ModelEffortInfo | null;
  /** 未読の `ccmsg say` 件数。ピンは下の status セクションから除外されている
   * (SessionList の filter) ので、ここに出さないとピン留めしたセッションの
   * 📣 がどこにも出なくなる。 */
  sayUnread: number;
  onUnpin: () => void;
}) {
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const { repo, ws: wsLabel } = pinnedSessionLabel(hit, peer);
  // Same tail as sessionRowTitle: a pin whose session never renamed itself
  // (and whose transcript held no custom-title for Session Search to read)
  // still gets a non-blank line rather than a gap where a title goes.
  const title =
    pinnedSessionTitle(hit, agent) || lastPathSegment(hit.cwd ?? "") || shortSid(hit.sid);
  // Editable on exactly the condition SessionRowItem uses — the daemon needs a
  // hyoui terminal to type `/rename` into, which only a running session has.
  // An offline pin's title is therefore plain text, not an editor that could
  // only fail.
  const titleCell = (
    <SessionTitle
      sid={hit.sid}
      title={title}
      editable={Boolean(agent?.hyoui_session_id)}
      onSent={(sent) => setRenameNote(`/rename を送信: ${sent}`)}
    />
  );
  // With no repo/ws to print, the title takes the first line's place instead
  // of leaving the avatar stranded on a blank one (SessionRowItem's own
  // hasRepoWs branch, same reasoning).
  const hasRepoWs = Boolean(repo || wsLabel);

  useEffect(() => {
    if (renameNote === null) return;
    const id = setTimeout(() => setRenameNote(null), RENAME_NOTE_MS);
    return () => clearTimeout(id);
  }, [renameNote]);

  return (
    <li
      class={hit.sid === currentSid ? "active session-row" : "session-row"}
      title={hit.cwd ?? undefined}
      onClick={selectSessionOnRowClick(hit.sid)}
    >
      <div class={hasRepoWs ? "session-line1" : "session-line1 session-line1-titled"}>
        <a href={sessionHref(hit.sid)} class="session-main-link">
          <Avatar seed={hit.sid} size={16} />
          {/* 📣 の位置は SessionRowItem と同じ「アイコンと repo の間」
           * (kawaz r244m13)。 */}
          {sayUnread > 0 ? (
            <span
              class="session-say-unread"
              title={`未読の say ${sayUnread} 件 — 1on1 room の say バブルで既読にできます`}
              aria-label={`未読の say ${sayUnread} 件`}
            >
              📣{sayUnread > 1 ? sayUnread : ""}
            </span>
          ) : null}
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
      {renameNote ? <div class="session-rename-note">{renameNote}</div> : null}
      <div class="session-line3">
        <SessionIdText sid={hit.sid} />
        <SessionModelEffort info={modelEffort} />
      </div>
      {hit.cwd ? (
        <div class="session-line4" title={hit.cwd}>
          <span class="session-cwd">
            <bdi dir="ltr">{hit.cwd}</bdi>
          </span>
        </div>
      ) : null}
    </li>
  );
}

/** Sidebar "Pinned" section (DR-0021 §2.4/§3.2): always shown when at least
 * one session is pinned, positioned above the status-grouped sections below
 * — pins are a deliberate user choice ("I want to keep finding this one"),
 * so they stay visible regardless of the search panel being open/closed
 * (see Sidebar.tsx's doc comment).
 *
 * A pinned sid appears here and nowhere else among the status sections below:
 * SessionList filters them out before grouping (kawaz 2026-08-31), because a
 * pinned row already prefers the live PeerInfo/AgentInfo when the session is
 * connected, so the second copy carried no information the first one lacked. */
function PinnedSessionsSection({
  pinnedSessions,
  peers,
  agentsBySid,
  currentSid,
  sayUnreadBy,
  resolveModelEffort,
}: {
  pinnedSessions: Map<string, SessionSearchHit>;
  peers: PeerInfo[];
  /** `claude agents --json` rows keyed by sid — the section's source for a
   * live session's title, indexed once by SessionList for both it and the
   * status sections below. */
  agentsBySid: Map<string, AgentInfo>;
  currentSid: string | null;
  /** sid → 未読 say 件数 (SessionList が rooms から引いたもの)。 */
  sayUnreadBy: Map<string, number>;
  /** SessionList が組み立てた model/effort の解決子 — ピンは live/凍結の両方を
   * 供給元に持つので、第 2 引数に凍結値 (検索ヒット) を渡す。 */
  resolveModelEffort: (sid: string, frozen?: ModelEffortSource) => ModelEffortInfo | null;
}) {
  const { store } = useApp();
  const pins = useMemo(() => sortPinnedSessions([...pinnedSessions.values()]), [pinnedSessions]);
  const peersBySid = useMemo(() => new Map(peers.map((p) => [p.sid, p] as const)), [peers]);
  if (pins.length === 0) return null;
  return (
    <Fold
      open
      class="session-section pinned-section"
      summaryClass="session-section-summary"
      summary={`Pinned (${pins.length})`}
    >
      <ul class="session-section-list">
        {pins.map((hit) => (
          <PinnedSessionRow
            key={hit.sid}
            hit={hit}
            currentSid={currentSid}
            peer={peersBySid.get(hit.sid)}
            agent={agentsBySid.get(hit.sid)}
            modelEffort={resolveModelEffort(hit.sid, hit)}
            sayUnread={sayUnreadBy.get(hit.sid) ?? 0}
            onUnpin={() => store.dispatch({ type: "pinned/removed", sid: hit.sid })}
          />
        ))}
      </ul>
    </Fold>
  );
}

/** One row of the sidebar's "前回稼働中" section: a session that was running
 * when the daemon last saw it and has not come back (issue 2026-08-25-restart-
 * recovery-last-live-sessions).
 *
 * Shares the four-element layout every other session row uses (`repo@ws` /
 * title / full sid / path, kawaz r135m16) and nothing else — unlike a pinned
 * row there is no live `PeerInfo`/`AgentInfo` to prefer, because "not
 * connected" is the definition of belonging here: every field is the daemon's
 * frozen record. That is also why the title is plain text rather than the
 * editable `SessionTitle` — `/rename` needs a running session to type into.
 *
 * The row still links to the session view (its transcript is on disk and
 * readable through the daemon's virtual-session path, the same way an offline
 * pin's is); the resume button is the row's point, and opens the launcher on
 * this session rather than starting anything itself. */
function LastLiveSessionRow({
  entry,
  currentSid,
  onResume,
}: {
  entry: LastLiveSession;
  currentSid: string | null;
  onResume: () => void;
}) {
  const title = lastLiveSessionTitle(entry);
  const hasRepoWs = Boolean(entry.repo || entry.ws);
  // 止まっているセッションなので live な供給元は存在しない: 出せるのは daemon が
  // transcript の最後の turn から読み戻した凍結値だけ (LastLiveSession の doc)。
  const modelEffort = formatSessionModelEffort([entry]);
  return (
    <li
      class={entry.sid === currentSid ? "active session-row" : "session-row"}
      title={entry.cwd}
      onClick={selectSessionOnRowClick(entry.sid)}
    >
      <div class="session-line1">
        <a href={sessionHref(entry.sid)} class="session-main-link">
          <Avatar seed={entry.sid} size={16} />
          {entry.repo ? <span class="session-line1-repo">{entry.repo}</span> : null}
          {entry.ws ? (
            <span class="session-line1-ws">{entry.repo ? `@${entry.ws}` : entry.ws}</span>
          ) : null}
          {hasRepoWs ? null : (
            <span class="session-title" title={title}>
              {title}
            </span>
          )}
        </a>
        <span class="session-idle" title={`最終確認 ${entry.last_seen_at}`}>
          {formatRelativeAge(entry.last_seen_at)}
        </span>
        <button
          type="button"
          class="last-live-resume-btn"
          aria-label="このセッションを resume"
          title="このセッションを resume (ランチャーを開く)"
          onClick={onResume}
        >
          ▶
        </button>
      </div>
      {hasRepoWs ? (
        <div class="session-line2">
          <span class="session-title" title={title}>
            {title}
          </span>
        </div>
      ) : null}
      <div class="session-line3">
        <SessionIdText sid={entry.sid} />
        <SessionModelEffort info={modelEffort} />
      </div>
      <div class="session-line4" title={entry.cwd}>
        <span class="session-cwd">
          <bdi dir="ltr">{entry.cwd}</bdi>
        </span>
      </div>
    </li>
  );
}

/** Sidebar "前回稼働中" section: the sessions a previous daemon saw connected
 * that have not registered again — what was running when the machine went
 * down, which is otherwise unrecoverable once the daemon's memory-only peers
 * registry dies with it.
 *
 * Sits below Pinned and above the status sections: pins are a standing choice
 * and stay first, while these rows are transient (each disappears the moment
 * its session comes back) and are about sessions that are NOT in any status
 * section — they belong on the boundary between the two. Renders nothing at
 * all when the list is empty, which is what a fully recovered machine looks
 * like. */
function LastLiveSessionsSection({
  lastLiveSessions,
  peers,
  currentSid,
}: {
  lastLiveSessions: LastLiveSession[];
  peers: PeerInfo[];
  currentSid: string | null;
}) {
  const { store } = useApp();
  const rows = useMemo(
    () => sortLastLiveSessions(visibleLastLiveSessions(lastLiveSessions, peers)),
    [lastLiveSessions, peers],
  );
  // No `useTick` of its own: SessionList already ticks and re-renders this
  // subtree, which is what keeps the "最終確認" age below moving.
  if (rows.length === 0) return null;
  return (
    <Fold
      open
      class="session-section last-live-section"
      summaryClass="session-section-summary"
      summary={`前回稼働中 (${rows.length})`}
    >
      <ul class="session-section-list">
        {rows.map((entry) => (
          <LastLiveSessionRow
            key={entry.sid}
            entry={entry}
            currentSid={currentSid}
            onResume={() =>
              store.dispatch({
                type: "session-creator/prefill",
                prefill: lastLiveResumePrefill(entry),
              })
            }
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

/** Sidebar "Sessions" section (U1, developed from the DR-0008 peers list):
 * merges the ccmsg-connected `peers` (pre-sorted by Sidebar's name/created/
 * recent toggle — this component never reorders those) with the daemon's
 * `claude agents --json` poll (`state.agents`, pulled straight from the
 * store rather than threaded through as a prop, since Sidebar.tsx's own
 * props surface is out of this task's scope) so a session `claude agents`
 * can see but whose ccmsg CLI hasn't connected yet still shows up, grouped
 * as its own "ccmsg 未起動" tail (see offlineAgentRows).
 *
 * U3 (kawaz 2026-07-11: "busy 表示邪魔。リスト側に busy とかのやつでセクション
 * 切ってフォルディングもできるように"; extended 2026-07-16 to cover any
 * `claude agents` status, not just busy/idle/done — see sessionStatus's doc
 * comment): the merged rows are further split into per-status sections
 * (groupSessionsBySection), each its own `<Fold open>` so a section can be
 * collapsed — sort order (name/created/recent) still applies *within* each
 * section, unchanged from before this task. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: PeerInfo[];
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
    lastLiveSessions,
    rooms,
  } = useStoreState(store);
  // 1on1 room 由来なので rooms が変わった時だけ引き直す。room を開いていなく
  // ても say/say_read は subscribe で届き store が畳むので、未読は「まだ開いて
  // いないセッション」でも正しく出る (store.ts applyProtocolEvent の say 分岐)。
  const sayUnreadBy = useMemo(() => sayUnreadBySid(rooms), [rooms]);
  const agentsBySid = useMemo(() => indexAgentsBySid(agents), [agents]);
  const rows = useMemo(
    () => [
      ...peers.map((p) => toSessionRow(p, agentsBySid, sessionErrors)),
      ...offlineAgentRows(peers, agents),
    ],
    [peers, agents, agentsBySid, sessionErrors],
  );
  // kawaz 2026-08-31: "Pinned に居るセッションは Busy リストから除外してほしい"。
  // ピンは「見失いたくない一件」を上に固定する場所で、その行は live な
  // PeerInfo/AgentInfo を優先して描く (PinnedSessionsSection の doc comment)
  // ため、下の status セクションに同じ sid をもう一度出しても増える情報が無く、
  // リストの実効的な長さだけが伸びる。除外は Pinned とこの status セクション
  // 群の間だけ — 「前回稼働中」は resume ボタンという固有の操作を持つので、
  // そちらの重複はピンでは代替できない。
  const sections = useMemo(
    () => groupSessionsBySection(rows.filter((row) => !pinnedSessions.has(row.sid))),
    [rows, pinnedSessions],
  );
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
        resolveModelEffort={resolveModelEffort}
      />
      <LastLiveSessionsSection
        lastLiveSessions={lastLiveSessions}
        peers={peers}
        currentSid={currentSid}
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
                cacheTs={llmRequests.get(row.sid)?.ts ?? null}
                sayUnread={sayUnreadBy.get(row.sid) ?? 0}
              />
            ))}
          </ul>
        </Fold>
      ))}
    </div>
  );
}
