import { useEffect, useMemo, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import { sessionHref, timelineHref } from "../locator.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { setSidDragPayload } from "../dnd.ts";
import {
  badgeLabel,
  formatDuration,
  groupSessionsBySection,
  indexAgentsBySid,
  offlineAgentRows,
  sessionBadges,
  sessionRowRepoWs,
  shortSid,
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
function SessionRowItem({ row, currentSid }: { row: SessionRow; currentSid: string | null }) {
  const [cwdFull, setCwdFull] = useState(false);
  const { repo, ws: wsLabel } = sessionRowRepoWs(row);
  const badges = sessionBadges(row);
  const idleMs = row.last_activity_at
    ? Date.now() - new Date(row.last_activity_at).getTime()
    : null;

  const titleParts = [row.cwd];
  if (row.connected_at) titleParts.push(`connected: ${row.connected_at}`);
  if (row.last_activity_at) titleParts.push(`last activity: ${row.last_activity_at}`);
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
          <span class="session-repo-ws">
            {repo}
            {repo && wsLabel ? " ▸ " : ""}
            {wsLabel}
          </span>
          {row.branch && row.branch !== wsLabel ? (
            <span class="session-branch">{row.branch}</span>
          ) : null}
        </a>
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

/** Sidebar "Sessions" section (U1, developed from the DR-0008 peers list):
 * merges the ccmsg-connected `peers` (pre-sorted by Sidebar's abc/idle/new
 * toggle — this component never reorders those) with the daemon's
 * `claude agents --json` poll (`state.agents`, pulled straight from the
 * store rather than threaded through as a prop, since Sidebar.tsx's own
 * props surface is out of this task's scope) so a session `claude agents`
 * can see but whose ccmsg CLI hasn't connected yet still shows up, grouped
 * as its own "ccmsg 未起動" tail (see offlineAgentRows).
 *
 * U3 (kawaz 2026-07-11: "busy 表示邪魔。リスト側に busy とかのやつでセクション
 * 切ってフォルディングもできるように"): the merged rows are further split
 * into Busy/Idle/Done/ccmsg未起動 sections (groupSessionsBySection), each its
 * own `<details open>` so a section can be collapsed — sort order (abc/idle/
 * new) still applies *within* each section, unchanged from before this task. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: PeerInfo[];
  currentSid: string | null;
}) {
  useTick(TICK_MS);
  const { store } = useApp();
  const { agents } = useStoreState(store);
  const agentsBySid = useMemo(() => indexAgentsBySid(agents), [agents]);
  const rows = useMemo(
    () => [...peers.map((p) => toSessionRow(p, agentsBySid)), ...offlineAgentRows(peers, agents)],
    [peers, agents, agentsBySid],
  );
  const sections = useMemo(() => groupSessionsBySection(rows), [rows]);
  return (
    <div id="session-list">
      {sections.map((section) => (
        <details key={section.key} open class="session-section">
          <summary class="session-section-summary">
            {section.label} ({section.rows.length})
          </summary>
          <ul class="session-section-list">
            {section.rows.map((row) => (
              <SessionRowItem key={row.sid} row={row} currentSid={currentSid} />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
