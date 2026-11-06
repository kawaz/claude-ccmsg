// Where a version shown in the webui opens (DR-0048 §5): the version's entry
// in its CHANGELOG on GitHub — ccmsg's own (the ctx line's `ccmsg v…`,
// GLOBALS' daemon version) and Claude Code's (the ctx line's and GLOBALS'
// `claude v…`). A version with no entry there (too old, too new) lands at the
// top of the page.

/** ccmsg's CHANGELOG, its entries headed `## v<version>`. */
export const CCMSG_CHANGELOG_URL = "https://github.com/kawaz/claude-ccmsg/blob/main/CHANGELOG.md";

/** Claude Code's CHANGELOG, its entries headed `## <version>`. */
export const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

/** The anchor GitHub gives a markdown heading: lowercased, every character
 * other than a letter, a digit, `_`, `-` or a space dropped, the spaces turned
 * into `-` (`2.1.318` → `21318`, `v0.214.1` → `v02141`). */
export function githubHeadingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

function entryUrl(page: string, heading: string): string {
  return `${page}#${encodeURIComponent(githubHeadingAnchor(heading))}`;
}

/** ccmsg `version`'s entry in ccmsg's CHANGELOG. */
export function ccmsgChangelogUrl(version: string): string {
  return entryUrl(CCMSG_CHANGELOG_URL, `v${version}`);
}

/** Claude Code `version`'s entry in Claude Code's CHANGELOG. */
export function claudeCodeChangelogUrl(version: string): string {
  return entryUrl(CLAUDE_CODE_CHANGELOG_URL, version);
}
