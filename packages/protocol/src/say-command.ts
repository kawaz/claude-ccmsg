// What the daemon hands the say command (docs/design/say-command.md): one
// speech, as JSON on the command's standard input. The daemon writes it and
// the built-in say command (packages/daemon/src/default-say-command.ts) reads
// the fields it uses from it.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { PeerInfoSchema } from "./response-sessions.ts";

/** What asked for the speech: a `say` tool call, or a request for the
 * person's permission (the `permit` tool). */
export const SayCommandKindSchema = v.picklist(["say", "permit"]);
export type SayCommandKind = Output<typeof SayCommandKindSchema>;

/** One speech. `spoken` is what is to be heard: `text` with the reading
 * dictionary's readings put in place of its words.
 *
 * A reader takes the fields it uses and lets the rest through (`v.object`):
 * `session` is a peers row, whose fields move with ccmsg's version, and a
 * say command someone wrote must not stop speaking when one is added. */
export const SayCommandInputSchema = v.object({
  kind: SayCommandKindSchema,
  /** The session that said it or asked for permission (its sid). */
  session_id: v.pipe(v.string(), v.nonEmpty("must be a non-empty string")),
  /** The text as the session wrote it. */
  text: v.string(),
  /** `text` through the reading dictionary. */
  spoken: v.string(),
  /** That session as the `peers` op lists it (`ccmsg peers`'s row). Absent
   * when the daemon holds no such session. */
  session: v.optional(PeerInfoSchema),
  /** The webui page that opens on the bubble of what asked for the speech
   * (`<webui_url>/s/<sid>/timeline/...`, docs/design/say-command.md).
   * Absent when the daemon has no webui URL to write it with. */
  url: v.optional(v.string()),
});
export type SayCommandInput = Output<typeof SayCommandInputSchema>;
