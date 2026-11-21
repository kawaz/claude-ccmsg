// The sidebar SESSIONS list's quick filter (DR-0043 §9): which rows a typed
// query leaves in the list. Kept out of SessionList.tsx as its own module —
// same convention as file-search.ts / cwd-tree.ts — so the matching is
// exercised without mounting the list.
//
// The query grammar is the Files pane's name search, parsed by the same
// protocol-level parser (`parseFileSearchQuery`): whitespace-separated words,
// ANDed, case-insensitive substring, `-word` excludes, `+word` takes the word
// literally. One app, one box grammar — a user who learned `-test` in Files
// gets the same meaning here.
import {
  type AgentInfo,
  type ParsedFileSearchQuery,
  parseFileSearchQuery,
  type PeerInfo,
} from "@ccmsg/protocol";
import { type Pin, pinnedSessionLabel, pinnedSessionTitle } from "./pinned-sessions.ts";
import { lastPathSegment, sessionRowTitle, shortSid, type SessionRow } from "./utils.ts";

export type SessionFilter = ParsedFileSearchQuery;

/** Parses the box's text; `null` when it holds no term at all (the list is
 * shown unfiltered — an empty box is not "match nothing"). */
export function parseSessionFilter(text: string): SessionFilter | null {
  const parsed = parseFileSearchQuery(text);
  return parsed.include.length === 0 && parsed.exclude.length === 0 ? null : parsed;
}

/** The strings of one row the filter reads: what the row identifies itself
 * by — title, `owner/name`, workspace, branch, the cwd, and the short sid it
 * prints. Empty strings are dropped.
 *
 * The sid and the cwd are read only as far as the row shows them: the sid's
 * first 8 characters, and the cwd only on a row with neither repo nor ws
 * (the only rows that print it). A term that hit the hidden part would keep a
 * row with nothing on screen saying why — and every cwd under one repos root
 * shares a long prefix (`…/repos/github.com/<owner>/`), so a word from it
 * would keep nearly every row. The branch is kept even where the ws label
 * shows the workspace instead: the label falls back to it, and a branch name
 * is as specific as a workspace name. */
export interface SessionFilterFields {
  title: string;
  repo: string;
  ws: string;
  branch?: string;
  /** Present only when the row prints it (see above). */
  cwd?: string | null;
  sid: string;
}

/** The cwd as far as the row prints it: only when there is no repo/ws. */
function shownCwd(repo: string, ws: string, cwd: string | null | undefined): string | undefined {
  return repo || ws ? undefined : (cwd ?? undefined);
}

/** True when the row's fields hold every include term and no exclude term.
 *
 * Each term must sit inside one field: the fields are joined with a newline,
 * which no term can contain (terms are whitespace-split), so `main` + `ccmsg`
 * may hit two different fields (`repo` and `ws`) but a term never straddles a
 * field boundary.
 *
 * Unlike `matchesFileSearchQuery`, an exclude-only query (`-ccmsg`) keeps
 * every row without the excluded word. Files treats it as "no results"
 * because an include-less walk would enumerate the whole repo into a capped
 * result list; here the rows are already all on screen, and "everything but
 * these" is a narrowing the user can read. */
export function sessionMatchesFilter(fields: SessionFilterFields, filter: SessionFilter): boolean {
  const haystack = [
    fields.title,
    fields.repo,
    fields.ws,
    fields.branch ?? "",
    fields.cwd ?? "",
    shortSid(fields.sid),
  ]
    .filter((field) => field !== "")
    .join("\n")
    .toLowerCase();
  if (filter.exclude.some((term) => haystack.includes(term))) return false;
  return filter.include.every((term) => haystack.includes(term));
}

/** Filter fields of a status-section row (SessionRowItem). */
export function sessionRowFilterFields(row: SessionRow): SessionFilterFields {
  return {
    title: sessionRowTitle(row),
    repo: row.repo,
    ws: row.ws,
    branch: row.branch,
    cwd: shownCwd(row.repo, row.ws, row.cwd),
    sid: row.sid,
  };
}

/** The title a pinned row prints: `pinnedSessionTitle` (live agent's name,
 * else the pin's stored title), else the cwd's last segment, else the short
 * sid — the same tail `sessionRowTitle` has. PinnedSessionRow prints this, so
 * the filter reads exactly what the row shows. */
export function pinnedRowTitle(pin: Pin, agent: AgentInfo | undefined): string {
  return pinnedSessionTitle(pin, agent) || lastPathSegment(pin.cwd ?? "") || shortSid(pin.sid);
}

/** Filter fields of a pinned row (PinnedSessionRow): repo/ws as
 * `pinnedSessionLabel` gives them to the row, the branch only while the
 * session is connected (a pin stores none). */
export function pinnedRowFilterFields(
  pin: Pin,
  peer: PeerInfo | undefined,
  agent: AgentInfo | undefined,
): SessionFilterFields {
  const { repo, ws } = pinnedSessionLabel(pin, peer);
  return {
    title: pinnedRowTitle(pin, agent),
    repo,
    ws,
    branch: peer?.vcs?.branch,
    cwd: shownCwd(repo, ws, pin.cwd),
    sid: pin.sid,
  };
}
