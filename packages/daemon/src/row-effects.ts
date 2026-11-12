// What the daemon does on the rows a session's hooks module pushes (DR-0045
// §6): the tool calls whose effect is the daemon's. A `say` call is spoken,
// and so is a `permit` call (the request for permission, DR-0040 §6). The
// rows are the engine's (`e.message`, §2 (b)): their tool_use blocks carry
// the id, the name and the input as the jsonl's do, and the row its uuid,
// which is the uuid of the row's line in the jsonl.
//
// An effect happens for a pushed row only, never for a line the catch-up
// read off the file (an old row is not acted on again), and once per tool_use
// id: compaction pushes the rows it keeps again under their uuids, and the
// relay has read those off the file already, so the caller passes on only
// the rows not read yet; the ids here catch a row pushed twice before its
// line is written.
import * as v from "valibot";
import {
  ccmsgPermitVoice,
  ccmsgSayText,
  JsonValueSchema,
  parseWith,
  timelineHref,
  ToolUseBlockSchema,
  type SayCommandKind,
  type ToolUseBlock,
  type TranscriptPushRow,
} from "@ccmsg/protocol";

/** A pushed row read for its blocks: an assistant row's content. A row
 * whose content is a string (a person's prompt) has none. */
const RowContentSchema = v.looseObject({ content: v.array(JsonValueSchema) });

/** The tool calls of a pushed row, in order. */
export function toolUsesOf(row: TranscriptPushRow): ToolUseBlock[] {
  const read = parseWith(RowContentSchema, row.message);
  if (!read.ok) return [];
  return read.value.content.flatMap((block) => {
    const use = parseWith(ToolUseBlockSchema, block);
    return use.ok ? [use.value] : [];
  });
}

export interface RowEffects {
  /** The tool_use ids acted on, by session. */
  done: Map<string, Set<string>>;
}

export function createRowEffects(): RowEffects {
  return { done: new Map() };
}

/** A speech a pushed call asks for: what asked, the text as written, and
 * the webui path that opens on the call's bubble. */
export interface RowSpeech {
  kind: SayCommandKind;
  text: string;
  href: string;
}

export interface RowEffectDeps {
  /** Speak to the person (say-speech.ts). */
  speak(speech: RowSpeech): void;
}

/** The speech `use`, a call of `row` in session `sid`, asks for, or null
 * when it asks for none.
 *
 * - `say`: the main thread's is opened at its row, the bubble the session's
 *   Timeline selects by the row's uuid. A subagent's or teammate's row is in
 *   the agent's own transcript, and the session's Timeline draws its bubble
 *   at its time with no position (DR-0050 §10), so it is opened under the 🔔
 *   filter, which shows it with the newest at the bottom.
 * - `permit`: the main thread's only, opened at its row (the request's
 *   bubble is selected by the call's row, DR-0040 §7). The module refuses a
 *   subagent's call (DR-0040 §9), so no request went out to speak of.
 *
 * A call whose input is not the tool's asks for none: the module refused it
 * the same way. */
function speechOf(sid: string, row: TranscriptPushRow, use: ToolUseBlock): RowSpeech | null {
  const atRow = timelineHref(sid, row.uuid);
  const said = ccmsgSayText(use.name, use.input);
  if (said !== null) {
    return {
      kind: "say",
      text: said,
      href: row.agent_id === undefined ? atRow : timelineHref(sid, "head", "say"),
    };
  }
  if (row.agent_id !== undefined) return null;
  const voice = ccmsgPermitVoice(use.name, use.input);
  return voice !== null ? { kind: "permit", text: voice, href: atRow } : null;
}

/** Act on the tool calls of `rows`, which `sid`'s module pushed and the
 * relay has not read off the file. */
export function actOnPushedRows(
  effects: RowEffects,
  sid: string,
  rows: readonly TranscriptPushRow[],
  deps: RowEffectDeps,
): void {
  for (const row of rows) {
    for (const use of toolUsesOf(row)) {
      const speech = speechOf(sid, row, use);
      if (speech === null) continue;
      let done = effects.done.get(sid);
      if (done === undefined) {
        done = new Set();
        effects.done.set(sid, done);
      }
      if (done.has(use.id)) continue;
      done.add(use.id);
      deps.speak(speech);
    }
  }
}

/** Keep the ids of the live sessions (`sids`) only: a session no longer live
 * pushes nothing more, and once it is live again the catch-up reads its rows
 * off the file. */
export function keepRowEffectsOf(effects: RowEffects, sids: Iterable<string>): void {
  const live = new Set(sids);
  for (const sid of effects.done.keys()) if (!live.has(sid)) effects.done.delete(sid);
}
