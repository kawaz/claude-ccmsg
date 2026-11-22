// The input box's btw (DR-0060 §8): what its effort select offers while btw
// is checked, and what a btw_ask that was not taken says to the person.
// Pure, so the composer's choices are testable without a composer.
import type { ErrorResponse, LaunchEffort } from "@ccmsg/protocol";
import type { OverrideChoice, OverrideGroup } from "../request-override-view.ts";

/** The effort select's groups for a btw: the in-effect value and the ⏱️ ones.
 * 📌 / 🏛️ change the session's own override, which a btw leaves alone. */
export function btwEffortGroups(groups: readonly OverrideGroup[]): OverrideGroup[] {
  return groups.filter((group) => group.label !== "session");
}

/** The effort a btw is asked with for `choice`: a ⏱️ one's, else none (the
 * session's, which the daemon fills). */
export function btwEffortOf(choice: OverrideChoice): LaunchEffort | undefined {
  return choice.kind === "once" ? choice.override.effort : undefined;
}

/** What a btw_ask error says to the person, with what to do next. */
export function btwAskFailureText(reply: ErrorResponse): string {
  switch (reply.error.code) {
    case "btw_busy":
      return "btw が同時に走れる数の上限に達しています。どれかが終わってから送ってください。";
    case "session_not_found":
      return `このセッションの場所 (cwd・config dir) が分からないため btw を聞けません: ${reply.error.msg}`;
    case "btw_command_unavailable":
      return `btw コマンドを起動できませんでした: ${reply.error.msg}`;
    default:
      return `btw を送れませんでした: ${reply.error.msg}`;
  }
}
