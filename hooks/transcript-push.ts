// The rows that go into the session's conversation, passed on to the daemon
// as they go in (DR-0045 §2): what the engine's `session.append` carries, not
// read for what it says. The daemon reads the transcript's jsonl on them for
// the Timelines that follow the session, and later finds in them what it acts
// on. One push at a time, in the order the rows went in; the rows that went
// in while a push was out go together in the next. A push that does not
// arrive is dropped, and its rows are read from the jsonl with the next one.
import * as v from "valibot";
import type { TranscriptPushRow } from "@ccmsg/protocol";
import { JsonValueSchema } from "@ccmsg/protocol/json-value";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import { daemonOp } from "./daemon-op.ts";
import type { Engine } from "./engine.ts";

/** What the module reads of `session.append`: the row's uuid, the door it
 * went in by, whose conversation it is in, and the row as the engine has it. */
export const SessionAppendInputSchema = v.looseObject({
  uuid: v.string(),
  door: v.string(),
  agentId: v.optional(v.string()),
  message: JsonValueSchema,
});

/** What the event settles to when the engine or a plugin beneath refused
 * the row: it is not in the conversation. */
const RefusedSchema = v.looseObject({ deny: v.unknown() });

/** A row with nothing in it (a hook that ran and said nothing): Claude Code
 * writes it no line, so its push would only have the daemon wait for one. */
const EmptyRowSchema = v.looseObject({ content: v.pipe(v.array(v.unknown()), v.length(0)) });

/** The daemon's answer to a push. */
const PushedTextSchema = jsonText(v.looseObject({ ok: v.literal(true) }));

export interface TranscriptPushState {
  /** The rows not pushed yet, oldest first. */
  unpushed: TranscriptPushRow[];
  /** Whether a push is out. */
  pushing: boolean;
}

export function newTranscriptPushState(): TranscriptPushState {
  return { unpushed: [], pushing: false };
}

/** A row went into the conversation (`result` is what the event settled
 * to): push it, or let the push that is out take it next. A refused row, and
 * a row with no content, are not pushed. Never rejects. */
export function rowAppended<R>(
  $: Engine,
  state: TranscriptPushState,
  input: v.InferOutput<typeof SessionAppendInputSchema>,
  result: R,
): void {
  if (parseWith(RefusedSchema, result).ok) return;
  if (parseWith(EmptyRowSchema, input.message).ok) return;
  state.unpushed.push({
    uuid: input.uuid,
    door: input.door,
    ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
    message: input.message,
  });
  if (!state.pushing) void pushAll($, state);
}

/** Push the rows waiting, and those that come while each push is out, until
 * none waits. */
async function pushAll($: Engine, state: TranscriptPushState): Promise<void> {
  state.pushing = true;
  try {
    while (state.unpushed.length > 0) {
      const rows = state.unpushed.splice(0);
      const asked = await daemonOp($, { op: "transcript_push", rows });
      if (asked.kind === "answered") {
        if (!parseWith(PushedTextSchema, asked.text).ok) {
          $.ui.log(`ccmsg: transcript_push refused: ${asked.text}`, { to: "debug" });
        }
      } else {
        $.ui.log(`ccmsg: transcript_push not delivered (${asked.kind})`, { to: "debug" });
      }
    }
  } catch (error) {
    $.ui.log(`ccmsg: transcript_push failed: ${errorText(error)}`, { to: "debug" });
    state.unpushed.length = 0;
  } finally {
    state.pushing = false;
  }
}
