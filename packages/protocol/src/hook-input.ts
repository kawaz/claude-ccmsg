// What Claude Code hands a hook on its standard input, as schemas (DR-0038
// §1). The input is Claude Code's: the schemas list the fields ccmsg reads and
// let the rest through. They sit here rather than beside the hooks so that a
// hook run from the plugin's tree reads them through the protocol package,
// which carries valibot.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** A SessionStart hook's input. Every field is optional: a hook that cannot
 * tell which session it is for does nothing rather than fail the start. */
export const SessionStartInputSchema = v.looseObject({
  session_id: v.optional(v.string()),
  /** "startup" / "resume" / "clear" / "compact". */
  source: v.optional(v.string()),
  /** Absolute path of this session's transcript jsonl (DR-0009). */
  transcript_path: v.optional(v.string()),
  /** Event-time cwd, present on SessionStart and later hook events per the
   * hooks common-field table. Not necessarily the hook process's own cwd
   * (verified to diverge from it), so repo/ws derivation reads this field
   * rather than call process.cwd(). On SessionStart it still names where the
   * session was put, which is why this hook alone may state it as the
   * session's location. */
  cwd: v.optional(v.string()),
});
export type SessionStartInput = Output<typeof SessionStartInputSchema>;

/** A SessionStart hook's standard input. */
export const SessionStartInputTextSchema = jsonText(SessionStartInputSchema);
