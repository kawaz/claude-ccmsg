// The note the main conversation is given with a teammate's idle
// notification (DR-0039 §10): that a response with nothing new to tell is
// the one word the webui folds. Without it the main conversation answers
// each idle notification with a line saying there is nothing to do, and
// the Timeline fills with them.
import * as v from "valibot";
import { NOTHING_TO_REPLY_TEXT } from "@ccmsg/protocol/nothing-to-reply";
import { errorText, jsonText, type Output, parseWith } from "@ccmsg/protocol/parse";
import type { Engine } from "./engine.ts";

/** What the main conversation is told with a row of idle notifications. It
 * rides the request ahead of the row it is about, so it speaks of the
 * notification that follows. */
export const IDLE_NOTE = `続く待機通知に新しい中身が無く、人に伝えることも無ければ、応答の本文は ${NOTHING_TO_REPLY_TEXT} の 1 語だけにする。`;

/** What the note reads of `session.append`: the door the row came in by, who
 * caused it, whose conversation keeps it (absent on main), and its blocks'
 * text. */
export const IdleNoteInputSchema = v.looseObject({
  door: v.string(),
  origin: v.looseObject({ kind: v.string() }),
  agentId: v.optional(v.string()),
  message: v.looseObject({
    content: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
  }),
});
type IdleNoteInput = Output<typeof IdleNoteInputSchema>;

/** Whether the row is a delivery through the agent team's mailbox into the
 * main conversation: a teammate's message or idle notification, which the
 * engine adds as a note of its own (Claude Code 2.1.332, findings
 * 2026-11-26-idle-notification-events). */
export function isMainMailboxRow(input: IdleNoteInput): boolean {
  return input.door === "note" && input.origin.kind === "engine" && input.agentId === undefined;
}

/** One `<teammate-message ...>` envelope of a mailbox row and what it holds. */
const ENVELOPE = /<teammate-message\b[^>]*>([\s\S]*?)<\/teammate-message>/g;

/** What an envelope holds when it is an idle notification: the JSON whose
 * `type` says so (`{"type":"idle_notification","from":...,"result":...}`). */
const IdleNotificationTextSchema = jsonText(
  v.looseObject({ type: v.literal("idle_notification") }),
);

/** Whether every envelope of the row is an idle notification, and there is
 * at least one. A row that also holds a teammate's message is not: the note
 * would have the answer to that message folded away.
 *
 * Design rationale: the row's text is read, not `session.receive`'s
 * structured delivery. The note has to go in once the row is in, ahead of
 * the turn that answers it, and the row is where the deliveries of one turn
 * are put together (a message and an idle notification that came together
 * share one row); a delivery received mid-turn goes into a row only once the
 * turn ends. Reading `session.receive` too would hold what came between the
 * two events as state, and the row still has to be matched to it. */
export function holdsIdleNotificationsAlone(input: IdleNoteInput): boolean {
  const text = input.message.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
  const bodies = [...text.matchAll(ENVELOPE)].map((m) => (m[1] ?? "").trim());
  return (
    bodies.length > 0 && bodies.every((body) => parseWith(IdleNotificationTextSchema, body).ok)
  );
}

/** Add the note to the main conversation after a row of idle notifications
 * went in: it rides the first request of the turn that answers the row,
 * whether the row came while main waited or once its turn ended. Never
 * rejects: without the note the row is in as it was. */
export async function noteIdleNotifications($: Engine, input: IdleNoteInput): Promise<void> {
  if (!holdsIdleNotificationsAlone(input)) return;
  try {
    await $.session.append({
      message: { type: "user", content: [{ type: "text", text: IDLE_NOTE }] },
    });
  } catch (e) {
    $.ui.log(`ccmsg: idle notification note not added: ${errorText(e)}`, { to: "debug" });
  }
}
