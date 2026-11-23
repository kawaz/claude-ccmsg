// The input box's btw (DR-0062 §14): what its effort select offers while btw
// is on, and the effort a btw comment is asked with.
// Pure, so the composer's choices are testable without a composer.
import type { LaunchEffort } from "@ccmsg/protocol";
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
