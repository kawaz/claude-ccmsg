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
  /** Absolute cwd of the sender at the time the message was sent. Used to
   * resolve `./` / `../` / bare-relative tokens and to strip absolute paths
   * that live below cwd. */
  cwd?: string;
  /** Absolute repo containment root, when the session announced one and the
   * daemon accepted it. When present, this is the FileTree's base — so the
   * `path` we pass to `fileHref()` must be relative to `repo_root`. */
  repoRoot?: string;
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

/** Given a parsed ref and the sender's session/cwd/repo_root, build the
 * `fileHref` URL to open in the FileViewer. Returns `null` when the path
 * can't be safely resolved to somewhere the tree will accept (e.g. an
 * absolute path outside both cwd and repo_root — those would need an
 * `external_files` allowlist entry we don't have visibility into).
 *
 * The returned URL is not a promise the file exists — it's a best-effort
 * link. FileViewer surfaces `fs_read`'s own not-found error if the guess
 * was wrong.
 */
export function resolveFilePathRef(ref: ParsedFilePathRef, ctx: FilePathResolveCtx): string | null {
  // The FileTree is rooted at repo_root when present, else at cwd (see
  // FileTree.tsx's peer.repo_root ?? peer.cwd usage). fileHref's `path`
  // segment must be relative to that same base.
  const base = ctx.repoRoot ?? ctx.cwd;
  if (!base) return null;
  const baseTrim = base.replace(/\/+$/, "");
  let abs: string;
  if (ref.path.startsWith("/")) {
    abs = normalizePosix(ref.path);
  } else if (ref.path.startsWith("./") || ref.path.startsWith("../") || ref.path === ".") {
    // Explicit `./` / `../` — anchor at the sender's cwd, matching how a
    // human reading the message would interpret it. Falls back to base
    // when cwd is missing (rare — daemon always announces one).
    const anchor = (ctx.cwd ?? baseTrim).replace(/\/+$/, "");
    abs = normalizePosix(anchor + "/" + ref.path);
  } else {
    // Bare relative (`packages/foo/bar.ts`, `docs/x.md`) — treated as
    // already-base-relative. That matches how Claude Code itself emits
    // paths (monorepo-root-relative, not cwd-relative) and avoids the
    // silent double-nesting bug of anchoring at cwd when the writer meant
    // the repo root.
    abs = normalizePosix(baseTrim + "/" + ref.path);
  }
  if (abs === baseTrim) {
    // Ref resolves to the base directory itself; not a file link.
    return null;
  }
  if (abs.startsWith(baseTrim + "/")) {
    const rel = abs.slice(baseTrim.length + 1);
    return buildHref(ctx.sid, rel, ref);
  }
  // Absolute (or `../`-escaped) path landed outside base — we can't build a
  // repoRoot-anchored href for it, and we don't have the external_files
  // allowlist here to check, so bail rather than mint a broken link.
  return null;
}

function buildHref(sid: string, relPath: string, ref: ParsedFilePathRef): string {
  const lineRange =
    ref.line !== undefined ? { start: ref.line, end: ref.end ?? ref.line } : undefined;
  return fileHref(sid, relPath, lineRange);
}

/** One-shot helper used by MarkdownView: parse + resolve a raw inline-code
 * token, returning `null` when either step declines. */
export function inlineCodeToFileHref(
  token: string,
  ctx: FilePathResolveCtx | null,
): { href: string; ref: ParsedFilePathRef } | null {
  if (!ctx) return null;
  const ref = parseFilePathRef(token);
  if (!ref) return null;
  const href = resolveFilePathRef(ref, ctx);
  if (!href) return null;
  return { href, ref };
}

// --- daemon-backed resolution (Phase B/C, kawaz r46 m57/m58) ---

/** Convert a parsed ref to the absolute filesystem path the daemon needs to
 * probe — the client is the natural place to expand `./` / `../` /
 * bare-relative tokens against the sender's cwd, so the daemon side only has
 * to test absolute strings against its authorization surfaces. Returns
 * `null` when the ref cannot be pinned to an absolute path (no cwd on the
 * sender, or the ref is bare-relative and neither cwd nor repo_root is
 * available). */
export function refToAbsolutePath(ref: ParsedFilePathRef, ctx: FilePathResolveCtx): string | null {
  if (ref.path.startsWith("/")) return normalizePosix(ref.path);
  const anchor =
    ref.path.startsWith("./") || ref.path.startsWith("../") || ref.path === "."
      ? ctx.cwd
      : (ctx.repoRoot ?? ctx.cwd);
  if (!anchor) return null;
  const anchorTrim = anchor.replace(/\/+$/, "");
  const abs = normalizePosix(anchorTrim + "/" + ref.path);
  if (abs === anchorTrim) return null; // resolves to a directory (anchor itself)
  return abs;
}

/** Build a `fileHref` URL from a daemon-confirmed stat entry + the parsed
 * ref (for line-range info). The stat entry's `path` value already has the
 * FileViewer-shape (relative for contained, absolute for external/workspace),
 * so this just forwards it plus the line range. */
export function hrefFromStatEntry(
  sid: string,
  entry: { path: string },
  ref: ParsedFilePathRef,
): string {
  const lineRange =
    ref.line !== undefined ? { start: ref.line, end: ref.end ?? ref.line } : undefined;
  return fileHref(sid, entry.path, lineRange);
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
