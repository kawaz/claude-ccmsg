// Parse `filepath[:LINE[:COL]]` / `filepath[:L1[-L2]]` tokens that appear in
// agent messages, and resolve them into `fileHref()` URLs pointing at the
// sender session's FileViewer. Kept as pure functions so both the parser
// and the resolver can be unit-tested without a DOM.
//
// Design (kawaz r46 mid=55):
//   - Trigger surface is inline code (`...`) inside markdown messages —
//     prose-level paths would false-positive too aggressively. The pattern
//     itself is intentionally conservative so a random `2:3` or `foo:bar`
//     doesn't turn into a broken link.
//   - No existence check (approach (a) in the task brief): the daemon owns
//     the authoritative fs listing and re-validates on `fs_read`. Adding a
//     protocol op just to gate linkification would be over-cost; FileViewer
//     already surfaces a not-found error clearly if the guess was wrong.
//   - The path shape is filtered to "looks like a real path" — see
//     `looksLikePath()` — to keep the false-positive rate down without
//     asking the daemon anything.

import { fileHref } from "./locator.ts";

/** Parsed shape from a single inline-code token. `end` is only present for
 * the `L1-L2` range form; for `LINE:COL` we drop `col` because the FileViewer
 * only knows how to highlight whole lines (column-level marking isn't wired
 * up), so we surface it as a single-line selection (`line === end`). */
export interface ParsedFilePathRef {
  path: string;
  line?: number;
  end?: number;
}

// The trailing suffix that carries the line info. Two forms:
//   - `:L<n>` or `:L<n>-<m>`  (git / GitHub / many linters)
//   - `:<n>` or `:<n>:<m>`    (grep / rustc / tsc / eslint / most compilers)
// Anchored to `$` so we don't half-eat a numeric segment that happens to
// live in the middle of a path.
const SUFFIX_RE = /(?::L(\d+)(?:-(\d+))?|:(\d+)(?::(\d+))?)$/;

/** True when `s` is plausibly a path token (not a bare word / URL / etc.).
 * The rule set here is conservative on purpose — the cost of missing a
 * linkification is nothing (the raw code stays visible), the cost of a
 * false positive is a broken link and a wasted click.
 *
 * Rejected outright:
 *   - Anything containing whitespace — code spans do allow spaces, but a
 *     path with spaces + a colon suffix + no quoting is too ambiguous to
 *     reliably parse and it's not a form Claude Code itself emits.
 *   - Things that parse as a URL (contain `://`) — those are for the
 *     regular markdown autolink path, not FileViewer.
 *   - Pure identifiers like `foo`, `Foo::bar`, `Cargo.toml` on their own
 *     (no `/`, not anchored to `/`/`./`/`../`) — too collidey with prose.
 *
 * This is only the **shape** check; whether the token looks like a *file*
 * (as opposed to a directory / branch name) is enforced separately by
 * `looksLikeFile()`, applied after we know if line info was present.
 */
export function looksLikePath(s: string): boolean {
  if (s.length === 0) return false;
  if (/\s/.test(s)) return false;
  if (s.includes("://")) return false;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
  // Bare relative path: require at least one `/` so a `foo.ts` mention
  // outside a real path context stays plain text. This mirrors how Claude
  // Code itself tends to cite files (`packages/foo/bar.ts`, `docs/x.md`).
  return s.includes("/");
}

/** True when the path's basename carries a file-shaped extension (a `.` not
 * at start/end of the segment, and the extension is non-empty short
 * alphanumeric). Used together with "has line info" to distinguish files
 * from directory / branch-name tokens (kawaz r46 m56: bare directory paths
 * like `.../2632-2631-fix-remove-cc-institutions-back-button` must not
 * linkify, and the "has extension" cue is the reliable local signal). */
