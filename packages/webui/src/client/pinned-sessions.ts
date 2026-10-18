// Pinned sessions (DR-0021 §2.4/§3.2): what a pin holds and is keyed on, which
// sessions a pin lists, the rule for choosing between what a pin stored and
// what the live session says, and the reducer-side refreshes built on it.
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
// from what Claude Code records as that session's `name` — the same
// two sources `SessionRowItem` reads for a status-section row.
//
// A pin is a record frozen into localStorage at pin time, so its `repo`/`ws`
// are only as good as that moment: a session that announced `ws` but no
// `repo` leaves a pin that keeps printing the half pair, while the same
// session's row in a status section prints the full `repo@ws` off its live
// `PeerInfo`. Preferring the live peer is also the precedence
// `resolveSessionTopbar` and `navigation.ts` already apply to these same two
// sources.
//
// Lives outside utils.ts because the reducer (store.ts) applies the refresh,
// and store.ts cannot import utils.ts — utils.ts imports store.ts.
import type { AgentInfo, Output, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import * as v from "valibot";

/** What a pin holds: the fields the pinned row, the session view and the
 * topbar read while the session is not connected. The webui owns this shape
 * (DR-0038 §3) because localStorage keeps it across reloads and releases: it
 * follows what a pin needs, not what a Session Search answer carries, so a
 * field the protocol adds to `SessionSearchHit` neither enters a pin nor makes
 * the stored pins unreadable. */
export const PinSchema = v.object({
  sid: v.string(),
  /** The pin key: the directory the pin belongs to. */
  cwd: v.pipe(v.string(), v.minLength(1)),
  repo: v.nullable(v.string()),
  ws: v.nullable(v.string()),
  /** The session's own title when one was known, `null` when not. */
  title: v.nullable(v.string()),
  /** The session's transcript, `""` for a pin made from a live session that
   * had not announced one. The session view reads it as evidence that the
   * session has a transcript to show. */
  file: v.string(),
  /** Orders the pins, newest first. */
  updated_at: v.string(),
  /** Raw model / effort spellings the session last ran with, when known. */
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
});
export type Pin = Output<typeof PinSchema>;

/** The pin for a Session Search hit, or null when it cannot be pinned:
 * Session Search returns `cwd: null` for a transcript it could not restore
 * one from, and a pin needs a directory to belong to. */
export function pinFromHit(hit: SessionSearchHit): Pin | null {
  if (!hit.cwd) return null;
  return {
    sid: hit.sid,
    cwd: hit.cwd,
    repo: hit.repo,
    ws: hit.ws,
    title: hit.title,
    file: hit.file,
    updated_at: hit.updated_at,
    ...(hit.model === undefined ? {} : { model: hit.model }),
    ...(hit.effort === undefined ? {} : { effort: hit.effort }),
  };
}

/** Builds the cwd-keyed pin Map from a stored list (localStorage hydration).
 * Two pins sharing a cwd — stored records from when pins were per sid —
 * collapse to the most recently updated one, the session a returning reader
 * most likely meant. */
export function pinsFromList(list: readonly Pin[]): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  for (const pin of list) {
    const held = pins.get(pin.cwd);
    if (!held || pin.updated_at > held.updated_at) pins.set(pin.cwd, pin);
  }
  return pins;
}

/** Whether a session running in `cwd` is covered by a pin — any session in a
 * pinned directory is, whichever sid the pin froze. */
export function isSessionPinned(pins: Map<string, Pin>, cwd: string | null | undefined): boolean {
  return !!cwd && pins.has(cwd);
}

/** The stored pin whose own sid is `sid`, if any — the frozen record of the
 * session that was running when its directory was pinned. */
export function pinForSid(pins: Map<string, Pin>, sid: string): Pin | undefined {
  for (const pin of pins.values()) if (pin.sid === sid) return pin;
  return undefined;
}

/** A pin for a live session in `cwd`, built from what its peer (and agent,
 * when known) report. Used where a pin needs a row for a session the pin did
 * not freeze — a successor in the pinned directory — and for pinning a
 * session that was never a search result. */
