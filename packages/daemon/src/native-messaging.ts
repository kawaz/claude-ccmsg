// Claude Code's own cross-session messaging (the SendMessage tool) reaches
// only sessions that share a CLAUDE_CONFIG_DIR: a session started under
// another config dir does not even appear in ListAgents, and a send to it is
// refused with "No agent named ... is reachable" (measured 2026-08-27, see
// docs/findings/2026-08-27-native-cross-session-messaging-vs-ccmsg.md).
//
// ccmsg crosses that boundary and therefore knows both sides of it, so it can
// tell an asking session which of its peers are reachable the cheaper way —
// `PeerInfo.send_message`. This module is that single comparison, kept out of
// server.ts so it can be tested without a daemon.
import * as fs from "node:fs";
import * as path from "node:path";

/** Canonical spelling of one config dir, so that two sessions naming the same
 * directory differently (`~/.claude-personal` reached through a symlinked
 * $HOME, a trailing slash, a relative fragment) still compare equal.
 *
 * Best effort by design: an unresolvable path keeps its literal spelling
 * rather than disappearing, exactly like hello's cwd adoption — the value is
 * only ever compared with another session's, never opened. A blank or
 * non-absolute announcement is refused outright (`undefined`): it cannot be
 * compared meaningfully, and guessing what it meant is how a peer gets
 * flagged as reachable when it is not. */
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

/** Can a session running under `asker` reach one running under `peer` with the
 * native SendMessage tool? Same config dir, and both known: an unknown side
 * answers `false`, so the caller falls back to ccmsg rather than sending into
 * a void. Callers exclude the asker's own row separately — "reachable" is a
 * statement about a peer, and messaging yourself is not a use case. */
export function canNativeSendMessage(asker: string | undefined, peer: string | undefined): boolean {
  if (asker === undefined || peer === undefined) return false;
  return asker === peer;
}
