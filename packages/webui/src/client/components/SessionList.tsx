import { useEffect, useMemo, useState } from "preact/hooks";
import type { PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import { sessionHref, timelineHref } from "../locator.ts";
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
}: {
  row: SessionRow;
  currentSid: string | null;
  /** DR-0020 §2.1 サイドバーミニバッジ ("wf:1 bg:2 todo:3/5")。null = 出さな
   * い (走行中データなし、または今このセッションを開いていないので
   * subscribe していない — 下の SessionList の doc comment 参照)。 */
  statusBadge: string | null;
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

  return (
    <li
      class={row.sid === currentSid ? "active session-row" : "session-row"}
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
          // U3: a row that announced (and had accepted) a transcript opens
          // straight to Timeline — that's the view kawaz actually wants on
          // click for a live Claude session; Files stays the default for a
          // row with no transcript (e.g. a non-Claude ccmsg client, or an
          // agent-only "ccmsg 未起動" row, which never carries transcript_path
          // — see SessionRow's doc comment).
          href={row.transcript_path ? timelineHref(row.sid) : sessionHref(row.sid)}
          class={row.connected ? "session-main-link" : "session-main-link session-disconnected"}
        >
          <Avatar seed={row.sid} size={16} />
          {/* 1 行目は repo のみ (kawaz r17 mid=29: 横幅が狭く ws まで入れると
           * 詰まる)。ws は 2 行目 (sid の後ろ) に移動。repo 無し行 (agent-only
           * 等) は従来通り ws/cwd 末尾の fallback をここに出す。 */}
          <span class="session-repo-ws">{repo || wsLabel}</span>
          {row.branch && row.branch !== wsLabel ? (
            <span class="session-branch">{row.branch}</span>
          ) : null}
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
        {idleMs !== null && <span class="session-idle">{formatDuration(idleMs)}</span>}
      </div>
      <div class="session-line2">
        {statusBadge ? <span class="session-status-badge">{statusBadge}</span> : null}
        <button
          type="button"
          class="session-sid-btn"
          title={`${row.sid}\nクリックでコピー`}
          onClick={() => {
            void navigator.clipboard?.writeText(row.sid).catch(() => {
              // clipboard unavailable (insecure context, permission denied) —
              // the title attribute above still exposes the full sid.
            });
          }}
        >
          {shortSid(row.sid)}
        </button>
        {/* ws は 1 行目から移動してここ (kawaz r17 mid=29)。repo 無し行は
         * 1 行目が既に wsLabel を出しているので重複させない。 */}
        {repo && wsLabel ? <span class="session-line2-ws">{wsLabel}</span> : null}
      </div>
      <div
        class={cwdFull ? "session-line3 session-cwd-full" : "session-line3"}
        onClick={() => setCwdFull((v) => !v)}
      >
        {row.cwd}
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
 * DR-0021 §3.1). Search-origin pins link to Timeline; arbitrary pins without a
 * transcript file link to Files instead. */
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
        <a href={hit.file ? timelineHref(hit.sid) : sessionHref(hit.sid)} class="session-main-link">
          <Avatar seed={hit.sid} size={16} />
          <span class="session-repo-ws">{repo || wsLabel}</span>
          {repo && wsLabel ? <span class="session-branch">{wsLabel}</span> : null}
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
      <div class="session-line2">
        <button
          type="button"
          class="session-sid-btn"
          title={`${hit.sid}\nクリックでコピー`}
          onClick={() => {
            void navigator.clipboard?.writeText(hit.sid).catch(() => {});
          }}
        >
          {shortSid(hit.sid)}
        </button>
      </div>
      {hit.cwd ? <div class="session-line3">{hit.cwd}</div> : null}
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
  const { agents, sessionStatuses, pinnedSessions } = useStoreState(store);
  const agentsBySid = useMemo(() => indexAgentsBySid(agents), [agents]);
  const rows = useMemo(
    () => [...peers.map((p) => toSessionRow(p, agentsBySid)), ...offlineAgentRows(peers, agents)],
    [peers, agents, agentsBySid],
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
        <details key={section.key} open class="session-section">
          <summary class="session-section-summary">
            {section.label} ({section.rows.length})
          </summary>
          <ul class="session-section-list">
            {section.rows.map((row) => (
              <SessionRowItem
                key={row.sid}
                row={row}
                currentSid={currentSid}
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
