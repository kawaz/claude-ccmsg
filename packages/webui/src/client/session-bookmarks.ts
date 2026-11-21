// Session bookmarks (DR-0021 §2.4/§3.2): what a bookmark holds and is keyed on, which
// sessions a bookmark lists, the rule for choosing between what a bookmark stored and
// what the live session says, and the reducer-side refreshes built on it.
//
// A bookmark belongs to a session's working directory (`cwd`), not to one sid: a
// directory normally hosts one session at a time, and the successor of a
// handed-over session starts with a new sid in the same directory. Keying on
// the sid made the bookmark stay behind with the retired session. The key is the
// cwd itself — the same value a connected peer announces and Session Search
// restores from the jsonl, so both kinds of bookmark source agree on it without
// any further derivation.
//
// Two fields, two live sources, one rule (live first, stored second, nothing
// invented): `repo`/`ws` come from a connected session's `PeerInfo` (its
// `repository` and `vcs`, peer-location.ts), the title
// from what Claude Code records as that session's `name` — the same
// two sources `SessionRowItem` reads for a status-section row.
//
// A bookmark is a record frozen into localStorage at bookmark time, so its `repo`/`ws`
// are only as good as that moment: a session with a workspace but no
// repository then leaves a bookmark that keeps printing the half pair, while the same
// session's row in a status section prints the full `repo@ws` off its live
// `PeerInfo`. Preferring the live peer is also the precedence
// `resolveSessionTopbar` and `navigation.ts` already apply to these same two
// sources.
//
// Lives outside utils.ts because the reducer (store.ts) applies the refresh,
// and store.ts cannot import utils.ts — utils.ts imports store.ts.
import type { AgentInfo, Output, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import * as v from "valibot";
import { peerRepoSlug, peerWorkspaceLabel } from "./peer-location.ts";

/** What a bookmark holds: the fields the bookmarked row, the session view and the
 * topbar read while the session is not connected. The webui owns this shape
 * (DR-0038 §3) because localStorage keeps it across reloads and releases: it
 * follows what a bookmark needs, not what a Session Search answer carries, so a
 * field the protocol adds to `SessionSearchHit` neither enters a bookmark nor makes
 * the stored bookmarks unreadable. */
export const SessionBookmarkSchema = v.object({
  sid: v.string(),
  /** The bookmark key: the directory the bookmark belongs to. */
  cwd: v.pipe(v.string(), v.minLength(1)),
  repo: v.nullable(v.string()),
  ws: v.nullable(v.string()),
  /** The session's own title when one was known, `null` when not. */
  title: v.nullable(v.string()),
  /** The session's transcript, `""` for a bookmark made from a live session that
   * had not announced one. The session view reads it as evidence that the
   * session has a transcript to show. */
  file: v.string(),
  /** Orders the bookmarks, newest first. */
  updated_at: v.string(),
  /** Raw model / effort spellings the session last ran with, when known. */
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
});
export type SessionBookmark = Output<typeof SessionBookmarkSchema>;

/** The bookmark for a Session Search hit, or null when it cannot be bookmarked:
 * Session Search returns `cwd: null` for a transcript it could not restore
 * one from, and a bookmark needs a directory to belong to. */
export function sessionBookmarkFromHit(hit: SessionSearchHit): SessionBookmark | null {
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

/** Builds the cwd-keyed bookmark Map from a stored list (localStorage hydration).
 * Two bookmarks sharing a cwd — stored records from when bookmarks were per sid —
 * collapse to the most recently updated one, the session a returning reader
 * most likely meant. */
export function sessionBookmarksFromList(
  list: readonly SessionBookmark[],
): Map<string, SessionBookmark> {
  const bookmarks = new Map<string, SessionBookmark>();
  for (const bookmark of list) {
    const held = bookmarks.get(bookmark.cwd);
    if (!held || bookmark.updated_at > held.updated_at) bookmarks.set(bookmark.cwd, bookmark);
  }
  return bookmarks;
}

/** Whether a session running in `cwd` is covered by a bookmark — any session in a
 * bookmarked directory is, whichever sid the bookmark froze. */
export function isSessionBookmarked(
  bookmarks: Map<string, SessionBookmark>,
  cwd: string | null | undefined,
): boolean {
  return !!cwd && bookmarks.has(cwd);
}

/** The stored bookmark whose own sid is `sid`, if any — the frozen record of the
 * session that was running when its directory was bookmarked. */
export function sessionBookmarkForSid(
  bookmarks: Map<string, SessionBookmark>,
  sid: string,
): SessionBookmark | undefined {
  for (const bookmark of bookmarks.values()) if (bookmark.sid === sid) return bookmark;
  return undefined;
}

/** A bookmark for a live session in `cwd`, built from what its peer (and agent,
 * when known) report. Used where a bookmark needs a row for a session the bookmark did
 * not freeze — a successor in the bookmarked directory — and for bookmarking a
 * session that was never a search result. */
export function sessionBookmarkFromLive(
  sid: string,
  cwd: string,
  peer: PeerInfo | undefined,
  agent: AgentInfo | undefined,
): SessionBookmark {
  const agentCreatedAt =
    agent && Number.isFinite(agent.startedAt) && Math.abs(agent.startedAt) <= 8.64e15
      ? new Date(agent.startedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  return {
    sid,
    cwd,
    repo: peer ? peerRepoSlug(peer) : null,
    ws: peer ? peerWorkspaceLabel(peer) : null,
    title: agent?.name ?? null,
    file: peer?.transcript_path ?? "",
    updated_at: peer?.last_activity_at ?? peer?.connected_at ?? agentCreatedAt,
  };
}

/** One row under a bookmark: the bookmark the row renders and the bookmark key it belongs to
 * (what unbookmarking the row removes). */
export interface SessionBookmarkRow {
  key: string;
  bookmark: SessionBookmark;
}

/** The sessions each bookmark lists. A bookmark whose directory has connected peers
 * lists every one of them — during a handover the retiring and the new
 * session share the directory, and dropping either would hide a live session
 * the reader bookmarked the place for. A bookmark with no connected peer lists the
 * record frozen at bookmark time. A peer whose sid is the frozen record's keeps
 * that record (it carries the transcript file and title the search found);
 * any other peer gets a record built from what it reports (`sessionBookmarkFromLive`).
 *
 * Bookmarks are ordered most recently updated first (`updated_at` of the frozen
 * record), rows within a bookmark by the same field. */
export function sessionBookmarkRows(
  bookmarks: Map<string, SessionBookmark>,
  peers: readonly PeerInfo[],
  agentsBySid: Map<string, AgentInfo>,
): SessionBookmarkRow[] {
  const peersByCwd = new Map<string, PeerInfo[]>();
  for (const peer of peers) {
    if (!bookmarks.has(peer.cwd)) continue;
    const list = peersByCwd.get(peer.cwd);
    if (list) list.push(peer);
    else peersByCwd.set(peer.cwd, [peer]);
  }
  const byNewest = (a: SessionBookmark, b: SessionBookmark) =>
    b.updated_at.localeCompare(a.updated_at);
  const rows: SessionBookmarkRow[] = [];
  for (const [key, frozen] of [...bookmarks.entries()].sort((a, b) => byNewest(a[1], b[1]))) {
    const live = peersByCwd.get(key);
    if (!live) {
      rows.push({ key, bookmark: frozen });
      continue;
    }
    const listed = live.map((peer) =>
      peer.sid === frozen.sid
        ? frozen
        : sessionBookmarkFromLive(peer.sid, key, peer, agentsBySid.get(peer.sid)),
    );
    for (const bookmark of listed.sort(byNewest)) rows.push({ key, bookmark });
  }
  return rows;
}

/** repo/ws for one bookmarked row, live peer first.
 *
 * "Live first" is decided on the *pair*, not per field: a connected session's
 * identity is one fact, and mixing a live repo with a stored ws could compose
 * a pair that never existed. Nothing is invented either — a bookmark with no live
 * peer and a half-empty record shows what it has, exactly as `SessionRowItem`
 * does for a live row that announced neither. */
export function sessionBookmarkLabel(
  bookmark: SessionBookmark,
  peer: PeerInfo | undefined,
): { repo: string; ws: string } {
  const repo = peer ? peerRepoSlug(peer) : "";
  const ws = peer ? peerWorkspaceLabel(peer) : "";
  if (repo || ws) return { repo, ws };
  return { repo: bookmark.repo ?? "", ws: bookmark.ws ?? "" };
}

/** The session's own title for one bookmarked row, live agent first: what
 * `/rename` set and Claude Code records as `name`, else the title
 * the bookmark stored (for a bookmark made from a search result, what Session Search
 * read from the transcript's `custom-title` records).
 *
 * Returns "" when neither knows one, rather than a stand-in: the caller has
 * the row's own fallback chain (cwd leaf, then short sid — `sessionRowTitle`'s
 * tail), and inventing a label here would put a second, competing copy of it
 * behind an import this module deliberately does not have. */
export function sessionBookmarkTitle(
  bookmark: SessionBookmark,
  agent: AgentInfo | undefined,
): string {
  return agent?.name || bookmark.title || "";
}

/** frozen bookmark's sid → its bookmark key, for the refreshes below. */
function sessionBookmarksBySid(
  bookmarks: Map<string, SessionBookmark>,
): Map<string, { readonly key: string; readonly bookmark: SessionBookmark }> {
  const index = new Map<string, { readonly key: string; readonly bookmark: SessionBookmark }>();
  for (const [key, bookmark] of bookmarks) index.set(bookmark.sid, { key, bookmark });
  return index;
}

/** Folds the live peers list into the stored bookmarks, so a bookmark's own record —
 * not just its rendering — carries the best repo/ws known for the session it
 * froze.
 *
 * Rendering alone would be enough while a session is connected, but a bookmark's
 * main job is to keep pointing at a session that is *not*: leaving the record
 * stale means the half pair comes back the moment the session disconnects.
 * Writing it while the peer is there is what makes the offline row right.
 *
 * Only `repo`/`ws` are touched, as one pair (same rule as
 * `sessionBookmarkLabel`) — `title`, `updated_at` and the rest stay as bookmarked;
 * this is a repair of two fields, not a re-bookmark.
 *
 * Returns the SAME Map when nothing changed. main.tsx persists
 * `sessionBookmarks` to localStorage on every identity change of this Map, so a
 * fresh Map per peers event (peers push on every connect/disconnect) would be
 * a write per event that stores the same bytes. */
export function refreshSessionBookmarksFromPeers(
  bookmarks: Map<string, SessionBookmark>,
  peers: readonly PeerInfo[],
): Map<string, SessionBookmark> {
  if (bookmarks.size === 0) return bookmarks;
  const pinBySid = sessionBookmarksBySid(bookmarks);
  let next: Map<string, SessionBookmark> | null = null;
  for (const peer of peers) {
    const held = pinBySid.get(peer.sid);
    if (held === undefined) continue;
    const { key, bookmark } = held;
    const { repo, ws } = sessionBookmarkLabel(bookmark, peer);
    if (repo === (bookmark.repo ?? "") && ws === (bookmark.ws ?? "")) continue;
    next ??= new Map(bookmarks);
    next.set(key, { ...bookmark, repo, ws });
  }
  return next ?? bookmarks;
}

/** The title counterpart of `refreshSessionBookmarksFromPeers`, for the same reason and
 * with the same contract (repair in place, nothing else touched, SAME Map when
 * nothing changed): a session renamed after it was bookmarked would otherwise keep
 * its old title on the bookmarked row for good, and show it again the moment the
 * session goes offline.
 *
 * It folds `agents` rather than `peers` because that is where a title comes
 * from — the agents row's `name` — and an agent with no name is not a
 * source: a session that never renamed itself must not blank out the title
 * Session Search recovered from the transcript. */
export function refreshSessionBookmarksFromAgents(
  bookmarks: Map<string, SessionBookmark>,
  agents: readonly AgentInfo[],
): Map<string, SessionBookmark> {
  if (bookmarks.size === 0) return bookmarks;
  const pinBySid = sessionBookmarksBySid(bookmarks);
  let next: Map<string, SessionBookmark> | null = null;
  for (const agent of agents) {
    const held = pinBySid.get(agent.sessionId);
    if (held === undefined) continue;
    const { key, bookmark } = held;
    const title = sessionBookmarkTitle(bookmark, agent);
    if (title === "" || title === bookmark.title) continue;
    next ??= new Map(bookmarks);
    next.set(key, { ...bookmark, title });
  }
  return next ?? bookmarks;
}
