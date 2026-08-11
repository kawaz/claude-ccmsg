// Where a fork launch cuts the resumed conversation.
//
// The cut point is whatever record the user selected in the Timeline, passed
// through verbatim (kawaz r115 m7: 「原理的にはエージェントのメッセージや適当な
// thinking や items の一つの jsonl とかでも resumed_at に使えそうなものなら
// 選択できて良い」). Any rendered item that came from a record with a uuid is a
// legal choice — assistant answers, thinking blocks, individual tool items,
// user turns alike — and the form shows the uuid in an editable field, so a
// choice the CLI ends up rejecting is the user's to make and to fix.
//
// `claude --resume-session-at=<uuid>` keeps the loaded message array up to and
// INCLUDING the named record (docs/findings/2026-08-11-checkpoint-rewind.md
// §4/§6). Both sides of that boundary are things a user wants (kawaz r115 m9),
// so the panel offers them as two named choices rather than picking one and
// hoping the label explains it: keep the selected record ("この項目まで残す",
// the option's own semantics) or drop it too ("この項目から消す", which names
// the record before it). Naming a user turn is a usable fork either way — the
// finding records that the prompt simply stays unanswered and the new session
// answers it first.
//
// Pure: takes the Timeline's current selection, returns what the action panel
// can offer. DR-0005 §1 keeps this out of the component.
import type { ParsedLine } from "./transcript-model.ts";

/** What the Timeline's action panel can offer for the current selection. */
export type ForkActionState =
  | {
      kind: "ready";
      /** Keeps the selected record: the option is inclusive, so this is the
       * selection itself. */
      resumeAt: string;
      /** Drops the selected record too, by naming the one before it on the
       * live chain — which is exactly its parent, the chain being linear.
       * Absent when that parent is not in the loaded window (the selection sits
       * at the top of it) or when the selection starts the session, in which
       * case there is nothing to cut back to and only the inclusive choice is
       * offered. */
      resumeAtBefore?: string;
    }
  /** No item is selected — the panel asks the user to pick one. */
  | { kind: "no-selection" }
  /** Selected, but the record is not on the chain `--resume` reconstructs, so
   * naming it always exits with `No message found with message.uuid of:`
   * (measured — docs/findings/2026-08-11-checkpoint-rewind.md 事実 9). The
   * button is withheld rather than offered-and-failing. */
  | { kind: "off-chain" };

/** The chain `claude --resume` reconstructs, as the two things the panel asks
 * about it: whether a record is on it, and what comes immediately before a
 * record on it. */
export interface LiveChain {
  uuids: Set<string>;
  /** uuid -> the uuid before it on the chain, for uuids whose predecessor is
   * loaded. */
  parentOf: Map<string, string>;
}

/** A broken line carries neither link, so it never takes part in the walk. */
function links(line: ParsedLine): { uuid?: string; parentUuid?: string } {
  return line.kind === "broken" ? {} : line;
}

/** The uuids `claude --resume` would actually load: the chain that ends at the
 * newest row, walked backwards through `parentUuid`.
 *
 * A transcript file is a tree. Resuming without `--fork-session` appends the
 * new turns to the same file (findings 事実 7), so everything after that resume
 * point on the old branch stays in the file and stays rendered — but it is not
 * in the reconstructed message array, and naming it fails. Walking back from
 * the newest row is enough even on a partially loaded window: the window is a
 * contiguous byte range ending at the tail, so each successive parent is either
 * loaded or the walk has reached the top of the window.
 *
 * Rows with no uuid cannot be selected in the first place and are skipped. The
 * `uuids.has` guard is what makes a malformed cyclic link terminate. */
export function liveChain(lines: readonly ParsedLine[]): LiveChain {
  const byUuid = new Map<string, ParsedLine>();
  for (const line of lines) {
    const { uuid } = links(line);
    if (uuid) byUuid.set(uuid, line);
  }
  const uuids = new Set<string>();
  const parentOf = new Map<string, string>();
  let cursor = [...lines].reverse().find((line) => links(line).uuid !== undefined);
  while (cursor) {
    const { uuid, parentUuid } = links(cursor);
    if (uuid === undefined || uuids.has(uuid)) break;
    uuids.add(uuid);
    const parent = parentUuid === undefined ? undefined : byUuid.get(parentUuid);
    // Only a parent that is actually loaded counts: the exclusive choice has to
    // name a record, and a dangling link names nothing.
    if (parentUuid !== undefined && parent !== undefined) parentOf.set(uuid, parentUuid);
    cursor = parent;
  }
  return { uuids, parentOf };
}

/** Resolve the Timeline's selected position into a fork point. `position` is
 * the item selection the Timeline already tracks in its URL
 * (`/timeline/<uuid>`, "head" when nothing is selected) — its click-to-select
 * doubles as the action panel's selection, one selection model rather than
 * two. Items rendered from a record with no uuid never enter that selection
 * (the click handler needs one), so an unnamable record cannot reach here.
 *
 * `chain` is `liveChain` over the loaded window. An empty chain means the
 * window carried nothing to walk, in which case the selection is taken at face
 * value rather than being blamed on a chain that was never computed. */
export function forkActionState(position: string, chain: LiveChain): ForkActionState {
  if (position === "head") return { kind: "no-selection" };
  if (chain.uuids.size > 0 && !chain.uuids.has(position)) return { kind: "off-chain" };
  const before = chain.parentOf.get(position);
  return { kind: "ready", resumeAt: position, ...(before ? { resumeAtBefore: before } : {}) };
}
