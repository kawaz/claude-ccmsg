// Pure display-derivations for the Status tab's ENV panel (kawaz r55m132).
// Kept out of the component for the same reason as session-status-view.ts:
// the query semantics are the interesting part and deserve to be exercised
// without a DOM.

export interface EnvRow {
  name: string;
  value: string;
}

/** Whitespace-separated AND terms, matched case-insensitively against the
 * name and the value alike ("名前と値の両対象", kawaz r55m132). Every term
 * must hit at least one of the two fields — terms may match different fields,
 * so `path bin` finds PATH-with-bin-in-its-value as well as a variable whose
 * name carries one term and value the other.
 *
 * Case-insensitive because env names are conventionally upper-case and
 * nobody wants to hold shift to search for one; values are folded with the
 * same rule so a term's behavior doesn't depend on which field it lands in. */
export function parseEnvQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

export function matchesEnvQuery(row: EnvRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const name = row.name.toLowerCase();
  const value = row.value.toLowerCase();
  return terms.every((term) => name.includes(term) || value.includes(term));
}

/** Name-sorted rows so the table has a stable, scannable order — the wire
 * order is `ps`/proc emission order, which carries no meaning for a reader
 * hunting a specific variable. Sorting is by code unit rather than locale:
 * env names are ASCII in practice and a deterministic order beats a
 * locale-dependent one for a debugging view. */
export function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function filterEnvRows(rows: EnvRow[], query: string): EnvRow[] {
  const terms = parseEnvQuery(query);
  return rows.filter((row) => matchesEnvQuery(row, terms));
}

/** PATH-style values read far better one entry per line ("値のコロン区切りを
 * 改行に見立てて表示するスイッチ", kawaz r55m132). Applied only when the
 * switch is on; a value with no colon is returned unchanged, so the toggle is
 * harmless for variables it doesn't apply to.
 *
 * Splitting is unconditional on colon rather than guessing which variables
 * are "path-like": the user flips this switch precisely when they know what
 * they're looking at, and a heuristic that silently skips a variable would be
 * the more surprising behavior. */
export function splitColonValue(value: string): string[] {
  return value.split(":");
}

/** Name substrings that mark a value as sensitive (kawaz r55m134: 「環境変数名
 * で機微パターンを広めにマスク」). Deliberately WIDE — matched as substrings,
 * case-insensitively, so `GITHUB_TOKEN`, `npm_config_authtoken` and
 * `AWS_SECRET_ACCESS_KEY` all hit without enumerating them. Over-matching is
 * the safe direction here: a wrongly-masked variable costs one click to
 * reveal, while a wrongly-exposed one is already on screen.
 *
 * `KEY` is the deliberate over-matcher (it also catches `KEYMAP`,
 * `SSH_AUTH_SOCK`-adjacent `*_KEYS`, and similar innocents) — kept because
 * dropping it would miss `AWS_SECRET_ACCESS_KEY`, `API_KEY` and every
 * `*_PRIVATE_KEY`, which is exactly the class this exists for. */
const SENSITIVE_NAME_PATTERNS = [
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "KEY",
  "CREDENTIAL",
  "AUTH",
  "PRIVATE",
  "SESSION",
  "COOKIE",
  "SIGNATURE",
  "CERT",
  "SALT",
] as const;

/** Whether a variable's VALUE should start masked, decided from its NAME
 * alone (r55m134). Name-based rather than value-shaped: a value-entropy
 * heuristic would both miss short secrets and mask innocent hashes, while the
 * name is what the author already told us about the variable's role. */
export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_NAME_PATTERNS.some((pattern) => upper.includes(pattern));
}