export function pinFromLive(
  sid: string,
  cwd: string,
  peer: PeerInfo | undefined,
  agent: AgentInfo | undefined,
): Pin {
  const agentCreatedAt =
    agent && Number.isFinite(agent.startedAt) && Math.abs(agent.startedAt) <= 8.64e15
      ? new Date(agent.startedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  return {
    sid,
    cwd,
    repo: peer?.repo ?? null,
    ws: peer?.ws ?? null,
    title: agent?.name ?? null,
    file: peer?.transcript_path ?? "",
    updated_at: peer?.last_activity_at ?? peer?.connected_at ?? agentCreatedAt,
  };
}

/** One row under a pin: the pin the row renders and the pin key it belongs to
 * (what unpinning the row removes). */
export interface PinnedRow {
  key: string;
  pin: Pin;
}

/** The sessions each pin lists. A pin whose directory has connected peers
 * lists every one of them — during a handover the retiring and the new
 * session share the directory, and dropping either would hide a live session
 * the reader pinned the place for. A pin with no connected peer lists the
 * record frozen at pin time. A peer whose sid is the frozen record's keeps
 * that record (it carries the transcript file and title the search found);
 * any other peer gets a record built from what it reports (`pinFromLive`).
 *
 * Pins are ordered most recently updated first (`updated_at` of the frozen
 * record), rows within a pin by the same field. */
export function pinnedRows(
  pins: Map<string, Pin>,
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
  const byNewest = (a: Pin, b: Pin) => b.updated_at.localeCompare(a.updated_at);
  const rows: PinnedRow[] = [];
  for (const [key, frozen] of [...pins.entries()].sort((a, b) => byNewest(a[1], b[1]))) {
    const live = peersByCwd.get(key);
    if (!live) {
      rows.push({ key, pin: frozen });
      continue;
    }
    const listed = live.map((peer) =>
      peer.sid === frozen.sid
        ? frozen
        : pinFromLive(peer.sid, key, peer, agentsBySid.get(peer.sid)),
    );
    for (const pin of listed.sort(byNewest)) rows.push({ key, pin });
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
  pin: Pin,
  peer: PeerInfo | undefined,
): { repo: string; ws: string } {
  if (peer && (peer.repo || peer.ws)) return { repo: peer.repo, ws: peer.ws };
  return { repo: pin.repo ?? "", ws: pin.ws ?? "" };
}

/** The session's own title for one pinned row, live agent first: what
 * `/rename` set and Claude Code records as `name`, else the title
 * the pin stored (for a pin made from a search result, what Session Search
 * read from the transcript's `custom-title` records).
 *
 * Returns "" when neither knows one, rather than a stand-in: the caller has
 * the row's own fallback chain (cwd leaf, then short sid — `sessionRowTitle`'s
 * tail), and inventing a label here would put a second, competing copy of it
 * behind an import this module deliberately does not have. */
export function pinnedSessionTitle(pin: Pin, agent: AgentInfo | undefined): string {
  return agent?.name || pin.title || "";
}

/** frozen pin's sid → its pin key, for the refreshes below. */
function pinsBySid(
  pins: Map<string, Pin>,
): Map<string, { readonly key: string; readonly pin: Pin }> {
  const index = new Map<string, { readonly key: string; readonly pin: Pin }>();
  for (const [key, pin] of pins) index.set(pin.sid, { key, pin });
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
 * `pinnedSessionLabel`) — `title`, `updated_at` and the rest stay as pinned;
 * this is a repair of two fields, not a re-pin.
 *
 * Returns the SAME Map when nothing changed. main.tsx persists
 * `pinnedSessions` to localStorage on every identity change of this Map, so a
 * fresh Map per peers event (peers push on every connect/disconnect) would be
 * a write per event that stores the same bytes. */
export function refreshPinsFromPeers(
  pins: Map<string, Pin>,
  peers: readonly PeerInfo[],
): Map<string, Pin> {
  if (pins.size === 0) return pins;
  const pinBySid = pinsBySid(pins);
  let next: Map<string, Pin> | null = null;
  for (const peer of peers) {
    const held = pinBySid.get(peer.sid);
    if (held === undefined) continue;
    const { key, pin } = held;
    const { repo, ws } = pinnedSessionLabel(pin, peer);
    if (repo === (pin.repo ?? "") && ws === (pin.ws ?? "")) continue;
    next ??= new Map(pins);
    next.set(key, { ...pin, repo, ws });
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
 * from — the agents row's `name` — and an agent with no name is not a
 * source: a session that never renamed itself must not blank out the title
 * Session Search recovered from the transcript. */
export function refreshPinsFromAgents(
  pins: Map<string, Pin>,
  agents: readonly AgentInfo[],
): Map<string, Pin> {
  if (pins.size === 0) return pins;
  const pinBySid = pinsBySid(pins);
  let next: Map<string, Pin> | null = null;
  for (const agent of agents) {
    const held = pinBySid.get(agent.sessionId);
    if (held === undefined) continue;
    const { key, pin } = held;
    const title = pinnedSessionTitle(pin, agent);
    if (title === "" || title === pin.title) continue;
    next ??= new Map(pins);
    next.set(key, { ...pin, title });
  }
  return next ?? pins;
}
