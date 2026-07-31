// .gitignore matching for the fs_find walk (kawaz r55m127). Searching a repo
// for "package.json" is useless when `node_modules` supplies a hundred hits
// before the user's own file, and the result cap means those hits don't just
// add noise — they crowd the real answer out of the reply entirely.
//
// Scope: the pattern grammar `gitignore(5)` documents for the files a repo
// actually carries — comments, blank lines, `!` negation, trailing-`/`
// directory-only patterns, leading/embedded-`/` anchoring, `*` / `?` /
// `[...]` / `**` wildcards, backslash escapes, and nested `.gitignore` files
// whose rules apply to their own subtree with last-match-wins precedence.
//
// Deliberately outside that scope: the other sources git consults for the same
// decision — `.git/info/exclude`, `core.excludesFile`, and `.gitattributes`
// interactions. Those live outside the worktree (or outside the ignore
// mechanism entirely), and a path they hide is one the user can still see in
// the tree, so leaving it searchable is the conservative direction to be wrong
// in. This is a search filter, not `git status`: over-listing costs a row,
// under-listing costs a file the user cannot find.
//
// Also unlike git: `.git` itself is always pruned. It is not in any
// `.gitignore` (git needs no rule to skip its own directory) but it is the
// single largest source of paths no one searches for by name.
import * as fs from "node:fs";
import * as path from "node:path";

/** One compiled `.gitignore` line. */
interface IgnoreRule {
  readonly regex: RegExp;
  /** `!`-prefixed — a match re-includes rather than excludes. */
  readonly negated: boolean;
  /** Trailing `/` — matches directories only. */
  readonly dirOnly: boolean;
}

/** The rules from one `.gitignore`, bound to the directory that contains it.
 * Paths are matched relative to `baseDir`, which is what makes an anchored
 * pattern (`/dist`) mean "in this directory" rather than "at the repo root". */
export interface IgnoreLayer {
  readonly baseDir: string;
  readonly rules: readonly IgnoreRule[];
}

/** Turns one whitespace-trimmed pattern body into a regex source fragment
 * matching a single path segment (or several, for a bare `**`). Handles the
 * wildcards gitignore(5) defines; every other character is matched literally.
 *
 * `*` and `?` deliberately stop at `/` — that is the difference between
 * `logs/*.txt` (one level) and `logs/**` + `*` (any depth), and collapsing it
 * would make `*` swallow directory boundaries the user meant to keep. */
function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && i + 1 < segment.length) {
      out += escapeLiteral(segment[++i]!);
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = findClassEnd(segment, i);
      if (close < 0) {
        // Unterminated `[` is a literal bracket, matching git's own fallback
        // for a malformed class rather than discarding the whole pattern.
        out += "\\[";
      } else {
        let body = segment.slice(i + 1, close);
        // gitignore uses `!` for class negation; JS regex wants `^`.
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = close;
      }
    } else {
      out += escapeLiteral(ch);
    }
  }
  return out;
}

/** Characters that must not reach the compiled regex as syntax. Spelled as a
 * set rather than a character class because the `v` flag this file compiles
 * with reserves several of these inside a class, which would make the class
 * itself a syntax error. */
const REGEX_SPECIAL = new Set("\\^$.|?*+()[]{}/");