export function looksLikeFile(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const base = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  if (base.length === 0) return false; // trailing `/` => directory
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false; // no ext / dotfile / trailing dot
  const ext = base.slice(dot + 1);
  // Restrict to ext shape that real file suffixes actually use — keeps
  // random `foo.bar-branch` style names from qualifying as "has extension".
  return /^[A-Za-z0-9]{1,12}$/.test(ext);
}

/** Parse a single inline-code token. Returns `null` when the token doesn't
 * look like a path reference at all — the caller keeps rendering the plain
 * `<code>` in that case.
 *
 * Two independent signals qualify a token as a file reference (kawaz r46 m56):
 *   - `looksLikeFile(path)` — basename has a file-shaped extension, or
 *   - The token carried a line-info suffix (`:L…` / `:<n>` / `:<n>:<c>`).
 *
 * Requiring **at least one** of these keeps directory paths (branch-name
 * shapes, dated worktree dirs) from producing broken links even without a
 * daemon-side existence check — the local heuristic alone excludes them.
 */
export function parseFilePathRef(token: string): ParsedFilePathRef | null {
  // Strip optional surrounding backticks defensively — inline-code node values
  // from mdast don't carry them, but consumers may pass raw source too.
  const src = token.replace(/^`+|`+$/g, "").trim();
  if (src.length === 0) return null;
  const m = SUFFIX_RE.exec(src);
  if (!m) {
    if (!looksLikePath(src)) return null;
    // No line info => needs to look like a file (has extension) to qualify.
    if (!looksLikeFile(src)) return null;
    return { path: src };
  }
  const path = src.slice(0, m.index);
  if (!looksLikePath(path)) return null;
  // Group layout: [1]=L-form start, [2]=L-form end,
  //               [3]=colon-form line, [4]=colon-form col (dropped, see doc).
  const start = m[1] ? Number(m[1]) : m[3] ? Number(m[3]) : undefined;
  const end = m[2] ? Number(m[2]) : undefined;
  if (start === undefined || start <= 0) {
    // Suffix matched but yielded no usable line — fall back to the no-suffix
    // rule, which requires a file-shaped extension.
    return looksLikeFile(path) ? { path } : null;
  }
  if (end !== undefined && end < start) {
    // A malformed `foo.ts:10-5` (end < start) is more likely a false-positive
    // than a real range; keep the path but drop the bad range rather than
    // producing an inverted highlight. Line info is still present, so the
    // ref qualifies without a `looksLikeFile` gate.
    return { path, line: start };
  }
  return { path, line: start, end };
}

/** Resolver context. Only the fields we actually consult are required — the
 * caller in TimelineItem passes a `MemberInfo` (which extends `MemberEvent`,
 * carrying `sid`+`cwd`) merged with the matching `PeerInfo` for `repo_root`.
 * Both are optional so tests don't need to invent a full peer. */
export interface FilePathResolveCtx {
  /** Session sid to link to (owner of the file view). Required. */
  sid: string;
  /** Absolute cwd of the sender at the time the message was sent. The anchor
   * every relative token resolves against — see `refToAbsolutePath`. */
  cwd?: string;
  /** Root a markdown link's leading `/` is read against (`refLinkCandidates`).
   * Set only where a document's own conventions apply — the file preview,
   * where it is the session's containment root. Absent for message bodies,
   * whose paths are process-relative, not document-relative. */
  docRoot?: string;
  /** Absolute repo containment root, when the session announced one and the
   * daemon accepted it. Only a fallback anchor for senders that announced no
   * cwd; the daemon owns the containment semantics and returns the
   * FileViewer-shaped path itself, so nothing here rebases against it. */
  repoRoot?: string;
  /** FileViewer path of the document whose links are being resolved, when
   * there is one (the file preview). Carried into every link this ctx
   * produces so a 404 can re-read the link against the other convention
   * (`alternateReadings`). Absent for message bodies — nothing holds them, so
   * there is no second reading to try. */
  docPath?: string;
}

