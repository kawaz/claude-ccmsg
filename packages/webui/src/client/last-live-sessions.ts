// The sidebar's "前回稼働中" section: sessions the daemon saw connected before
// it (or the whole machine) went down, which have not come back (issue
// 2026-08-25-restart-recovery-last-live-sessions).
//
// The list itself is the daemon's — it arrives with every peers push and is
// replaced whole, so nothing here decides membership. What lives in this
// module is the row's presentation rule and the launcher request a row makes,
// kept out of the JSX so both are testable (same split as pinned-sessions.ts).
import type { LastLiveSession, PeerInfo } from "@ccmsg/protocol";
import type { ResumePrefill } from "./session-creator.ts";
import { lastPathSegment, shortSid } from "./utils.ts";

/** Rows to actually show: never one whose session is connected right now.
 *
 * The daemon drops an entry the moment its sid registers again, so this
 * normally filters nothing. It is the guard for the case where it would
 * matter: a row offering to resume a session that is already running would
 * start a second copy of it. Deciding that from `peers` — the same list the
 * status sections below are built from — keeps the section from ever
 * contradicting what the rest of the sidebar shows. */
export function visibleLastLiveSessions(
  entries: readonly LastLiveSession[],
  peers: readonly PeerInfo[],
): LastLiveSession[] {
  if (entries.length === 0) return [];
  const live = new Set(peers.map((p) => p.sid));
  return entries.filter((e) => !live.has(e.sid));
}

/** Newest sighting first, sid as the tiebreak — what the user was in the
 * middle of when the machine went down is what they are looking for first.
 * The daemon sends the list in this order already; sorting again here keeps
 * the rendering independent of that (and gives the section one definition of
 * its order rather than two that could drift). */
export function sortLastLiveSessions(entries: readonly LastLiveSession[]): LastLiveSession[] {
  return [...entries].sort(
    (a, b) => b.last_seen_at.localeCompare(a.last_seen_at) || a.sid.localeCompare(b.sid),
  );
}

/** The row's title line: the session's own title if the daemon knew one when
 * it recorded the row, else the same fallback chain every other session row
 * uses (cwd leaf, then short sid) so the line is never blank. */
export function lastLiveSessionTitle(entry: LastLiveSession): string {
  return entry.title || lastPathSegment(entry.cwd) || shortSid(entry.sid);
}

/** What the row's resume action hands the launcher: the same request a Session
 * Search hit makes (`kind: "resume"`), because it is the same act — continue
 * this session id, in this directory, as what it was last running. `model` /
 * `effort` / `title` are passed only when the daemon could establish them; the
 * form then keeps its own defaults rather than being seeded with a guess. The
 * title matters for the same reason it does on a search hit: `claude --resume`
 * with no name registers under a derived one, which would displace the very
 * name this row is showing. */
export function lastLiveResumePrefill(entry: LastLiveSession): ResumePrefill {
  return {
    kind: "resume",
    cwd: entry.cwd,
    sessionId: entry.sid,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(entry.title ? { title: entry.title } : {}),
  };
}
