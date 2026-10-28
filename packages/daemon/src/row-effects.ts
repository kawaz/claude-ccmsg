// What the daemon does on the rows a session's hooks module pushes (DR-0045
// §6): the tool calls whose effect is the daemon's. A `say` call is spoken.
// The rows are the engine's (`e.message`, §2 (b)): their tool_use blocks
// carry the id, the name and the input as the jsonl's do.
//
// An effect happens for a pushed row only, never for a line the catch-up
// read off the file (an old row is not acted on again), and once per tool_use
// id: compaction pushes the rows it keeps again under their uuids, and the
// relay has read those off the file already, so the caller passes on only
// the rows not read yet; the ids here catch a row pushed twice before its
// line is written.
import * as v from "valibot";
import {
  ccmsgSayText,
  JsonValueSchema,
  parseWith,
  ToolUseBlockSchema,
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

export interface RowEffectDeps {
  /** Speak `text` to the person (say-speech.ts). */
  speak(text: string): void;
}

/** Act on the tool calls of `rows`, which `sid`'s module pushed and the
 * relay has not read off the file. A subagent's or teammate's call counts as
 * the main thread's does. A call whose input is not the tool's does nothing:
 * the module refused it the same way. */
export function actOnPushedRows(
  effects: RowEffects,
  sid: string,
  rows: readonly TranscriptPushRow[],
  deps: RowEffectDeps,
): void {
  for (const row of rows) {
    for (const use of toolUsesOf(row)) {
      const text = ccmsgSayText(use.name, use.input);
      if (text === null) continue;
      let done = effects.done.get(sid);
      if (done === undefined) {
        done = new Set();
        effects.done.set(sid, done);
      }
      if (done.has(use.id)) continue;
      done.add(use.id);
      deps.speak(text);
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