/** POSIX-style path normalization (collapse `.` / `..`, strip duplicate `/`).
 * The daemon runs on unix, and message paths on macOS/Linux — no Windows
 * back-slash handling needed. Absolute inputs keep their leading `/`. */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return isAbs ? "/" + joined : joined;
}

// --- daemon-backed resolution (Phase B/C, kawaz r46 m57/m58) ---

/** Convert a parsed ref to the absolute filesystem path the daemon needs to
 * probe — the client is the natural place to expand `./` / `../` /
 * bare-relative tokens against the sender's cwd, so the daemon side only has
 * to test absolute strings against its authorization surfaces. Returns
 * `null` when the ref cannot be pinned to an absolute path (the sender
 * announced neither cwd nor repo_root).
 *
 * Every relative form — `./x`, `../x`, and bare `docs/x.md` alike — anchors
 * at the sender's **cwd**. A bare relative path is what a process writes when
 * it cites a file it is working on, and that is cwd-relative by construction;
 * repo_root is a containment root the daemon widens fs access to, not a base
 * anyone resolves paths against. Anchoring bare paths at repo_root breaks
 * every worktree layout where cwd sits below it (jj: cwd `<repo>/<ws>`,
 * repo_root `<repo>`) — `docs/x.md` resolved to `<repo>/docs/x.md` misses the
 * real file under `<repo>/<ws>/`.
 *
 * No repo_root fallback is attempted when the cwd-anchored probe misses.
 * `fs_stat_batch` could take both candidates in one round trip, but a hit on
 * the repo_root candidate is more likely a *different* same-named file than
 * the intended one — sibling workspaces under a repo container share tree
 * shapes (`docs/`, `packages/`), so the fallback would link confidently to
 * the wrong file. A missed link costs nothing (the plain `<code>` stays);
 * a wrong link costs a wasted click and misleads the reader.
 *
 * `ctx.repoRoot` is used only as a last resort when the sender announced no
 * cwd at all, where a plausible anchor beats no link. */
export function refToAbsolutePath(ref: ParsedFilePathRef, ctx: FilePathResolveCtx): string | null {
  if (ref.path.startsWith("/")) return normalizePosix(ref.path);
  const anchor = ctx.cwd ?? ctx.repoRoot;
  if (!anchor) return null;
  const anchorTrim = anchor.replace(/\/+$/, "");
  const abs = normalizePosix(anchorTrim + "/" + ref.path);
  if (abs === anchorTrim) return null; // resolves to a directory (anchor itself)
  return abs;
}

/** Absolute candidates to probe for a **markdown link** target, in preference
 * order (kawaz r55 m116/m117).
 *
 * A relative target has exactly one reading (anchored at `ctx.cwd`, same as
 * `refToAbsolutePath`). A target with a leading `/` has two, and which one an
 * author meant depends on where they were writing:
 *
 *   1. Filesystem-absolute — `/etc/hosts`, `/Users/x/notes.md`.
 *   2. Repo-root-relative — `/fixtures/a.json` written inside a repo document,
 *      the convention most documentation tooling uses and the shape that
 *      prompted this work.
 *
 * Both are probed and the first *confirmed* one wins. Ordering filesystem
 * first keeps a genuinely absolute path resolving to itself; the repo-root
 * reading is what a leading `/` almost always means in practice, but only
 * where the first reading found nothing, so it can never shadow a real file.
 *
 * This is not the ambiguity `refToAbsolutePath` refuses to guess at. There the
 * two candidates were sibling *worktrees* with identical tree shapes, so a
 * fallback hit was likely to be a different same-named file. Here the two
 * candidates live in unrelated parts of the filesystem and a hit on either is
 * the file the author named. */
