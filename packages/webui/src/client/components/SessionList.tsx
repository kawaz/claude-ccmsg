import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import { sessionHref } from "../locator.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { setSidDragPayload } from "../dnd.ts";
import { formatAgentLiveState, formatSidebarBadge } from "../session-status-view.ts";
import {
  badgeLabel,
  formatDuration,
  groupSessionsBySection,
  indexAgentsBySid,
  lastPathSegment,
  offlineAgentRows,
  sessionRowTitle,
  sessionBadges,
  shortSid,
  sortPinnedSessions,
  toSessionRow,
  type SessionRow,
} from "../utils.ts";
import { Avatar } from "../avatar.tsx";
import { useCacheRing } from "../useCacheRing.ts";
import { useDismissOnOutsidePointer } from "../useDismissOnOutsidePointer.ts";
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

/** The session id, click-to-copy (kawaz r135m20: a plain click left no sign
 * that anything happened). Same feedback contract as StatusPanel's CopyButton
 * — swap the label for ✓ for 1.5s — except that the label here is the id
 * itself, which must stay readable, so the tick joins it instead of replacing
 * it. A clipboard rejection (insecure context, permission denied) shows
 * nothing: the id is fully visible in the row either way, and a success mark
 * for a copy that did not happen is worse than no mark. */
function SessionIdCopyButton({ sid }: { sid: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sid);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_MARK_MS);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      class={copied ? "session-sid-btn copied" : "session-sid-btn"}
      title={`${sid}\nクリックでコピー`}
      onClick={() => void copy()}
    >
      {sid}
      {copied ? <span class="session-sid-copied">✓ コピーしました</span> : null}
    </button>
  );
}

/** Inline title editor for one session row (kawaz r135m16 §✎). Mirrors
 * RoomTitle's confirm/cancel contract deliberately — Shift+Enter or [保存] to
 * confirm, Escape / [キャンセル] / outside click to abort — so the two rename
 * affordances in this UI behave identically rather than each inventing its
 * own keyboard rules.
 *
 * What it cannot mirror is the outcome: a room's set_title is authoritative
 * and echoes back on the subscribe stream, whereas this only types
 * `/rename <title>` into the session's terminal (see SessionRenameRequest).
 * So a success closes the editor and leaves a "送信した" note rather than
 * showing the new title — the row's headline keeps reporting what `claude
 * agents` actually reports until the next poll confirms (or doesn't). */
function SessionRenameEditor({
  sid,
  current,
  onClose,
  onSent,
}: {
  sid: string;
  current: string;
  onClose: () => void;
  onSent: (title: string) => void;
}) {
  const { ws } = useApp();
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same double-settle guard RoomTitle needs: Escape and the outside-pointer
  // dismissal can both fire within one frame.
  const settledRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  function cancel(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    onClose();
  }

  async function confirm(): Promise<void> {
    if (settledRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      cancel();
      return;
    }
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
      onSent(res.title);
    } catch {
      setError("接続エラーのため送信できませんでした");
    } finally {
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
    if (!e.shiftKey) return;
    e.preventDefault();
    void confirm();
  }

  useDismissOnOutsidePointer(containerRef, !saving, cancel);

  return (
    <div class="session-rename-edit" ref={containerRef}>
      <input
        autoFocus
        type="text"
        value={draft}
        disabled={saving}
        maxLength={200}
        placeholder="新しいタイトル (Shift+Enter で送信, Escape で中止)"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        class="session-rename-save-btn"
        disabled={saving}
        onClick={() => void confirm()}
      >
        送信
      </button>
      <button type="button" class="session-rename-cancel-btn" disabled={saving} onClick={cancel}>
        キャンセル
      </button>
      {error && <span class="session-rename-error">{error}</span>}
    </div>
  );
}

