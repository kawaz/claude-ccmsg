// Presentation helpers shared by components. Kept out of store.ts because
// these are display-only (locale strings, truncation) and out of the reducer
// (which must stay a pure function of state + action).
import type { PeerInfo } from "@ccmsg/protocol";
import type { RoomState } from "./store.ts";
import { ADMIN_ID } from "./store.ts";

/** Relative age of an ISO timestamp, e.g. "5s" / "3m" / "2h" / "1d". */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Elapsed-time text for a session-list row's idle indicator, e.g. "5s" /
 * "5m20s" / "1h10m" / "2d3h". Unlike `relTime` (single coarsest unit, used
 * for Timeline turns where sub-unit precision doesn't matter), this keeps
 * two units once the value crosses into minutes so "just went idle" and
 * "idle most of an hour" are distinguishable at a glance in a list that's
 * otherwise sorted by this exact value. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${totalSec % 60}s`;
  const totalHour = Math.floor(totalMin / 60);
  if (totalHour < 24) return `${totalHour}h${totalMin % 60}m`;
  const days = Math.floor(totalHour / 24);
  return `${days}d${totalHour % 24}h`;
}

/** HH:MM:SS in the viewer's local timezone, for a Timeline turn's timestamp
 * (DR-0009). Returns "" for a missing/unparseable timestamp (some transcript
 * line types, e.g. file-history-snapshot, carry none) rather than "Invalid
 * Date" or throwing. */
export function formatClockTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

export function memberLabel(id: string, room: RoomState | undefined): string {
  if (id === ADMIN_ID) return "User";
  const m = room?.membersById.get(id);
  if (!m) return id;
  const short = m.sid ? m.sid.slice(0, 8) : id;
  return m.repo ? `${short} (${m.repo})` : short;
}

export function activeRoomsSorted(rooms: Map<string, RoomState>): RoomState[] {
  return [...rooms.values()].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}

/** Sidebar Sessions-section label: `repo · ws · branch`, each segment shown
 * only when non-empty (no more "?" placeholders — a missing field is simply
 * absent rather than noise). `ws` and `branch` collapse to one segment when
 * equal (the common case: a named workspace/worktree checked out at its own
 * branch), so "claude-ccmsg · main · main" reads as "claude-ccmsg · main".
 * The full cwd is shown separately via the list item's `title` attribute
 * (hover), not folded into this label. When repo/ws/branch are all absent
 * (a session that never announced VCS metadata), falls back to the first 8
 * chars of `sid` — an empty label would make such a session indistinguishable
 * from any other in the list. */
export function sessionLabel(peer: PeerInfo): string {
  const parts = [peer.repo, peer.ws, peer.branch !== peer.ws ? peer.branch : undefined].filter(
    (s): s is string => !!s,
  );
  return parts.length > 0 ? parts.join(" · ") : peer.sid.slice(0, 8);
}

/** Sidebar Sessions-list ordering keys, cycled by the sort-toggle button
 * (see Sidebar.tsx): "name" is the default (lexicographic on `sessionLabel`'s
 * fields, so it doubles as an alphabetical grouping by repo/ws/branch),
 * "idle" surfaces the most recently active session first, "connected"
 * surfaces the most recently (re)connected session first. */
export type PeerSortKey = "name" | "idle" | "connected";

const PEER_SORT_CYCLE: PeerSortKey[] = ["name", "idle", "connected"];

/** Short label for the sort-toggle button, so its current mode is visible
 * without hovering for the title attribute. */
export function peerSortButtonLabel(key: PeerSortKey): string {
  switch (key) {
    case "idle":
      return "idle";
    case "connected":
      return "new";
    default:
      return "abc";
  }
}

export function nextPeerSortKey(key: PeerSortKey): PeerSortKey {
  return PEER_SORT_CYCLE[(PEER_SORT_CYCLE.indexOf(key) + 1) % PEER_SORT_CYCLE.length];
}

/** repo → ws → branch → sid, each segment compared with localeCompare — same
 * fields `sessionLabel` renders, so "name" order reads as alphabetical
 * grouping by the label the user actually sees. sid is the final tiebreak so
 * two sessions with identical repo/ws/branch (e.g. two plain checkouts of the
 * same repo with no workspace layer) still sort deterministically instead of
 * however they happened to arrive in `peers`. */
function cmpByName(a: PeerInfo, b: PeerInfo): number {
  const pa = [a.repo ?? "", a.ws ?? "", a.branch ?? "", a.sid];
  const pb = [b.repo ?? "", b.ws ?? "", b.branch ?? "", b.sid];
  for (let i = 0; i < pa.length; i++) {
    const c = pa[i].localeCompare(pb[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** Descending compare on an optional ISO timestamp field (newest first);
 * a peer missing the field (older daemon, or a session that hasn't made a
 * request yet for "idle") sorts after every peer that has one, tiebroken by
 * `cmpByName` so the ordering within "missing" and within equal timestamps
 * stays deterministic rather than following daemon Map insertion order. */
function cmpByTsDesc(a: PeerInfo, b: PeerInfo, field: "last_activity_at" | "connected_at"): number {
  const ta = a[field];
  const tb = b[field];
  if (ta === tb) return cmpByName(a, b);
  if (ta === undefined) return 1;
  if (tb === undefined) return -1;
  const c = tb.localeCompare(ta);
  return c !== 0 ? c : cmpByName(a, b);
}

/** Pure sort used by the Sidebar Sessions list (see Sidebar.tsx / SessionList.tsx):
 * a stable, click-independent ordering so a peers refresh never reshuffles
 * rows out from under a pointer mid-click (the daemon's own `peers` order is
 * Map insertion order, which shifts on reconnect — see server.ts's
 * `sessions` Map). Never mutates its input. */
export function sortPeers(peers: PeerInfo[], key: PeerSortKey): PeerInfo[] {
  const sorted = [...peers];
  switch (key) {
    case "idle":
      sorted.sort((a, b) => cmpByTsDesc(a, b, "last_activity_at"));
      break;
    case "connected":
      sorted.sort((a, b) => cmpByTsDesc(a, b, "connected_at"));
      break;
    default:
      sorted.sort(cmpByName);
  }
  return sorted;
}

/** First path segment of `peer.cwd` relative to `peer.repo_root` — the
 * session's own workspace/worktree directory as it appears under the tree's
 * (now repo-container-rooted, DR-0008 addendum) root. `null` when the
 * session didn't announce/get-accepted a repo_root (fs root is still cwd,
 * nothing to highlight relative to it), or when cwd unexpectedly isn't
 * inside repo_root (defensive — the daemon's hello-time validation already
 * guarantees ancestry, but this stays a pure function of PeerInfo alone and
 * shouldn't throw on a malformed peer). */
export function ownWorkspaceSegment(peer: PeerInfo): string | null {
  if (!peer.repo_root) return null;
  const root = peer.repo_root.replace(/\/+$/, "");
  if (!peer.cwd.startsWith(`${root}/`)) return null;
  const rel = peer.cwd.slice(root.length + 1);
  const seg = rel.split("/")[0];
  return seg || null;
}

/** Last path segment of `peer.repo_root`, for the FileTree's root label
 * (DR-0008 addendum) — tells the viewer what the (now possibly
 * container-wide) tree root actually is, since it's no longer always "this
 * session's cwd". `null` when there's no repo_root to label (tree root is
 * still cwd, no label shown — same as today). */
export function repoRootLabel(peer: PeerInfo): string | null {
  if (!peer.repo_root) return null;
  const parts = peer.repo_root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? peer.repo_root;
}

/** Renders a caught value from a rejected ws.ts send() (e.g. `Error("ws not
 * open")` when a request races a not-yet-open/dropped socket) into the same
 * plain-string shape as `ErrorResponse["error"]["msg"]`, so callers can fold
 * a rejection into their existing error-state dispatch without a second code
 * path (DR-0008/DR-0009 fs_list/fs_read/transcript_read effects). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
