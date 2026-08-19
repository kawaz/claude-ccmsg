// session_rename boundary (kawaz r135m16): type `/rename <title>` into the
// terminal a Claude Code session runs in, because that slash command is the
// only writer of a session's title (see SessionRenameRequest in the protocol
// for why there is no API route). Pure logic split out of server.ts the same
// way session-kill.ts is, with the two external effects — resolving the
// session's terminal and running hyoui — injected so tests can cover every
// branch without a terminal multiplexer.

/** `hyoui input` child budget. hyoui serializes input holders (its auto-lock),
 * so this covers "another client is mid-input" as well as a wedged daemon;
 * a rename that cannot get through in this window is better reported as
 * failed than left holding the 2-phase reply open. */
export const HYOUI_TIMEOUT_MS = 5000;

/** Title clamp, matching the room `set_title` cap: a session title shows up
 * in the Sessions list's first line, where anything longer is unreadable
 * regardless of what the TUI would accept. */
export const RENAME_TITLE_MAX_LEN = 200;

export type TitleValidation = { ok: true; title: string } | { ok: false; msg: string };

/** Validate + normalize a requested title before it becomes part of a hyoui
 * spec argument.
 *
 * hyoui does no escape processing (`text:` bytes go to the PTY verbatim) and
 * splits a spec on its first `:` only, so a `:` in the title is harmless but
 * a control character is not: a raw newline reaches the TUI as Enter and
 * submits a truncated `/rename`, and other C0 bytes are terminal control
 * sequences. Rejecting is deliberate over stripping — silently renaming a
 * session to something the user did not type is worse than an error they can
 * act on. */
export function validateRenameTitle(raw: unknown): TitleValidation {
  if (typeof raw !== "string") {
    return { ok: false, msg: "session_rename requires a string title" };
  }
  const title = raw.trim();
  if (title === "") {
    return { ok: false, msg: "session_rename requires a non-empty title" };
  }
  if (title.length > RENAME_TITLE_MAX_LEN) {
    return {
      ok: false,
      msg: `session_rename title must be at most ${RENAME_TITLE_MAX_LEN} characters (got ${title.length}); shorten it`,
    };
  }
  // Scanned by code point rather than matched by regex: a control-character
  // class is exactly what the no-control-regex lint exists to catch, and the
  // predicate names the rule (C0 plus DEL) more plainly than an escape range.
  let hasControlChar = false;
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i);
    // Code units are enough here: every UTF-16 surrogate half is ≥ 0xd800, so
    // no astral character can be mistaken for a control character.
    if (code < 0x20 || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }
  if (hasControlChar) {
    return {
      ok: false,
      msg: "session_rename title must not contain control characters (newline, tab, escape); use a single-line title",
    };
  }
  return { ok: true, title };
}

/** Injectable effects. Production defaults in `productionRenameDeps` below. */
export interface SessionRenameDeps {
  /** The session's terminal handle (`HYOUI_SESSION_ID`), or null when the
   * daemon has never seen one for this session id. */
  hyouiSessionId(sessionId: string): string | null;
  /** Run `hyoui` with the given argv tail. Must reject on spawn failure,
   * non-zero exit, or timeout. */
  runHyoui(args: string[]): Promise<void>;
}

/** The exact `hyoui input` argv tail for one rename.
 *
 * Every element is a separate argv entry, so no shell quoting is involved and
 * spaces in the title need no handling. `key:Enter` is a second spec rather
 * than a `\r` appended to the text: hyoui delivers specs in order with a PTY
 * drain between them, which keeps the submit from racing the typed line.
 * Exported so a test can assert the command shape without running hyoui. */
export function renameCommandArgs(hyouiSessionId: string, title: string): string[] {
  return ["input", hyouiSessionId, `text:/rename ${title}`, "key:Enter"];
}

export type SessionRenameOutcome =
  | { ok: true; hyoui_session_id: string; title: string }
  /** The session has no terminal the daemon can type into. */
  | { ok: false; reason: "terminal_unavailable" }
  /** hyoui was reachable in principle but the send failed (not installed,
   * session socket gone, another holder never released, non-zero exit). */
  | { ok: false; reason: "send_failed"; msg: string };

/** Send one rename. `title` must already have passed validateRenameTitle —
 * the split keeps the wire-level rejection (invalid_args, no side effects)
 * apart from the delivery attempt, which is best-effort by nature. */
export async function sessionRename(
  sessionId: string,
  title: string,
  deps: SessionRenameDeps,
): Promise<SessionRenameOutcome> {
  const hyouiSessionId = deps.hyouiSessionId(sessionId);
  if (!hyouiSessionId) return { ok: false, reason: "terminal_unavailable" };
  try {
    await deps.runHyoui(renameCommandArgs(hyouiSessionId, title));
  } catch (e) {
    return { ok: false, reason: "send_failed", msg: String(e) };
  }
  return { ok: true, hyoui_session_id: hyouiSessionId, title };
}

/** Run a command, rejecting on non-zero exit so a hyoui refusal (unknown
 * session, lock timeout, bad spec) surfaces as a failed rename instead of a
 * silent success. Mirrors session-kill.ts's runner; kept local rather than
 * shared because that one returns stdout and this one only needs the verdict. */
async function runHyouiCommand(args: string[], timeoutMs: number): Promise<void> {
  const argv = ["hyoui", ...args];
  const proc = Bun.spawn(argv, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [code, errText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`hyoui exited ${code}: ${errText.trim().slice(0, 200)}`);
  }
}

/** Build the production deps around a live view of the agents poll. The
 * lookup is a callback rather than a snapshot so a rename issued minutes
 * after the connection opened still reads the current poll, and it uses the
 * poller cache (unlike session_kill's fresh `claude agents` run): a stale pid
 * risks signalling the wrong process, whereas a stale HYOUI_SESSION_ID names
 * a terminal that either still belongs to this session or no longer exists —
 * hyoui rejects the latter, which becomes send_failed. */
export function productionRenameDeps(
  lookupHyouiSessionId: (sessionId: string) => string | null,
): SessionRenameDeps {
  return {
    hyouiSessionId: lookupHyouiSessionId,
    runHyoui: (args) => runHyouiCommand(args, HYOUI_TIMEOUT_MS),
  };
}
