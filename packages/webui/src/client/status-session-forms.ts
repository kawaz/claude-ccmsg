// The Status tab's two session forms (DR-0028 「restart」, DR-0018 §3.9): 新セッションを起動
// (a new session in this session's cwd) and 再起動. Pure: what the forms open
// with, what the person saved as their defaults and how that is stored. The
// storage I/O and the sends are the components' (StatusSessionForms.tsx).
//
// The defaults belong to the session's working directory, not to its sid, for
// the reason a pin does (pinned-sessions.ts): the session that follows in the
// same directory — a restart's resumed one aside, a handed-over successor —
// has a new sid, and should open the forms with what was saved there.
import {
  LaunchEffortSchema,
  LaunchModelSchema,
  jsonText,
  parseWith,
  type Output,
} from "@ccmsg/protocol";
import * as v from "valibot";
import { shownEffort, shownModel, type SessionCreatorForm } from "./session-creator.ts";

/** The new session's first prompt when nothing was saved. */
export const LAUNCH_DEFAULT_PROMPT = "準備して待て";

/** What 新セッションを起動 saved: the model and effort its selects showed (an
 * effort absent when the select had none to show) and the prompt. */
const LaunchDefaultSchema = v.object({
  model: LaunchModelSchema,
  effort: v.optional(LaunchEffortSchema),
  prompt: v.string(),
});
export type LaunchDefault = Output<typeof LaunchDefaultSchema>;

/** What 再起動 saved: the resumed session's first prompt. */
const RestartDefaultSchema = v.object({ prompt: v.string() });
export type RestartDefault = Output<typeof RestartDefaultSchema>;

/** The stored defaults of one cwd, in a versioned envelope so a later shape
 * adds an option here and keeps reading what was written before. */
const StatusFormDefaultsSchema = v.object({
  v: v.literal(1),
  launch: v.optional(LaunchDefaultSchema),
  restart: v.optional(RestartDefaultSchema),
});
export type StatusFormDefaults = Output<typeof StatusFormDefaultsSchema>;

const StatusFormDefaultsTextSchema = jsonText(StatusFormDefaultsSchema);

/** localStorage key of the defaults saved for `cwd` (`ccmsg.<feature>.<scope>`). */
export function statusFormDefaultsStorageKey(cwd: string): string {
  return `ccmsg.statusForms.${cwd}`;
}

/** Reads a raw `localStorage.getItem(statusFormDefaultsStorageKey(cwd))`.
 * Nothing stored is nothing saved; a value that does not read as the
 * defaults (a manual edit, storage corruption) is ignored as a whole, and the
 * console says so with why. */
export function parseStatusFormDefaults(raw: string | null): StatusFormDefaults {
  if (raw === null) return { v: 1 };
  const read = parseWith(StatusFormDefaultsTextSchema, raw);
  if (read.ok) return read.value;
  console.warn(`ccmsg: ignored the stored Status form defaults: ${read.failure.summary}`);
  return { v: 1 };
}

/** The localStorage text for `defaults`, read back by `parseStatusFormDefaults`. */
export function serializeStatusFormDefaults(defaults: StatusFormDefaults): string {
  return JSON.stringify(defaults);
}

/** The new-session form 新セッションを起動 opens with: what was saved for the
 * cwd, else (a field left undefined) the SessionCreator's default — `fable`,
 * and the model's `DEFAULT_LAUNCH_EFFORT`. Not what the session itself runs
 * as: a new session starts on the defaults unless the person saved others.
 * Only cwd, model, effort and prompt are of this form; the rest stays off. */
export function initialLaunchForm(
  cwd: string,
  saved: LaunchDefault | undefined,
): SessionCreatorForm {
  return {
    cwd,
    model: saved?.model,
    effort: saved?.effort,
    continue: false,
    resume: "",
    fork_session: false,
    name: "",
    prompt: saved?.prompt ?? LAUNCH_DEFAULT_PROMPT,
  };
}

/** The default the form's values save as: the model and effort its selects
 * show. Null when the model select shows no model to save. */
export function launchDefaultOf(form: SessionCreatorForm): LaunchDefault | null {
  const model = parseWith(LaunchModelSchema, shownModel(form));
  if (!model.ok) return null;
  const effort = parseWith(LaunchEffortSchema, shownEffort(form));
  return {
    model: model.value,
    ...(effort.ok ? { effort: effort.value } : {}),
    prompt: form.prompt,
  };
}

/** Whether `a` and `b` save the same launch default. */
export function sameLaunchDefault(a: LaunchDefault | null, b: LaunchDefault | undefined): boolean {
  if (a === null || b === undefined) return false;
  return a.model === b.model && a.effort === b.effort && a.prompt === b.prompt;
}
