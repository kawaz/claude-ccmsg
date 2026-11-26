// The one word an agent's response body is when the response has nothing to
// tell the person (DR-0062 §5), such as after its `comment_reply` calls said
// all there was to say. What the agent is told to write (the ccmsg skill, a
// tool's description) and what the webui's Timeline folds by are this one
// definition.
//
// The hooks module bundles this file, so it imports nothing.

/** The whole of a response's body that has nothing to tell the person. The
 * webui's Timeline draws a one-line response holding it as an item folded
 * among the other items, not as a bubble (DR-0062 §12). */
export const NOTHING_TO_REPLY_TEXT = "nothing_to_reply";
