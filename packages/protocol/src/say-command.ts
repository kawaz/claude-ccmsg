// What the daemon hands the say command (docs/design/say-command.md): one
// speech, as JSON on the command's standard input. The daemon writes it and
// the built-in say command (packages/daemon/src/default-say-command.ts) reads
// it, so both go through this one schema.
//
// The built-in say command imports this file, so it imports nothing but
// valibot and parse.ts.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** What asked for the speech: a `say` tool call, or a request for the
 * person's permission (the `permit` tool). */
export const SayCommandKindSchema = v.picklist(["say", "permit"]);
export type SayCommandKind = Output<typeof SayCommandKindSchema>;

/** One speech. `spoken` is what is to be heard: `text` with the reading
 * dictionary's readings put in place of its words. */
export const SayCommandInputSchema = v.strictObject({
  kind: SayCommandKindSchema,
  /** The session that said it or asked for permission (its sid). */
  session_id: v.pipe(v.string(), v.nonEmpty("must be a non-empty string")),
  /** The text as the session wrote it. */
  text: v.string(),
  /** `text` through the reading dictionary. */
  spoken: v.string(),
});
export type SayCommandInput = Output<typeof SayCommandInputSchema>;

/** The say command's standard input as text. */
export const SayCommandInputTextSchema = jsonText(SayCommandInputSchema);
