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

/** Sidebar Sessions-section label (DR-0008): repo · ws · last path segment of
 * cwd, so entries stay identifiable without eating the whole absolute path.
 * When cwd *is* the workspace root (cwdTail equals ws, or equals repo for a
 * plain non-worktree checkout), the third segment is dropped rather than
 * repeating information already shown by repo/ws (e.g. "claude-ccmsg · main
 * · main" collapses to "claude-ccmsg · main"). A session whose cwd is a
 * subdirectory *within* the workspace still shows the tail — that's the
 * case the third segment carries real information for (DR-0008 addendum). */
export function sessionLabel(peer: PeerInfo): string {
  const cwdTail = peer.cwd.split("/").filter(Boolean).pop() ?? peer.cwd;
  const parts = [peer.repo || "?", peer.ws || "?"];
  // Known edge case: a subdirectory of cwd that happens to share ws's name
  // (e.g. cwd=".../main/main") also collapses the third segment here, same
  // as cwd being ws's root itself — repo_root isn't available to this
  // function to disambiguate the two, and accepting the ambiguity is judged
  // cheaper than threading repo_root through just for this label.
  if (cwdTail !== peer.ws && cwdTail !== peer.repo) parts.push(cwdTail);
  return parts.join(" · ");
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
