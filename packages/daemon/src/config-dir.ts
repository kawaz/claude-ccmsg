// A session's CLAUDE_CONFIG_DIR, as hello announces it and the agents poll
// finds it, names where its harness state files live: peer injection and the
// runs an address_send resolves (DR-0037 §1) read them there. The daemon keeps
// one spelling per directory so the same config dir is recognised, and read,
// once.
import * as fs from "node:fs";
import * as path from "node:path";

/** Canonical spelling of one config dir, so that two sessions naming the same
 * directory differently (`~/.claude-personal` reached through a symlinked
 * $HOME, a trailing slash, a relative fragment) still compare equal.
 *
 * Best effort by design: an unresolvable path keeps its literal spelling
 * rather than disappearing, exactly like hello's cwd adoption — the value is
 * only ever compared with another session's or joined into a state file
 * path, and a missing directory simply has no state files. A blank or
 * non-absolute announcement is refused outright (`undefined`): it cannot be
 * compared meaningfully, and guessing what it meant points the daemon at the
 * wrong directory. */
export function normalizeConfigDir(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || !path.isAbsolute(trimmed)) return undefined;
  const normalized = path.normalize(trimmed).replace(/\/+$/, "");
  if (normalized === "") return undefined;
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}
