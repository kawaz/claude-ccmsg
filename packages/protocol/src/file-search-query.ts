// Query grammar for the Files pane's path search (fs_find). Lives in protocol
// rather than in the daemon because two independent matchers have to agree on
// it exactly: the daemon walks the tree (fs_find), while the client matches
// DR-0024 external files itself (they are an allowlist of individual paths
// with no directory to walk). A user typing one query into one box must not
// get two different interpretations depending on which section a path is in.
//
// Distinct from search-query.ts, which parses the *transcript* search box
// (line-wise AND of OR-groups, quoting, optional regex). Path search is a
// navigation aid over short strings, so its grammar is deliberately smaller:
// whitespace-separated groups, ANDed, each an OR of `|`-separated words, plus
// an exclusion prefix. The SESSIONS quick filter reads the same grammar
// (DR-0043 §9).

/** A group of a query: the words it is an OR of (at least one). */
export type FileSearchGroup = readonly string[];

/** A parsed path query: every `include` group must have a word in a path and
 * no `exclude` group may. All words are already lower-cased, so a matcher
 * folds only the candidate path, once, rather than re-folding the query for
 * each of the thousands of paths a walk visits. */
export interface ParsedFileSearchQuery {
  readonly include: readonly FileSearchGroup[];
  readonly exclude: readonly FileSearchGroup[];
}

/** The fewest characters (graphemes: what reads as one character, after
 * trimming) a query needs before it filters anything. */
export const MIN_QUERY_LENGTH = 2;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Whether `text` holds at least `min` graphemes, without segmenting more of
 * it than that. */
function hasGraphemes(text: string, min: number): boolean {
  let count = 0;
  for (const _ of graphemes.segment(text)) {
    count += 1;
    if (count >= min) return true;
  }
  return false;
}

/**
 * Splits a path query into include/exclude groups (kawaz r55m127, and the OR
 * of kawaz 2026-11-24).
 *
 * Grammar, per group (groups are whitespace-separated; the blanks around a
 * `|` are dropped first, so `a | b` is the group `a|b`):
 *   - `a|b` → include: a path is kept when it holds `a` or `b`. A group whose
 *     words are all empty (`|`, `a||` keeps `a`) has no word and is no
 *     condition at all
 *   - `-a|b` → exclude: paths holding `a` or `b` are dropped. The `-` is one,
 *     at the group's head, and negates the whole group; a `-` at the head of
 *     a later word (`a|-b`) is the character itself
 *   - `+word` → include the literal `word`, with `+`/`-`/`|` losing any
 *     special meaning in the remainder. This is what makes `-`, `+` and `|`
 *     searchable at all: `+-word` finds paths containing the literal `-word`,
 *     `++word` finds the literal `+word` (one leading `+` is consumed, the
 *     rest is taken as-is), and `+a|b` finds the literal `a|b`
 *   - anything else → include, each word matched as a plain substring
 *
 * A lone `-` or `+` has nothing to negate or escape, so it is taken as the
 * literal character — that is the only reading that lets a user search for a
 * path component that *is* a hyphen. Deliberately not an error: an error state
 * in a live-filtering box would fire mid-word on the way to typing `-foo`.
 *
 * No quoting and no globs. A path search runs against short strings where
 * substring-AND already narrows fast, and every metacharacter added here is
 * one more character a user cannot search for literally without an escape.
 *
 * A query of fewer than 2 characters (the whole query after trimming, counted
 * in graphemes, however short its words) is no query at all: the filter starts from the second character (kawaz
 * 2026-11-22). A single character (`/`, `a`) matches nearly every path, so
 * filtering on it costs a walk and narrows nothing.
 */
export function parseFileSearchQuery(query: string): ParsedFileSearchQuery {
  const include: FileSearchGroup[] = [];
  const exclude: FileSearchGroup[] = [];
  const trimmed = query.trim();
  if (!hasGraphemes(trimmed, MIN_QUERY_LENGTH)) return { include, exclude };
  for (const rawGroup of trimmed.replace(/\s*\|\s*/gv, "|").split(/\s+/v)) {
    if (rawGroup.length === 0) continue;
    const group = rawGroup.toLowerCase();
    const rest = group.slice(1);
    // A prefix with an empty remainder is the literal character itself, not an
    // operator with a missing operand — see the doc comment.
    if (rest.length === 0) {
      include.push([group]);
    } else if (group.startsWith("+")) {
      include.push([rest]);
    } else {
      const negated = group.startsWith("-");
      const words = (negated ? rest : group).split("|").filter((word) => word !== "");
      if (words.length > 0) (negated ? exclude : include).push(words);
    }
  }
  return { include, exclude };
}

/** Whether `haystack` (already folded) holds a word of `group`. */
export function groupMatches(haystack: string, group: FileSearchGroup): boolean {
  return group.some((word) => haystack.includes(word));
}

/**
 * True when `candidatePath` holds a word of every include group and no word
 * of an exclude group, case-insensitively (the words arrive already folded
 * from `parseFileSearchQuery`).
 *
 * A relative path is matched as if it began with `/` (the path shown is
 * unchanged), so that `/ho` means "a component whose name starts with ho" at
 * every depth, the top one included, and `main/` means "under a directory
 * whose name ends with main" (kawaz 2026-11-22, as kawaz/dirview's quick
 * filter does). An absolute path already begins with `/`.
 *
 * Case-insensitive rather than dir_tree's case-sensitive `matchesAllTokens`:
 * this query is typed against half-remembered file names ("filetree",
 * "Readme"), where forcing the user to reproduce the original casing turns a
 * navigation aid into a guessing game. dir_tree's own filter keeps its
 * existing behavior — this is a deliberately separate matcher.
 *
 * Zero include groups match nothing, even when exclude terms are present. An
 * empty box should cost no walk and show no results rather than enumerate the
 * repo, and an exclude-only query (`-test`) is exactly that enumeration with
 * a few paths missing: a full walk whose result cap fills with whatever the
 * traversal happened to reach first. The user types what they are looking for
 * first and narrows from there, so the empty-include case stays "no results".
 */
export function matchesFileSearchQuery(
  candidatePath: string,
  parsed: ParsedFileSearchQuery,
): boolean {
  if (parsed.include.length === 0) return false;
  const lowered = candidatePath.toLowerCase();
  const haystack = lowered.startsWith("/") ? lowered : `/${lowered}`;
  if (parsed.exclude.some((group) => groupMatches(haystack, group))) return false;
  return parsed.include.every((group) => groupMatches(haystack, group));
}

/** True when a parsed query can never match, so a caller can skip the walk
 * entirely (an empty box, or exclusions with nothing to include). */
export function fileSearchQueryIsEmpty(parsed: ParsedFileSearchQuery): boolean {
  return parsed.include.length === 0;
}