/** One row of the Sessions list (kawaz r135m16 §1, order per r135m17): four
 * stacked elements — `repo@ws`, the title (+ ✎), the full session UUID, and
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
  cacheTs,
  activeSecondary,
}: {
  row: SessionRow;
  currentSid: string | null;
  /** DR-0020 §2.1 サイドバーミニバッジ ("wf:1 bg:2 todo:3/5")。null = 出さな
   * い (走行中データなし、または今このセッションを開いていないので
   * subscribe していない — 下の SessionList の doc comment 参照)。 */
  statusBadge: string | null;
  /** この sid の最後の LLM リクエスト時刻 (epoch 秒) — アイコンに巻く prompt
   * cache リング (5 分で消える) の起点。null = 直近 5 分にリクエスト無し、
   * または daemon が gateway の event stream を購読していない (どちらもリング
   * 非表示)。kawaz r99m29: 行に要素は足さず、既存アイコンのボーダーで示す。 */
  cacheTs: number | null;
  /** kawaz r99m1: 同じ sid が Pinned セクションにも出ている時、こちら
   * (status セクション側 = 2 番目に出てくる方) の選択装飾は主張を弱める。
   * Pinned 側が正の「選択中」表示を担う。 */
  activeSecondary: boolean;
}) {
  const [cwdFull, setCwdFull] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const ring = useCacheRing(cacheTs);
  const title = sessionRowTitle(row);
  // Straight from the row: a session that announced no repo/ws shows neither
  // (kawaz r135m16: 欠けたら欠けたなり). No substitute is invented here — the
  // one that used to exist borrowed the agent's name, which the title line
  // already shows.
  const repo = row.repo;
  const wsLabel = row.ws;
  // ✎ only where the daemon has a terminal to type into (session_rename
  // answers `terminal_unavailable` otherwise) — offering a button that can
  // only fail would be worse than not offering it.
  const hyouiSessionId = row.agent?.hyoui_session_id;
  const renameButton = hyouiSessionId ? (
    <button
      type="button"
      class="session-rename-btn"
      title="タイトルを変更 (セッションの端末に /rename を送る)"
      aria-label="タイトルを変更"
      onClick={() => {
        setRenameNote(null);
        setRenaming(true);
      }}
    >
      ✎
    </button>
  ) : null;
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
      class={
        row.sid === currentSid
          ? activeSecondary
            ? "active-secondary session-row"
            : "active session-row"
          : "session-row"
      }
      title={titleParts.join("\n")}
    >
      <div
        class="session-line1"
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
          {/* 1 行目は repo@ws (kawaz r135m17 で title と入れ替え)。行の中で
           * 唯一の強い文字で、`@ws` は @ ごと別色 (r135m18) — worktree 名は
           * 同じ repo の行同士を見分ける唯一の手掛かりなので、repo 名の反復に
           * 埋もれさせない。どちらか欠けたら欠けたまま出す。 */}
          {repo ? <span class="session-line1-repo">{repo}</span> : null}
          {wsLabel ? <span class="session-line1-ws">{repo ? `@${wsLabel}` : wsLabel}</span> : null}
          {hasRepoWs ? null : <span class="session-title">{title}</span>}
        </a>
        {hasRepoWs ? null : renameButton}
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
        {/* DR-0020 §2.1 mini badge。kawaz r55 mid=20 で 2 行目が ws 専用に
         * なったのに伴い、live status 系ここへ移動 (idle と隣接、視覚的な
         * まとまりを保つ)。 */}
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
       * name として返す文字列) と、その変更ボタン。r135m17 で 1 行目から降り、
       * 以下 3 行は弱い文字 (r135m18)。repo/ws が無い行では上の 1 行目が
       * この内容を引き取っているので、ここは出さない。 */}
      {hasRepoWs ? (
        <div class="session-line2">
          <span class="session-title">{title}</span>
          {renameButton}
        </div>
      ) : null}
      {renaming ? (
        <SessionRenameEditor
          sid={row.sid}
          current={title}
          onClose={() => setRenaming(false)}
          onSent={(sent) => {
            setRenaming(false);
            setRenameNote(`/rename を送信: ${sent}`);
          }}
        />
      ) : null}
      {/* Best-effort の顛末 (SessionRenameRequest 参照): 「送った」までしか
       * 言えないので、タイトル自体は agents poll が更新するまで元のまま。 */}
      {renameNote ? <div class="session-rename-note">{renameNote}</div> : null}
      {/* 3 行目: セッション UUID 全長 (kawaz r135m16)。短縮しないのは、この行
       * の用途が「他所に貼るために丸ごとコピーする」ことだから。 */}
      <div class="session-line3">
        <SessionIdCopyButton sid={row.sid} />
      </div>
      {/* 4 行目: project path。左を省略して右端 (= worktree 名まで) を常時
       * 見せる。クリックで全文折り返し表示に切替。 */}
      <div
        class={cwdFull ? "session-line4 session-cwd-full" : "session-line4"}
        onClick={() => setCwdFull((v) => !v)}
        title={row.cwd}
      >
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
 * lot of made-up filler fields. `connected` only decides the badge text
 * ("仮想" = daemon resolves this sid via allowVirtual with no live peer,
 * DR-0021 §3.1). Every pin enters through the session root so recent restoration
 * is identical to a live session row. */
