// Which sidebar-internal panel is swapped in, and what it was opened with.
// Split out of Sidebar.tsx so the open/close transitions are exercisable
// without a renderer (DR-0005 §1, same convention as session-creator.ts).
//
// The fork prefill lives *inside* the session-creator member rather than
// beside the panel union, because it is a property of one particular opening
// of that panel — "open the launcher on this fork point" — not of the sidebar.
// Held as two independent pieces of state it outlived its panel: closing the
// launcher and pressing "+ 新規" again reopened the previous fork's source
// (visible since v0.97.0 as a stale 「fork 元」 block, and worse once the fork
// source also seeds cwd/model/effort — a launch meant to be plain would
// inherit the forked session's settings).
import type { SessionCreatorPrefill } from "./session-creator.ts";

/** The open panel across *both* the ROOMS and SESSIONS sections — see
 * `Sidebar`'s doc comment for why one union replaces three independent
 * booleans. `null` = no panel, i.e. each section shows its normal list. */
export type SidebarPanelState =
  | { kind: "room-creator" }
  | { kind: "session-search" }
  | { kind: "session-creator"; prefill: SessionCreatorPrefill | null }
  | null;

export type SidebarPanelKind = NonNullable<SidebarPanelState>["kind"];

/** A section's own toggle button: closes the panel when it is the open one,
 * otherwise opens it — closing whichever other panel was open, which is what
 * makes the exclusivity across sections trivial. A launcher opened this way is
 * always a plain launch: the user asked for a new session, not for a fork. */
export function toggleSidebarPanel(
  state: SidebarPanelState,
  kind: SidebarPanelKind,
): SidebarPanelState {
  if (state?.kind === kind) return null;
  return kind === "session-creator" ? { kind, prefill: null } : { kind };
}

/** The Timeline's "ここから fork" request: open the launcher on this fork
 * point, replacing whatever panel was open. */
export function openForkCreator(prefill: SessionCreatorPrefill): SidebarPanelState {
  return { kind: "session-creator", prefill };
}

/** What to hand the open launcher, or null when it was opened plainly (or is
 * not the open panel at all). */
export function sessionCreatorPrefill(state: SidebarPanelState): SessionCreatorPrefill | null {
  return state?.kind === "session-creator" ? state.prefill : null;
}