function escapeLiteral(ch: string): string {
  return REGEX_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

/** Index of the `]` closing the class opened at `open`, or -1. A `]` in first
 * position (after an optional `!`) is a literal member, per POSIX bracket
 * rules that gitignore inherits. */
function findClassEnd(segment: string, open: number): number {
  let i = open + 1;
  if (segment[i] === "!") i++;
  if (segment[i] === "]") i++;
  for (; i < segment.length; i++) {
    if (segment[i] === "\\") i++;
    else if (segment[i] === "]") return i;
  }
  return -1;
}

/** Strips trailing whitespace that isn't backslash-escaped — gitignore(5)
 * ignores trailing spaces so a stray one at end of line doesn't silently
 * change what a pattern matches. */
function trimUnescapedTrailingSpace(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    // A backslash directly before the run's start escapes the first space of
    // it, so that space (and everything left of it) stays.
    let backslashes = 0;
    let j = end - 2;
    while (j >= 0 && line[j] === "\\") {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/** Compiles one `.gitignore` line, or null for a blank/comment line. */
export function compileIgnoreRule(rawLine: string): IgnoreRule | null {
  let line = trimUnescapedTrailingSpace(rawLine);
  if (line === "" || line.startsWith("#")) return null;

  const negated = line.startsWith("!");
  if (negated) line = line.slice(1);
  // `\#` / `\!` escape a leading literal `#` / `!`.
  if (line.startsWith("\\")) line = line.slice(1);
  if (line === "") return null;

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);
  if (line === "") return null;

  // A pattern with a `/` anywhere but the very end is anchored to the
  // directory holding the .gitignore; one without is matched against every
  // path component ("node_modules" hides it at any depth).
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  const segments = line.split("/");
  let source = "";
  // Whether the next ordinary segment must emit its own leading `/`. A `**`
  // fragment consumes the separator that follows it, so the segment after one
  // must not add a second.
  let needSeparator = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "**") {
      if (i === segments.length - 1) {
        // Trailing `a/**` matches everything under `a`, and nothing else.
        source += needSeparator ? "/.*" : ".*";
        needSeparator = false;
      } else {
        // `**` between separators matches zero or more directories, so
        // `a/**/b` must match `a/b` too — the repeat group includes the
        // trailing separator and may repeat zero times.
        if (needSeparator) source += "/";
        source += "(?:[^/]+/)*";
        needSeparator = false;
      }
      continue;
    }
    if (needSeparator) source += "/";
    source += segmentToRegex(segment);
    needSeparator = true;
  }
  const prefix = anchored ? "" : "(?:.*/)?";
  // Matching a directory also hides everything under it, so every rule ends
  // with an optional `/...` tail. Directory pruning in the walk makes this
  // redundant for the common case, but a rule from a *parent* .gitignore is
  // still evaluated against deep paths.
  //
  // `u` rather than the `v` this repo prefers elsewhere: `v` reserves `(`, `)`,
  // `{`, `}`, `/`, `|` and doubled punctuators inside a bracket class, and a
  // `[...]` body arrives here verbatim from a user's .gitignore. Under `v` a
  // legitimate pattern like `[a|b]` would throw instead of matching.
  try {
    return { regex: new RegExp(`^${prefix}${source}(?:/.*)?$`, "u"), negated, dirOnly };
  } catch {
    // A pattern that won't compile is dropped rather than failing the search.
    // Ignoring one malformed line loses at most some filtering; rejecting the
    // whole file would flood the results with the vendored trees its other,
    // valid lines were hiding.
    return null;
  }
}

/** Compiles a whole `.gitignore` file into a layer rooted at `baseDir`. */
export function compileIgnoreLayer(baseDir: string, contents: string): IgnoreLayer {
  const rules: IgnoreRule[] = [];
  for (const line of contents.split(/\r?\n/v)) {
    const rule = compileIgnoreRule(line);
    if (rule) rules.push(rule);
  }
  return { baseDir, rules };
}

/** Reads `<dir>/.gitignore` into a layer, or null when there isn't one (or it
 * can't be read — an unreadable ignore file means "no rules here", the same
 * skip-and-continue posture the walk takes for unreadable directories). */
export async function readIgnoreLayer(dir: string): Promise<IgnoreLayer | null> {
  let contents: string;
  try {
    contents = await fs.promises.readFile(path.join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  return compileIgnoreLayer(dir, contents);
}

/**
 * True when `absPath` is ignored by `layers` (ordered outermost first).
 *
 * Last match wins, and later layers are nearer the path, which is exactly
 * gitignore(5)'s precedence: a rule in a deeper `.gitignore` overrides a
 * conflicting one above it, and within a file a later line overrides an
 * earlier one. Scanning in reverse and returning the first hit is the same
 * decision reached with less work.
 */
export function isIgnored(
  absPath: string,
  isDir: boolean,
  layers: readonly IgnoreLayer[],
): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    const rel = path.relative(layer.baseDir, absPath);
    // Outside this layer's subtree (shouldn't happen in the walk, but a
    // caller passing an unrelated path shouldn't get a garbage `../..` match).
    if (rel === "" || rel.startsWith("..")) continue;
    for (let r = layer.rules.length - 1; r >= 0; r--) {
      const rule = layer.rules[r]!;
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rel)) return !rule.negated;
    }
  }
  return false;
}