function PinnedSessionRow({
  hit,
  currentSid,
  connected,
  onUnpin,
}: {
  hit: SessionSearchHit;
  currentSid: string | null;
  connected: boolean;
  onUnpin: () => void;
}) {
  // Raw repo/ws for the same reason SessionRowItem uses raw fields: the
  // label helper's cwd-leaf substitute is what the title line already shows.
  const repo = hit.repo ?? "";
  const wsLabel = hit.ws ?? "";
  return (
    <li
      class={hit.sid === currentSid ? "active session-row" : "session-row"}
      title={hit.cwd ?? undefined}
    >
      <div class="session-line1">
        <a href={sessionHref(hit.sid)} class="session-main-link">
          <Avatar seed={hit.sid} size={16} />
          {repo ? <span class="session-line1-repo">{repo}</span> : null}
          {wsLabel ? <span class="session-line1-ws">{repo ? `@${wsLabel}` : wsLabel}</span> : null}
          {/* A pinned entry is a search hit, not a live agent row, so it has
           * no `name` for a title line. With repo/ws present there is nothing
           * left to say — a cwd-leaf stand-in would only repeat the ws — so
           * that line is dropped, and only a pin without repo/ws falls back
           * to the stand-in here. No ✎ either: renaming needs a running
           * terminal, which a pin does not imply. */}
          {repo || wsLabel ? null : (
            <span class="session-title">{lastPathSegment(hit.cwd ?? "") || shortSid(hit.sid)}</span>
          )}
        </a>
        {!connected ? (
          <span
            class="session-badge session-badge-offline"
            title="ccmsg 未接続 (daemon の仮想 session 経由で閲覧)"
          >
            仮想
          </span>
        ) : null}
        <button type="button" class="pinned-unpin-btn" title="ピン解除" onClick={onUnpin}>
          ✕
        </button>
      </div>
      <div class="session-line3">
        <SessionIdCopyButton sid={hit.sid} />
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
 * (see Sidebar.tsx's doc comment) or which status section a *live* copy of
 * the same sid happens to sort into. A pinned sid can be BOTH here and in a
 * status section below simultaneously if it's also currently connected —
 * that's intentional (same "favorites duplicate the normal listing"
 * convention FileTree's ★ section already uses), not deduped. */
function PinnedSessionsSection({
  pinnedSessions,
  peers,
  currentSid,
}: {
  pinnedSessions: Map<string, SessionSearchHit>;
  peers: PeerInfo[];
  currentSid: string | null;
}) {
  const { store } = useApp();
  const pins = useMemo(() => sortPinnedSessions([...pinnedSessions.values()]), [pinnedSessions]);
  if (pins.length === 0) return null;
  const connectedSids = new Set(peers.map((p) => p.sid));
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
            connected={connectedSids.has(hit.sid)}
            onUnpin={() => store.dispatch({ type: "pinned/removed", sid: hit.sid })}
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
  const { agents, sessionStatuses, sessionErrors, llmRequests, pinnedSessions } =
    useStoreState(store);
  const agentsBySid = useMemo(() => indexAgentsBySid(agents), [agents]);
  const rows = useMemo(
    () => [
      ...peers.map((p) => toSessionRow(p, agentsBySid, sessionErrors)),
      ...offlineAgentRows(peers, agents),
    ],
    [peers, agents, agentsBySid, sessionErrors],
  );
  const sections = useMemo(() => groupSessionsBySection(rows), [rows]);
  return (
    <div id="session-list">
      <PinnedSessionsSection
        pinnedSessions={pinnedSessions}
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
                activeSecondary={pinnedSessions.has(row.sid)}
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
                cacheTs={llmRequests.get(row.sid)?.ts ?? null}
              />
            ))}
          </ul>
        </Fold>
      ))}
    </div>
  );
}
