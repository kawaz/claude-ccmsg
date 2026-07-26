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
// whitespace-separated words, ANDed, plus an exclusion prefix.

/** A parsed path query: every `include` term must appear in a path and no
 * `exclude` term may. All terms are already lower-cased, so a matcher folds
 * only the candidate path, once, rather than re-folding the query for each of
 * the thousands of paths a walk visits. */
export interface ParsedFileSearchQuery {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * Splits a path query into include/exclude terms (kawaz r55m127).
 *
 * Grammar, per word (words are whitespace-separated):
 *   - `-word` → exclude: paths containing `word` are dropped
 *   - `+word` → include the literal `word`, with `+`/`-` losing any special
 *     meaning in the remainder. This is what makes `-` and `+` searchable at
 *     all: `+-word` finds paths containing the literal `-word`, and `++word`
 *     finds the literal `+word` (one leading `+` is consumed, the rest is
 *     taken as-is).
 *   - anything else → include, matched as a plain substring
 *
 * A lone `-` or `+` has nothing to negate or escape, so it is taken as the
 * literal character — that is the only reading that lets a user search for a
 * path component that *is* a hyphen. Deliberately not an error: an error state
 * in a live-filtering box would fire mid-word on the way to typing `-foo`.
 *
 * No quoting and no globs. A path search runs against short strings where
 * substring-AND already narrows fast, and every metacharacter added here is
 * one more character a user cannot search for literally without an escape.
 */
export function parseFileSearchQuery(query: string): ParsedFileSearchQuery {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const rawWord of query.trim().split(/\s+/v)) {
    if (rawWord.length === 0) continue;
    const word = rawWord.toLowerCase();
    const rest = word.slice(1);
    // A prefix with an empty remainder is the literal character itself, not an
    // operator with a missing operand — see the doc comment.
    if (rest.length === 0) {
      include.push(word);
    } else if (word.startsWith("-")) {
      exclude.push(rest);
    } else if (word.startsWith("+")) {
      include.push(rest);
    } else {
      include.push(word);
    }
  }
  return { include, exclude };
}

/**
 * True when `candidatePath` holds every include term and no exclude term,
 * case-insensitively (the terms arrive already folded from
 * `parseFileSearchQuery`).
 *
 * Case-insensitive rather than dir_tree's case-sensitive `matchesAllTokens`:
 * this query is typed against half-remembered file names ("filetree",
 * "Readme"), where forcing the user to reproduce the original casing turns a
 * navigation aid into a guessing game. dir_tree's own filter keeps its
 * existing behavior — this is a deliberately separate matcher.
 *
 * Zero include terms match nothing, even when exclude terms are present. An
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
  const haystack = candidatePath.toLowerCase();
  if (parsed.exclude.some((term) => haystack.includes(term))) return false;
  return parsed.include.every((term) => haystack.includes(term));
}

/** True when a parsed query can never match, so a caller can skip the walk
 * entirely (an empty box, or exclusions with nothing to include). */
export function fileSearchQueryIsEmpty(parsed: ParsedFileSearchQuery): boolean {
  return parsed.include.length === 0;
}
