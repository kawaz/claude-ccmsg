/**
 * `#NNNN` issue references in rendered markdown (kawaz r259 m1).
 *
 * A session announces the repository it runs in as an `owner/name` slug
 * (`PeerInfo.repo` / `MemberEvent.repo`), which is all that is needed to turn
 * the `#123` an agent writes in prose into a link to that repo's issue. The
 * split happens on mdast **text** nodes only, so code spans and fenced blocks
 * are excluded structurally rather than by pattern (they are separate node
 * types), and the renderer additionally suppresses it inside `link` nodes so
 * no anchor is ever nested in another.
 */

/** `#` followed by digits, where the `#` does not continue a preceding token.
 *
 * The naive `\b#[0-9]+\b` cannot work: `#` is not a word character, so the
 * leading `\b` requires a word character *before* the `#` — the opposite of
 * what is wanted (`see #123` would not match, `foo#123` would). The intent
 * "a `#NNN` that starts a token" is spelled here as a negative lookbehind:
 * not preceded by a word character (`foo#12`, `path/x.md#12` fragments —
 * `.` and `-` are non-word, but a fragment always follows a filename
 * character), not by another `#` (`##123`), and not by `/` (`v1/#3`).
 * The trailing `\b` is kept as written: it rejects `#12a` while allowing
 * `(#12)`, `#12.` and `#12,`.
 */
const ISSUE_REF_RE = /(?<![\w#/])#(\d+)\b/g;

/** `owner/name` as the daemon reports it. Anything else (empty string for a
 * session outside the repos path convention, a bare directory name) yields no
 * links rather than a URL pointing at nothing. Each segment must *start* with
 * an alphanumeric, which is both what GitHub allows and what keeps a `..`
 * segment from walking the URL out of the repo it names. */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function issueRefUrl(repo: string, number: string): string | null {
  if (!REPO_SLUG_RE.test(repo)) return null;
  return `https://github.com/${repo}/issues/${number}`;
}

export interface IssueRefPiece {
  text: string;
  /** Issue URL when this piece is a `#NNN` reference, `null` for plain text. */
  href: string | null;
}

/** Split one text run into alternating plain / `#NNN` pieces. Returns a single
 * plain piece (the input unchanged) when `repo` is unusable or nothing
 * matches, which is what lets the caller keep its existing fast path. */
export function splitTextForIssueRefs(
  text: string,
  repo: string | undefined,
): readonly IssueRefPiece[] {
  if (!repo || !REPO_SLUG_RE.test(repo)) return [{ text, href: null }];
  const pieces: IssueRefPiece[] = [];
  let cursor = 0;
  ISSUE_REF_RE.lastIndex = 0;
  for (let m = ISSUE_REF_RE.exec(text); m; m = ISSUE_REF_RE.exec(text)) {
    if (m.index > cursor) pieces.push({ text: text.slice(cursor, m.index), href: null });
    pieces.push({ text: m[0], href: issueRefUrl(repo, m[1]!) });
    cursor = m.index + m[0].length;
  }
  if (pieces.length === 0) return [{ text, href: null }];
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), href: null });
  return pieces;
}
