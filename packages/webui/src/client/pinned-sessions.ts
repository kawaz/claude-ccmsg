// Pinned sessions (DR-0021 §2.4/§3.2): what a pin is keyed on, which sessions
// a pin lists, the rule for choosing between what a pin stored and what the
// live session says, and the reducer-side refreshes built on it.
//
// A pin belongs to a session's working directory (`cwd`), not to one sid: a
// directory normally hosts one session at a time, and the successor of a
// handed-over session starts with a new sid in the same directory. Keying on
// the sid made the pin stay behind with the retired session. The key is the
// cwd itself — the same value a connected peer announces and Session Search
// restores from the jsonl, so both kinds of pin source agree on it without
// any further derivation.
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

/** The pin key for a hit, or null when it cannot be pinned: Session Search
 * returns `cwd: null` for a transcript it could not restore one from, and a
 * pin needs a directory to belong to. */
export function pinKey(hit: SessionSearchHit): string | null {
  return hit.cwd || null;
}

/** Builds the cwd-keyed pin Map from a list of stored hits (localStorage
 * hydration). Hits with no cwd are dropped (see pinKey). Two hits sharing a
 * cwd — stored records from when pins were per sid — collapse to the most
 * recently updated one, the session a returning reader most likely meant. */
export function pinsFromHits(hits: readonly SessionSearchHit[]): Map<string, SessionSearchHit> {
  const pins = new Map<string, SessionSearchHit>();
  for (const hit of hits) {
    const key = pinKey(hit);
    if (key === null) continue;
    const held = pins.get(key);
    if (!held || hit.updated_at > held.updated_at) pins.set(key, hit);
  }
  return pins;
}

/** Whether a session running in `cwd` is covered by a pin — any session in a
 * pinned directory is, whichever sid the pin froze. */
export function isSessionPinned(
  pins: Map<string, SessionSearchHit>,
  cwd: string | null | undefined,
): boolean {
  return !!cwd && pins.has(cwd);
}

/** The stored hit whose own sid is `sid`, if any — the frozen record of the
 * session that was running when its directory was pinned. */
export function pinnedHitForSid(
  pins: Map<string, SessionSearchHit>,
  sid: string,
): SessionSearchHit | undefined {
  for (const hit of pins.values()) if (hit.sid === sid) return hit;
  return undefined;
}

/** A SessionSearchHit-shaped record for a live session, built from what its
 * peer (and agent, when known) report. Used where a pin needs a row for a
 * session the pin did not freeze — a successor in the pinned directory — and
 * for pinning a session that was never a search result. */
export function hitFromLive(
  sid: string,
  peer: PeerInfo | undefined,
  agent: AgentInfo | undefined,
): SessionSearchHit {
  const agentCreatedAt =
    agent && Number.isFinite(agent.startedAt) && Math.abs(agent.startedAt) <= 8.64e15
      ? new Date(agent.startedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  const createdAt = peer?.connected_at ?? agentCreatedAt;
  return {
    sid,
    config_dir: agent?.config_dir ?? "",
    file: peer?.transcript_path ?? "",
    cwd: peer?.cwd ?? agent?.cwd ?? null,
    repo: peer?.repo ?? null,
    ws: peer?.ws ?? null,
    created_at: createdAt,
    updated_at: peer?.last_activity_at ?? createdAt,
    size: 0,
    matches: [],
    title: agent?.name ?? null,
  };
}

/** One row under a pin: the hit the row renders and the pin key it belongs to
 * (what unpinning the row removes). */
export interface PinnedRow {
  key: string;
  hit: SessionSearchHit;
}

/** The sessions each pin lists. A pin whose directory has connected peers
 * lists every one of them — during a handover the retiring and the new
 * session share the directory, and dropping either would hide a live session
 * the reader pinned the place for. A pin with no connected peer lists the
 * hit frozen at pin time. A peer whose sid is the frozen hit's keeps that
 * record (it carries the transcript file and title the search found); any
 * other peer gets a record built from what it reports (`hitFromLive`).
 *
 * Pins are ordered most recently updated first (`updated_at` of the frozen
 * hit), rows within a pin by the same field. */
export function pinnedRows(
  pins: Map<string, SessionSearchHit>,
  peers: readonly PeerInfo[],
  agentsBySid: Map<string, AgentInfo>,
): PinnedRow[] {
  const peersByCwd = new Map<string, PeerInfo[]>();
  for (const peer of peers) {
    if (!pins.has(peer.cwd)) continue;
    const list = peersByCwd.get(peer.cwd);
    if (list) list.push(peer);
    else peersByCwd.set(peer.cwd, [peer]);
  }
  const byNewest = (a: SessionSearchHit, b: SessionSearchHit) =>
    b.updated_at.localeCompare(a.updated_at);
  const rows: PinnedRow[] = [];
  for (const [key, frozen] of [...pins.entries()].sort((a, b) => byNewest(a[1], b[1]))) {
    const live = peersByCwd.get(key);
    if (!live) {
      rows.push({ key, hit: frozen });
      continue;
    }
    const hits = live.map((peer) =>
      peer.sid === frozen.sid ? frozen : hitFromLive(peer.sid, peer, agentsBySid.get(peer.sid)),
    );
    for (const hit of hits.sort(byNewest)) rows.push({ key, hit });
  }
  return rows;
}

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

/** frozen hit's sid → its pin key, for the refreshes below. */
function pinsBySid(
  pins: Map<string, SessionSearchHit>,
): Map<string, { readonly key: string; readonly hit: SessionSearchHit }> {
  const index = new Map<string, { readonly key: string; readonly hit: SessionSearchHit }>();
  for (const [key, hit] of pins) index.set(hit.sid, { key, hit });
  return index;
}

/** Folds the live peers list into the stored pins, so a pin's own record —
 * not just its rendering — carries the best repo/ws known for the session it
 * froze.
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
  const pinBySid = pinsBySid(pins);
  let next: Map<string, SessionSearchHit> | null = null;
  for (const peer of peers) {
    const pin = pinBySid.get(peer.sid);
    if (pin === undefined) continue;
    const { key, hit } = pin;
    const { repo, ws } = pinnedSessionLabel(hit, peer);
    if (repo === (hit.repo ?? "") && ws === (hit.ws ?? "")) continue;
    next ??= new Map(pins);
    next.set(key, { ...hit, repo, ws });
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
  const pinBySid = pinsBySid(pins);
  let next: Map<string, SessionSearchHit> | null = null;
  for (const agent of agents) {
    const pin = pinBySid.get(agent.sessionId);
    if (pin === undefined) continue;
    const { key, hit } = pin;
    const title = pinnedSessionTitle(hit, agent);
    if (title === "" || title === hit.title) continue;
    next ??= new Map(pins);
    next.set(key, { ...hit, title });
  }
  return next ?? pins;
}
