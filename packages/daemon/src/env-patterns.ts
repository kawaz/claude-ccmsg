// Removing a Claude Code session's variables from an environment ccmsg hands
// on: the daemon the CLI spawns (DR-0002 §2) and the launch command the daemon
// runs (`clean_env` / `keep_env`, DR-0018 §3.1). Whoever starts the daemon is
// often a session (a hook, `just push`'s upgrade contact, an agent's Bash), and
// its environment carries that session's identity (session id, messaging
// socket and token, the child-session marker) and its config dir's settings
// `env`. Removed by form rather than by a list of names: the names Claude Code
// sets differ by version and by how the child was started, and all of them
// begin with CLAUDE or are AI_AGENT
// (docs/findings/2026-11-25-daemon-inherited-env.md).

/** The patterns removed from what a Claude Code session leaves in an
 * environment: the default of `clean_env`, and what the CLI removes from the
 * daemon it spawns. */
export const SESSION_ENV_CLEAN: readonly string[] = ["CLAUDE*", "ANTHROPIC_*", "AI_AGENT"];

/** Kept where SESSION_ENV_CLEAN matches: the default of `keep_env`. The config
 * dir is the plane a launch falls to where its cwd sets none. */
export const SESSION_ENV_KEEP: readonly string[] = ["CLAUDE_CONFIG_DIR"];

/** Compile one clean_env / keep_env pattern into an anchored RegExp: every
 * regex metacharacter is escaped first so only `*` carries meaning (any
 * substring of the key name, line breaks included: the `s` flag), then
 * anchored so a pattern without `*` is an exact, case-sensitive key match.
 * The `\*` → `.*` rewrite cannot collide with an escaped literal backslash:
 * escaping maps a source `\` to `\\` and a source `*` to `\*`, so every `\*`
 * digram in the escaped text (scanning left-to-right in non-overlapping
 * steps, exactly how replaceAll matches) comes from a source `*`. */
function envPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "s");
}

/** `baseEnv` without the keys a `clean` pattern matches, except those a
 * `keep` pattern also matches (keep wins: a broad `CLAUDE*` must not remove
 * CLAUDE_CONFIG_DIR). Unset entries are dropped (a spawn's env takes strings
 * only). */
export function withoutEnvPatterns(
  baseEnv: Readonly<Record<string, string | undefined>>,
  clean: readonly string[],
  keep: readonly string[],
): Record<string, string> {
  const cleanRes = clean.map(envPatternToRegExp);
  const keepRes = keep.map(envPatternToRegExp);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!keepRes.some((re) => re.test(key)) && cleanRes.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}
