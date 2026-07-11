import { useEffect, useMemo, useState } from "preact/hooks";
import type { FsEntry, PeerInfo } from "@ccmsg/protocol";
import { sessionHref } from "../locator.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { setSidDragPayload } from "../dnd.ts";
import {
  badgeLabel,
  canExpandSiblings,
  errorMessage,
  formatDuration,
  indexAgentsBySid,
  offlineAgentRows,
  ownWorkspaceSegment,
  sessionBadges,
  sessionRowRepoWs,
  shortSid,
  siblingWorkspaceEntries,
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

/** "▷ 展開" sibling-workspace listing (U1): fetched on mount via the existing
 * fs_list op (sid + path:"" — widened to the repo container root when the
 * session announced/got-accepted a repo_root, DR-0008 addendum) and dropped
 * on unmount. Deliberately not cached across collapse/re-expand (unlike
 * FileTree's per-dir cache in sessionTrees) — this is a small, rarely-toggled
 * sidebar affordance, not the main file browser, so the simplicity of
 * "always fresh" outweighs the cost of an extra round trip on re-expand. */
function SessionSiblings({ sid, ownSegment }: { sid: string; ownSegment: string | null }) {
  const { ws } = useApp();
  const [state, setState] = useState<{
    status: "loading" | "loaded" | "error";
    entries?: FsEntry[];
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void ws
      .fsList(sid, "")
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setState({ status: "loaded", entries: res.entries });
        else setState({ status: "error", error: res.error.msg });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [sid, ws]);

  if (state.status === "loading") return <li class="session-siblings-loading">loading…</li>;
  if (state.status === "error") return <li class="session-siblings-error">{state.error}</li>;
  const siblings = siblingWorkspaceEntries(state.entries ?? [], ownSegment);
  if (siblings.length === 0) return <li class="session-siblings-empty">(他の ws/wt なし)</li>;
  return (
    <>
      {siblings.map((e) => (
        <li key={e.name} class="session-sibling" title={e.name}>
          {e.name}
        </li>
      ))}
    </>
  );
}

/** One row of the Sessions list (U1): three lines (repo/ws + badges + idle,
 * sid, cwd) instead of the previous single-line label, plus an optional "▷"
 * that inlines the row's sibling workspaces/worktrees. `row` is a merged
 * SessionRow (see utils.ts's toSessionRow/offlineAgentRows) — either a
 * connected peer (optionally agent-enriched) or an agent-only "ccmsg 未起動"
 * row. */
function SessionRowItem({ row, currentSid }: { row: SessionRow; currentSid: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [cwdFull, setCwdFull] = useState(false);
  const { repo, ws: wsLabel } = sessionRowRepoWs(row);
  const badges = sessionBadges(row);
  const ownSegment = ownWorkspaceSegment({ repo_root: row.repo_root, cwd: row.cwd });
  const canExpand = canExpandSiblings(row);
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
        {canExpand ? (
          <button
            type="button"
            class="session-expand-toggle"
            aria-label="他の ws/wt を表示"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "▾" : "▷"}
          </button>
        ) : (
          <span class="session-expand-spacer" />
        )}
        <a
          href={sessionHref(row.sid)}
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
        {badges.map((b) => (
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
      {expanded && canExpand ? (
        <ul class="session-siblings">
          <SessionSiblings sid={row.sid} ownSegment={ownSegment} />
        </ul>
      ) : null}
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
 * as its own "ccmsg 未起動" tail (see offlineAgentRows). */
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
  return (
    <ul id="session-list">
      {rows.map((row) => (
        <SessionRowItem key={row.sid} row={row} currentSid={currentSid} />
      ))}
    </ul>
  );
}
