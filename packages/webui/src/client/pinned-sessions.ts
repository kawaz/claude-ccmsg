// Pinned sessions' identity fields (DR-0021 §2.4/§3.2): the rule for choosing
// between what a pin stored and what the live session says, and the
// reducer-side refreshes built on it.
//
// Two fields, two live sources, one rule (live first, stored second, nothing
// invented): `repo`/`ws` come from a connected session's `PeerInfo`, the title
// from what `claude agents --json` reports as that session's `name` — the same
// two sources `SessionRowItem` reads for a status-section row.
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
import type { AgentInfo, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";

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

/** The session's own title for one pinned row, live agent first: what
 * `/rename` set and `claude agents --json` reports as `name`, else the title
 * the pin stored (Session Search reads it from the transcript's `custom-title`
 * records, SessionSearchHit.title).
 *
 * Returns "" when neither knows one, rather than a stand-in: the caller has
 * the row's own fallback chain (cwd leaf, then short sid — `sessionRowTitle`'s
 * tail), and inventing a label here would put a second, competing copy of it
 * behind an import this module deliberately does not have. */
export function pinnedSessionTitle(hit: SessionSearchHit, agent: AgentInfo | undefined): string {
  return agent?.name || hit.title || "";
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

/** The title counterpart of `refreshPinsFromPeers`, for the same reason and
 * with the same contract (repair in place, nothing else touched, SAME Map when
 * nothing changed): a session renamed after it was pinned would otherwise keep
 * its old title on the pinned row for good, and show it again the moment the
 * session goes offline.
 *
 * It folds `agents` rather than `peers` because that is where a title comes
 * from — `claude agents --json`'s `name` — and an agent with no name is not a
 * source: a session that never renamed itself must not blank out the title
 * Session Search recovered from the transcript. */
export function refreshPinsFromAgents(
  pins: Map<string, SessionSearchHit>,
  agents: readonly AgentInfo[],
): Map<string, SessionSearchHit> {
  if (pins.size === 0) return pins;
  let next: Map<string, SessionSearchHit> | null = null;
  for (const agent of agents) {
    const hit = pins.get(agent.sessionId);
    if (!hit) continue;
    const title = pinnedSessionTitle(hit, agent);
    if (title === "" || title === hit.title) continue;
    next ??= new Map(pins);
    next.set(agent.sessionId, { ...hit, title });
  }
  return next ?? pins;
}
