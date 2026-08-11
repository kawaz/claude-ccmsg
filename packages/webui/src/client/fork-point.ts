// Where a fork launch cuts the resumed conversation.
//
// `claude --resume-session-at=<uuid>` keeps the loaded message array up to and
// INCLUDING the named record (docs/findings/2026-08-11-checkpoint-rewind.md
// §4/§6). So to re-do a user turn, the record to name is the assistant record
// immediately before it — naming the user turn itself would leave that prompt
// in the forked history, and the new session would answer it before reading
// anything the user types.
//
// Pure: takes the parsed lines the Timeline already holds, returns a uuid.
// DR-0005 §1 keeps this out of the component.
import type { ParsedLine } from "./transcript-model.ts";

/** The offset a 👤-nav key points at (`user:<offset>` / `ccmsg:<offset>:<i>`),
 * or null for anything else. The key grammar is userNavTargets'. */
export function userNavKeyOffset(navKey: string): number | null {
  const match = /^(?:user|ccmsg):(\d+)(?::\d+)?$/.exec(navKey);
  if (!match) return null;
  return Number(match[1]);
}

/** What the Timeline's action panel can offer for the current selection. The
 * three "not ready" cases each need a different sentence in the UI, so they
 * stay distinct instead of collapsing into a disabled button with no reason. */
export type ForkActionState =
  | { kind: "ready"; resumeAt: string }
  /** No turn is selected — the panel asks the user to pick one. */
  | { kind: "no-selection" }
  /** A turn is selected but nothing before it can be cut at (start of the
   * loaded window); loading older pages can resolve this. */
  | { kind: "no-fork-point" };

/** Resolve the selected turn into a fork point. `selectedKey` is the 👤-nav key
 * the Timeline already tracks (its click-to-select doubles as the action
 * panel's selection — one selection model, not two). */
export function forkActionState(
  selectedKey: string | undefined,
  lines: ParsedLine[],
  offsets: number[],
): ForkActionState {
  if (selectedKey === undefined) return { kind: "no-selection" };
  const offset = userNavKeyOffset(selectedKey);
  if (offset === null) return { kind: "no-selection" };
  const resumeAt = forkPointUuid(lines, offsets, offset);
  if (resumeAt === undefined) return { kind: "no-fork-point" };
  return { kind: "ready", resumeAt };
}

/** uuid of the record a fork should resume at to re-do the turn at `offset`:
 * the nearest preceding assistant record that has a uuid. Undefined when there
 * is none — the turn is at (or before) the start of the loaded window, and
 * nothing in view is a valid cut point. Loading older pages extends `lines`
 * and can turn that into an answer.
 *
 * `offsets[i]` is the byte offset of `lines[i]` (both come from the same
 * cache, so they are index-aligned); an offset that isn't in the window has no
 * fork point either. */
export function forkPointUuid(
  lines: ParsedLine[],
  offsets: number[],
  offset: number,
): string | undefined {
  const index = offsets.indexOf(offset);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.kind !== "turn" || line.role !== "assistant") continue;
    if (line.uuid) return line.uuid;
  }
  return undefined;
}
