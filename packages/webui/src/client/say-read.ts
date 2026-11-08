// Which of a Timeline's say bubbles are unread, and what each 既読 button
// marks read (DR-0045 §7, DR-0027 §6.3).
//
// The bubbles are the transcript's own `say` calls (classifyBoundaryLine's
// `"say"` boundaries); whether one is unread is the daemon's `ev:"say_unread"`,
// keyed by the call's tool_use id. Pure, per DR-0005 §1, so the button rule is
// testable without a Timeline.
import type { BoundaryKind } from "./transcript-model.ts";

/** Where a say stands for the person reading the Timeline: unread, with the
 * ids its 既読 button marks; read; or outside read tracking (a subagent's
 * say, DR-0045 §7). */
export type SayReadState =
  | { kind: "unread"; ids: readonly string[]; onRead: (ids: readonly string[]) => void }
  | { kind: "read" }
  | { kind: "untracked" };

/** The tool_use ids of the unread says a Timeline shows, in the order it
 * draws them. `boundaries` is the Timeline's, index-aligned with its groups. */
export function shownUnreadSays(
  boundaries: ReadonlyArray<BoundaryKind | null>,
  unread: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const boundary of boundaries) {
    if (boundary?.kind === "say" && unread.has(boundary.toolUseId)) out.push(boundary.toolUseId);
  }
  return out;
}

/**
 * The ids the 既読 button on the say `id` marks read, out of the unread says
 * the Timeline shows (`shownUnread`, oldest first). The newest unread say's
 * button marks every one of them (kawaz 2026-10-25: a run of says piles up,
 * and pressing each is a chore); any other button marks its own say only. The
 * ids are the ones shown now, so a say arriving after the click, or one
 * outside the loaded window, stays unread.
 */
export function sayReadTargets(shownUnread: readonly string[], id: string): readonly string[] {
  return shownUnread.at(-1) === id ? shownUnread : [id];
}
