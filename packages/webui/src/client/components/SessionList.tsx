import { useEffect, useMemo, useState } from "preact/hooks";
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
  offlineAgentRows,
  sessionRowRepoWs,
  sessionBadges,
  sessionSearchHitLabel,
  shortSid,
  sortPinnedSessions,
  toSessionRow,
  type SessionRow,
} from "../utils.ts";
import { Avatar } from "../avatar.tsx";

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

/** One row of the Sessions list (U1): three lines (repo/ws + badges + idle,
 * sid, cwd) instead of the previous single-line label. `row` is a merged
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
  activeSecondary,
}: {
  row: SessionRow;
  currentSid: string | null;
  /** DR-0020 §2.1 サイドバーミニバッジ ("wf:1 bg:2 todo:3/5")。null = 出さな
   * い (走行中データなし、または今このセッションを開いていないので
   * subscribe していない — 下の SessionList の doc comment 参照)。 */
  statusBadge: string | null;
  /** kawaz r99m1: 同じ sid が Pinned セクションにも出ている時、こちら
   * (status セクション側 = 2 番目に出てくる方) の選択装飾は主張を弱める。
   * Pinned 側が正の「選択中」表示を担う。 */
  activeSecondary: boolean;
}) {
  const [cwdFull, setCwdFull] = useState(false);
  const { repo, ws: wsLabel } = sessionRowRepoWs(row);
  const badges = sessionBadges(row);
  const liveState = formatAgentLiveState(row.agent);
  const idleMs = row.last_activity_at
    ? Date.now() - new Date(row.last_activity_at).getTime()
    : null;

  const titleParts = [row.cwd];
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
          <Avatar seed={row.sid} size={16} />
          {/* 1 行目は repo のみ (kawaz r17 mid=29: 横幅が狭く ws まで入れると
           * 詰まる)。ws は 2 行目に単独で置く (kawaz r55 mid=20)。repo 無し行
           * (agent-only 等) は従来通り ws/cwd 末尾の fallback をここに出す。 */}
          <span class="session-repo-ws">{repo || wsLabel}</span>
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
         * heading (see SessionList's <details>). "bg" is a separate axis
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
      {/* 2 行目: worktree/workspace 名 (branch も併記)。repo 無し行は 1 行目で
       * 既に wsLabel を出しているので重複させない (kawaz r55 mid=20)。 */}
      {repo && (wsLabel || row.branch) ? (
        <div class="session-line2">
          {wsLabel ? <span class="session-line2-ws">{wsLabel}</span> : null}
          {row.branch && row.branch !== wsLabel ? (
            <span class="session-branch">{row.branch}</span>
          ) : null}
        </div>
      ) : null}
      {/* 3 行目: SID8 + cwd (kawaz r55 mid=20)。sid / cwd はどちらも低優先の
       * 補助情報として同一行にまとめる。cwd はクリックで折り返し表示切替。 */}
      <div
        class={cwdFull ? "session-line3 session-cwd-full" : "session-line3"}
        onClick={() => setCwdFull((v) => !v)}
      >
        <button
          type="button"
          class="session-sid-btn"
          title={`${row.sid}\nクリックでコピー`}
          onClick={(e) => {
            // cwd 折り返し切替 (親 div の onClick) と分離。sid コピーだけを実行。
            e.stopPropagation();
            void navigator.clipboard?.writeText(row.sid).catch(() => {
              // clipboard unavailable (insecure context, permission denied) —
              // the title attribute above still exposes the full sid.
            });
          }}
        >
          {shortSid(row.sid)}
        </button>
        <span class="session-cwd">{row.cwd}</span>
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
  const { repo, ws: wsLabel } = sessionSearchHitLabel(hit);
  return (
    <li
      class={hit.sid === currentSid ? "active session-row" : "session-row"}
      title={hit.cwd ?? undefined}
    >
      <div class="session-line1">
        <a href={sessionHref(hit.sid)} class="session-main-link">
          <Avatar seed={hit.sid} size={16} />
          <span class="session-repo-ws">{repo || wsLabel}</span>
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
      {/* 2 行目: ws 名 (kawaz r55 mid=20、SessionRowItem と揃える)。 */}
      {repo && wsLabel ? (
        <div class="session-line2">
          <span class="session-line2-ws">{wsLabel}</span>
        </div>
      ) : null}
      {/* 3 行目: SID8 + cwd (kawaz r55 mid=20)。 */}
      <div class="session-line3">
        <button
          type="button"
          class="session-sid-btn"
          title={`${hit.sid}\nクリックでコピー`}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(hit.sid).catch(() => {});
          }}
        >
          {shortSid(hit.sid)}
        </button>
        {hit.cwd ? <span class="session-cwd">{hit.cwd}</span> : null}
      </div>
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
    <details open class="session-section pinned-section">
      <summary class="session-section-summary">Pinned ({pins.length})</summary>
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
    </details>
  );
}

/** Extra class for a status section's `<details>`, for the two sections that
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
 * (groupSessionsBySection), each its own `<details open>` so a section can be
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
  const { agents, sessionStatuses, sessionErrors, pinnedSessions } = useStoreState(store);
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
        <details key={section.key} open class={sectionClass(section.key)}>
          <summary class="session-section-summary">
            {section.label} ({section.rows.length})
          </summary>
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
              />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
