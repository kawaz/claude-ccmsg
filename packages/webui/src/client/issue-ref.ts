/**
 * Issue references in rendered markdown (kawaz r259 m1 / m45).
 *
 * A session announces the repository it runs in as an `owner/name` slug
 * (`PeerInfo.repo` / `MemberEvent.repo`), which is what turns the `#123` an
 * agent writes in prose into a link to that repo's issue. A reference may also
 * name the repo, or the owner and the repo, and may carry a fragment:
 *
 * | written               | links to                                       |
 * | --------------------- | ---------------------------------------------- |
 * | `#12`                 | `{owner}/{name}/issues/12` (the session's repo) |
 * | `foo#12`              | `{owner}/foo/issues/12` (the session's owner)   |
 * | `bar/foo#12`          | `bar/foo/issues/12`                             |
 * | `…#12#issuecomment-3` | the same, with `#issuecomment-3` appended       |
 *
 * `bar/foo#12` is self-contained, so it links even for a session whose repo is
 * unknown; the two shorter forms need the session's repo and are left as plain
 * text without it. `foo #12` (with a space) is plain `foo` followed by a
 * reference to the session's own repo.
 *
 * Whitespace-free names are ambiguous with file fragments by construction —
 * `README.md#12` reads as repo `README.md`, and links. That is accepted: the
 * split runs on mdast **text** nodes only, so code spans and fenced blocks are
 * excluded structurally (they are separate node types), the renderer suppresses
 * it inside `link` nodes so no anchor nests in another, and what remains is
 * prose, where a bare filename fragment is rare.
 */

/** A reference, with the repo parts the author chose to spell out.
 *
 * The naive `\b#[0-9]+\b` cannot work: `#` is not a word character, so the
 * leading `\b` requires a word character *before* the `#` — the opposite of
 * what is wanted. "A reference starts a token" is spelled here as a negative
 * lookbehind: the match is not preceded by a word character, `.`, `-` (all of
 * which continue a repo name, so a start there would be mid-name), another `#`
 * (`##123`), or `/` (`v1/#3`, and the tail of a URL path). The trailing
 * lookahead rejects `#12a` and a second `#` that no fragment consumed, while
 * allowing `(#12)`, `#12.` and `#12,`.
 *
 * Owner and name use GitHub's slug characters and must start with an
 * alphanumeric, which also keeps a `..` segment from walking the URL out of the
 * repo it names. The fragment is copied to the URL verbatim.
 */
const ISSUE_REF_RE =
  /(?<![\w./#-])(?:(?:([A-Za-z0-9][A-Za-z0-9._-]*)\/)?([A-Za-z0-9][A-Za-z0-9._-]*))?#(\d+)(?:#([A-Za-z0-9_-]+))?(?![\w#])/g;

/** `owner/name` as the daemon reports it. Anything else (empty string for a
 * session outside the repos path convention, a bare directory name) yields no
 * links rather than a URL pointing at nothing. */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Fragment characters, checked again on the way out so a caller passing its
 * own value cannot inject a path. */
const FRAGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function issueRefUrl(repo: string, number: string, fragment?: string): string | null {
  if (!REPO_SLUG_RE.test(repo)) return null;
  const url = `https://github.com/${repo}/issues/${number}`;
  if (fragment === undefined) return url;
  return FRAGMENT_RE.test(fragment) ? `${url}#${fragment}` : null;
}

export interface IssueRefPiece {
  text: string;
  /** Issue URL when this piece is a reference, `null` for plain text. */
  href: string | null;
}

/** Resolve the repo a match points at: both parts as written, the name against
 * the session's owner, or the session's repo itself. */
function resolveRepo(
  owner: string | undefined,
  name: string | undefined,
  sessionRepo: string | undefined,
): string | null {
  if (owner && name) return `${owner}/${name}`;
  if (!sessionRepo || !REPO_SLUG_RE.test(sessionRepo)) return null;
  if (name) return `${sessionRepo.slice(0, sessionRepo.indexOf("/"))}/${name}`;
  return sessionRepo;
}

/** Split one text run into alternating plain / reference pieces. Returns a
 * single plain piece (the input unchanged) when nothing links, which is what
 * lets the caller keep its existing fast path. */
export function splitTextForIssueRefs(
  text: string,
  repo: string | undefined,
): readonly IssueRefPiece[] {
  const pieces: IssueRefPiece[] = [];
  let cursor = 0;
  ISSUE_REF_RE.lastIndex = 0;
  for (let m = ISSUE_REF_RE.exec(text); m; m = ISSUE_REF_RE.exec(text)) {
    const slug = resolveRepo(m[1], m[2], repo);
    const href = slug ? issueRefUrl(slug, m[3]!, m[4]) : null;
    if (!href) continue;
    if (m.index > cursor) pieces.push({ text: text.slice(cursor, m.index), href: null });
    pieces.push({ text: m[0], href });
    cursor = m.index + m[0].length;
  }
  if (pieces.length === 0) return [{ text, href: null }];
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), href: null });
  return pieces;
}
