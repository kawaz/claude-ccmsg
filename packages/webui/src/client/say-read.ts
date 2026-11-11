// Which of a Timeline's say bubbles are unread (DR-0045 §7, DR-0027 §6.3).
//
// The bubbles are the transcript's own `say` calls (classifyBoundaryLine's
// `"say"` boundaries); whether one is unread is the daemon's `ev:"say_unread"`,
// keyed by the call's tool_use id. Pure, per DR-0005 §1, so which says count
// as shown is testable without a Timeline.
import type { BoundaryKind } from "./transcript-model.ts";

/** Where a say stands for the person reading the Timeline: unread, with what
 * its 既読 button does (marks this say alone); read; or outside read tracking
 * (a subagent's say, DR-0045 §7). */
export type SayReadState =
  | { kind: "unread"; onRead: () => void }
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
