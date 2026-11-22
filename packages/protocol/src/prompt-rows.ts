// The rows of a session's transcript that may be the person's prompts (the
// webui's 👤 filter, DR-0058 §11), as schemas (DR-0038): the op that reads
// them and its reply. Only the webui reads them (user role), and the daemon
// serves the webui's bundle, so they move no protocol version
// (protocol-version.ts).
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import { BookmarkRowSchema } from "./bookmarks.ts";
import type { Output } from "./parse.ts";

/** The rows of session `sid`'s transcript that may be the person's prompts,
 * for the ones outside the webui's loaded window. User role only. Which of
 * them are prompts is the webui's to tell (the Timeline's own classifying of
 * rows): the daemon hands every `type:"user"` row with a uuid whose message
 * carries no tool result. With `since`, only the rows written at or after it
 * (their `timestamp`; a row without one is left out): what the composer asks
 * for when it looks for what it sent (DR-0035 §5). */
export const PromptRowsRequestSchema = v.object({
  op: v.literal("prompt_rows"),
  sid: v.pipe(v.string(), v.nonEmpty("Expected the session id")),
  since: v.optional(
    v.pipe(
      v.string(),
      v.check((at) => Number.isFinite(Date.parse(at)), "Expected an ISO-8601 time"),
    ),
  ),
});
export type PromptRowsRequest = Output<typeof PromptRowsRequestSchema>;

export const PromptRowsResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** In file order, each in the shape of a bookmark's row with the row's
   * line alone (a prompt is drawn from its own row). */
  rows: v.array(BookmarkRowSchema),
});
export type PromptRowsResponse = Output<typeof PromptRowsResponseSchema>;
