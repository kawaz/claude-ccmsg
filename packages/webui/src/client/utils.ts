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
 * cwd, so entries stay identifiable without eating the whole absolute path. */
export function sessionLabel(peer: PeerInfo): string {
  const cwdTail = peer.cwd.split("/").filter(Boolean).pop() ?? peer.cwd;
  return [peer.repo || "?", peer.ws || "?", cwdTail].join(" · ");
}
