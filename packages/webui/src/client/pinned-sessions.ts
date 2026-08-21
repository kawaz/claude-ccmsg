// Pinned sessions' repo/ws (DR-0021 §2.4/§3.2): the rule for choosing between
// what a pin stored and what the live session says, and the reducer-side
// refresh built on it.
//
// A pin is a `SessionSearchHit` frozen into localStorage at pin time, so its
// `repo`/`ws` are only as good as that moment: a session that announced `ws`
// but no `repo` (hello fills `repo` from the cwd only since the daemon gained
// `deriveRepoWs`) leaves a pin that keeps printing the half pair, while the
// same session's row in a status section prints the full `repo@ws` off its
// live `PeerInfo`. Preferring the live peer is also the precedence
// `resolveSessionTopbar` and `navigation.ts` already apply to these same two
// sources.
//
// Lives outside utils.ts because the reducer (store.ts) applies the refresh,
// and store.ts cannot import utils.ts — utils.ts imports store.ts.
import type { PeerInfo, SessionSearchHit } from "@ccmsg/protocol";

/** repo/ws for one pinned row, live peer first.
 *
 * "Live first" is decided on the *pair*, not per field: a connected session's
 * identity is one fact, and mixing a live repo with a stored ws could compose
 * a pair that never existed. Nothing is invented either — a pin with no live
 * peer and a half-empty record shows what it has, exactly as `SessionRowItem`
 * does for a live row that announced neither. */
export function pinnedSessionLabel(
  hit: SessionSearchHit,
  peer: PeerInfo | undefined,
): { repo: string; ws: string } {
  if (peer && (peer.repo || peer.ws)) return { repo: peer.repo, ws: peer.ws };
  return { repo: hit.repo ?? "", ws: hit.ws ?? "" };
}

/** Folds the live peers list into the stored pins, so a pin's own record —
 * not just its rendering — carries the best repo/ws known for that sid.
 *
 * Rendering alone would be enough while a session is connected, but a pin's
 * main job is to keep pointing at a session that is *not*: leaving the record
 * stale means the half pair comes back the moment the session disconnects.
 * Writing it while the peer is there is what makes the offline row right.
 *
 * Only `repo`/`ws` are touched, as one pair (same rule as
 * `pinnedSessionLabel`) — `title`, `updated_at`, `matches` and the rest stay
 * as pinned; this is a repair of two fields, not a re-pin.
 *
 * Returns the SAME Map when nothing changed. main.tsx persists
 * `pinnedSessions` to localStorage on every identity change of this Map, so a
 * fresh Map per peers event (peers push on every connect/disconnect) would be
 * a write per event that stores the same bytes. */
export function refreshPinsFromPeers(
  pins: Map<string, SessionSearchHit>,
  peers: readonly PeerInfo[],
): Map<string, SessionSearchHit> {
  if (pins.size === 0) return pins;
  let next: Map<string, SessionSearchHit> | null = null;
  for (const peer of peers) {
    const hit = pins.get(peer.sid);
    if (!hit) continue;
    const { repo, ws } = pinnedSessionLabel(hit, peer);
    if (repo === (hit.repo ?? "") && ws === (hit.ws ?? "")) continue;
    next ??= new Map(pins);
    next.set(peer.sid, { ...hit, repo, ws });
  }
  return next ?? pins;
}