export function refLinkCandidates(ref: ParsedFilePathRef, ctx: FilePathResolveCtx): string[] {
  if (!ref.path.startsWith("/")) {
    const abs = refToAbsolutePath(ref, ctx);
    return abs ? [abs] : [];
  }
  const candidates = [normalizePosix(ref.path)];
  const root = ctx.docRoot?.replace(/\/+$/, "");
  if (root) {
    const rebased = normalizePosix(root + ref.path);
    if (rebased !== candidates[0] && rebased !== root) candidates.push(rebased);
  }
  return candidates;
}

/** The single absolute path a markdown link target names — chosen without
 * asking the daemon anything (kawaz r55 m129).
 *
 * Links used to be rendered only once `fs_stat_batch` confirmed the file, so
 * the reading could be picked by which candidate existed. That gate is gone:
 * it made every link inert until the probe answered (so a reload left the
 * whole document unclickable for a beat) and the unconfirmed styling was
 * indistinguishable from an ordinary in-app link. Links now always resolve,
 * and a wrong guess lands on the viewer's not-found view, which says so and
 * leaves the sidebar intact.
 *
 * Without a probe the two readings of a leading `/` (see `refLinkCandidates`)
 * have to be decided up front, and the **document reading wins wherever a
 * `docRoot` exists**: inside a repo document `/fixtures/a.json` means
 * repo-root-relative — that convention is the reason this resolution exists at
 * all — whereas a filesystem-absolute target is nearly always written as one
 * the reader can also see in the tree. With no `docRoot` (message bodies) the
 * only reading is filesystem-absolute, unchanged. */
export function refLinkTarget(ref: ParsedFilePathRef, ctx: FilePathResolveCtx): string | null {
  const candidates = refLinkCandidates(ref, ctx);
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1]!;
}

/** Turn an absolute path into the shape the FileViewer addresses it by:
 * root-relative when it lies inside the session's containment root (what
 * `fs_read` serves), absolute otherwise (`fs_read_external` /
 * `fs_read_workspace`). This is the classification `fs_stat_batch` used to
 * return; with the probe gone the client derives it from the root it already
 * knows. */
export function viewerPathForAbsolute(abs: string, docRoot: string | undefined): string {
  const root = docRoot?.replace(/\/+$/, "");
  if (!root) return abs;
  if (abs === root) return abs;
  if (!abs.startsWith(root + "/")) return abs;
  return abs.slice(root.length + 1);
}

/** Resolve context for the **file preview** (kawaz r55 m116/m117), where a
 * relative markdown link anchors at the directory holding the previewed file
 * rather than at the session's cwd.
 *
 * That difference is the markdown convention, not a preference: a link written
 * inside `docs/design/QUESTIONS.md` as `[x](notes.md)` means
 * `docs/design/notes.md` — the same text is expected to resolve identically
 * whether the file is read on GitHub, in an editor, or here. A message body is
 * the opposite case: nothing "holds" it, and a process citing a path writes it
 * relative to the directory it is running in, so those anchor at cwd (see
 * `refToAbsolutePath`).
 *
 * `viewerPath` is the FileViewer's own path — root-relative for contained
 * files, absolute for external/workspace ones — so the containment root is
 * needed only for the former. `sessionRoot` must be what the daemon uses for
 * containment (`repo_root ?? cwd`, see fs-access `resolveRoot`); anything else
 * would compute an anchor for a tree the daemon will not serve from.
 *
 * Returns `undefined` when no absolute anchor can be formed, which the caller
 * passes straight through as "no linking" — the fail-closed direction. */
export function previewFilePathCtx(
  sid: string,
  viewerPath: string,
  sessionRoot: string | undefined,
): FilePathResolveCtx | undefined {
  const abs = viewerPath.startsWith("/")
    ? viewerPath
    : sessionRoot
      ? normalizePosix(sessionRoot.replace(/\/+$/, "") + "/" + viewerPath)
      : null;
  if (!abs) return undefined;
  const lastSlash = abs.lastIndexOf("/");
  // `lastSlash === 0` is a file directly under `/`, whose directory is `/`.
  const dir = lastSlash <= 0 ? "/" : abs.slice(0, lastSlash);
  // `docRoot` gives a leading `/` its documentation reading (repo-root
  // relative); it is only meaningful for a contained file, where the session
  // root is the tree the document belongs to.
  return {
    sid,
    cwd: dir,
    docPath: viewerPath,
    ...(sessionRoot ? { docRoot: sessionRoot.replace(/\/+$/, "") } : {}),
  };
}

/** The repo-root reading of a link that landed on nothing (kawaz r55 m152/m153).
 *
 * A relative markdown link resolves against the document holding it, and that
 * is the correct rule — but an author (routinely an AI) writing `docs/x.md`
 * inside `docs/QUESTIONS.md` means the repo root and gets `docs/docs/x.md`.
 *
 * This runs **only after the link has already 404'd**, which is what makes it
 * a derivation rather than a guess: a correctly-written link never gets here,
 * and the failed path is by construction `sourceDir + "/" + <what was
 * written>`. Stripping `sourceDir` therefore recovers the original text
 * exactly — one candidate, not a search. Nothing else in the tree is
 * consulted, so a same-named file living somewhere else can never be offered.
 *
 * `failed` and the result are FileViewer paths (root-relative for contained
 * files); `sourceDir` is the directory of the document the link was written
 * in, in that same shape (`""` for a document at the repo root, which has
 * nothing to strip). Returns `null` when no reading can be recovered.
 * Existence is *not* checked here — only the daemon can say what is readable. */
export function rootRelativeReading(failed: string, sourceDir: string): string | null {
  if (failed.startsWith("/")) return null; // absolute targets have one reading
  const dir = sourceDir.replace(/^\/+|\/+$/g, "");
  if (dir === "") return null;
  const prefix = dir + "/";
  if (!failed.startsWith(prefix)) return null;
  const written = failed.slice(prefix.length);
  if (written === "" || written === failed) return null;
  if (written.startsWith("..") || written.startsWith("/")) return null;
  return written;
}

/** Build a `fileHref` URL from a daemon-confirmed stat entry + the parsed
 * ref (for line-range info). The stat entry's `path` value already has the
 * FileViewer-shape (relative for contained, absolute for external/workspace),
 * so this just forwards it plus the line range. */
export function hrefFromStatEntry(
  sid: string,
  entry: { path: string },
  ref: ParsedFilePathRef,
  /** Document the reference was written in — carried into the URL so a 404 can
   * offer alternate readings (`alternateReadings`). */
  from?: string,
): string {
  const lineRange =
    ref.line !== undefined ? { start: ref.line, end: ref.end ?? ref.line } : undefined;
  return fileHref(sid, entry.path, lineRange, from);
}

/** Walk a raw markdown source and extract every inline-code token
 * (`` `foo` ``) that appears outside fenced code blocks. Fenced code content
 * is skipped so a code sample containing a backtick-quoted path doesn't
 * spuriously probe the daemon for a "path" that was actually being shown as
 * an example. Kept as a pure string scan (no mdast parse) because
 * MarkdownView already parses inside its `useMemo` — doing it a second time
 * up front for the extraction pass would double the per-message parse cost. */
export function extractInlineCodeTokens(source: string): string[] {
  const tokens: string[] = [];
  const lines = source.split("\n");
  let inFence = false;
  // CommonMark: a fence is 3+ backticks or tildes at line start (up to 3
  // leading spaces). The character used to open must be the one that closes;
  // we ignore that nuance and just toggle on either — worst case we skip a
  // slightly larger region than the spec would, which for our purpose (avoid
  // linkifying code samples) is fine.
  const fenceRe = /^ {0,3}(?:`{3,}|~{3,})/;
  const inlineRe = /`([^`]+)`/g;
  for (const line of lines) {
    if (fenceRe.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    inlineRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(line)) !== null) tokens.push(m[1]!);
  }
  return tokens;
}
