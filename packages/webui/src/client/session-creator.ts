// Pure derivations for SessionCreator (DR-0018 §3.9). Kept out of utils.ts as
// a standalone module, same convention as rooms-filter.ts / in-view-search.ts —
// the form model and its projection onto a launch are exercised in isolation
// by session-creator.test.ts, and nothing here does I/O (that's
// SessionCreator.tsx's job, per DR-0005 §1).
//
// The form has every field of a launch at once, each one of claude's options
// (DR-0018 §3.2). Which combinations are refused, and why, is read off the
// protocol's LaunchInputSchema: the form holds what the user entered, builds
// the launch the schema reads, and sends only what the schema accepted.
import {
  LaunchEffortSchema,
  LaunchInputSchema,
  LaunchModelSchema,
  launchContinues,
  launchEffortFromTranscript,
  launchMakesSession,
  launchModelFromTranscript,
  parseWith,
  type LaunchEffort,
  type LaunchInput,
  type LaunchModel,
} from "@ccmsg/protocol";
import {
  LAUNCH_FORM_FIELDS,
  type LaunchFormField,
  type LaunchSeed,
  type SidebarUrlState,
} from "./sidebar-url.ts";
import type { AppState } from "./store.ts";

/** The model / effort select options: the protocol's picklists, verbatim. */
export const LAUNCH_MODELS: readonly LaunchModel[] = LaunchModelSchema.options;
export const LAUNCH_EFFORTS: readonly LaunchEffort[] = LaunchEffortSchema.options;

/** The model a new session's select opens on. */
export const DEFAULT_LAUNCH_MODEL: LaunchModel = "fable";

/** Per model, the effort the daemon's settings preselect (session_launcher_config's
 * `default_effort`). */
export type DefaultEfforts = Readonly<Partial<Record<LaunchModel, LaunchEffort>>>;

export interface SessionCreatorForm {
  cwd: string;
  /** The model / effort the user (or the link) chose: a picklist value, or ""
   * for 指定しない. Undefined while nothing was chosen, and the select then
   * shows the default (`shownModel` / `shownEffort`). Choosing a model clears
   * the effort's choice, so the effort follows the new model's default. */
  model: string | undefined;
  effort: string | undefined;
  continue: boolean;
  resume: string;
  resume_session_at: string;
  fork_session: boolean;
  name: string;
  prompt: string;
}

/** The form's options as a launch names them: `resume` only when written. */
function optionsOf(form: SessionCreatorForm): {
  continue: boolean;
  resume?: string;
  fork_session: boolean;
} {
  return {
    continue: form.continue,
    ...(form.resume.trim() !== "" ? { resume: form.resume } : {}),
    fork_session: form.fork_session,
  };
}

/** Whether the form carries on from a session (`--continue` or `--resume`).
 * Only then may model and effort be left to the launch command. */
export function formContinues(form: SessionCreatorForm): boolean {
  return launchContinues(optionsOf(form));
}

/** Whether the daemon chooses the id of the session the form starts (a new
 * session, or `--fork-session`), which the `--session-id` field says. */
export function formMakesSession(form: SessionCreatorForm): boolean {
  return launchMakesSession(optionsOf(form));
}

/** The model the select shows: the choice, or for a new session `fable`, and
 * 指定しない ("") when the form carries on from a session. */
export function shownModel(form: SessionCreatorForm): string {
  return form.model ?? (formContinues(form) ? "" : DEFAULT_LAUNCH_MODEL);
}

/** The effort the select shows: the choice, or for a new session the shown
 * model's default from the daemon's settings ("" — to choose — when it has
 * none), and 指定しない ("") when the form carries on from a session. */
export function shownEffort(form: SessionCreatorForm, defaults: DefaultEfforts): string {
  if (form.effort !== undefined) return form.effort;
  if (formContinues(form)) return "";
  const model = parseWith(LaunchModelSchema, shownModel(form));
  return (model.ok ? defaults[model.value] : undefined) ?? "";
}

/** A seed model / effort the select can show as a choice, or undefined (the
 * default) when the seed names none the select offers. */
function seededModel(value: string | undefined): string | undefined {
  const read = parseWith(LaunchModelSchema, value);
  return read.ok ? read.value : undefined;
}

function seededEffort(value: string | undefined): string | undefined {
  const read = parseWith(LaunchEffortSchema, value);
  return read.ok ? read.value : undefined;
}

/** The form a URL seed opens (`sb.<field>`). A model or effort outside the
 * picklists opens on the default, since the select has no option to show it;
 * an option is on when its seed is `true`. Everything else is text the user
 * can see and edit, and the schema judges it on submit. */
export function initialSessionCreatorForm(seed: LaunchSeed): SessionCreatorForm {
  return {
    cwd: seed.cwd ?? "",
    model: seededModel(seed.model),
    effort: seededEffort(seed.effort),
    continue: seed.continue === "true",
    resume: seed.resume ?? "",
    resume_session_at: seed.resume_session_at ?? "",
    fork_session: seed.fork_session === "true",
    name: seed.name ?? "",
    prompt: seed.prompt ?? "",
  };
}

/** The launch the form stands for, before the schema reads it. A blank field
 * and an option left off are left out — "not given" is the field's absence
 * (DR-0018 §3.2) — except `cwd`, which goes in even blank so the schema says
 * what is wrong with it. Values are trimmed except the prompt, whose spacing
 * is the user's text. */
export function launchCandidate(
  form: SessionCreatorForm,
  defaults: DefaultEfforts,
): Record<string, string | boolean> {
  const candidate: Record<string, string | boolean> = { cwd: form.cwd.trim() };
  const text = (field: string, value: string): void => {
    if (value.trim() !== "") candidate[field] = field === "prompt" ? value : value.trim();
  };
  text("model", shownModel(form));
  text("effort", shownEffort(form, defaults));
  if (form.continue) candidate.continue = true;
  text("resume", form.resume);
  text("resume_session_at", form.resume_session_at);
  if (form.fork_session) candidate.fork_session = true;
  text("name", form.name);
  text("prompt", form.prompt);
  return candidate;
}

/** The form read with LaunchInputSchema: the launch to send, or the reasons it
 * cannot be sent, by field (the first reason per field) plus any reason that
 * names no field. */
export type LaunchFormCheck =
  | { ok: true; launch: LaunchInput }
  | {
      ok: false;
      issues: Readonly<Partial<Record<LaunchFormField, string>>>;
      general: readonly string[];
    };

export function checkSessionCreatorForm(
  form: SessionCreatorForm,
  defaults: DefaultEfforts,
): LaunchFormCheck {
  const read = parseWith(LaunchInputSchema, launchCandidate(form, defaults));
  if (read.ok) return { ok: true, launch: read.value };
  const issues: Partial<Record<LaunchFormField, string>> = {};
  const general: string[] = [];
  for (const issue of read.failure.issues) {
    const field = LAUNCH_FORM_FIELDS.find((name) => name === issue.path);
    if (field === undefined) general.push(issue.message);
    else issues[field] ??= issue.message;
  }
  return { ok: false, issues, general };
}

/** What the Session Search result row's "resume" hands to the form: the
 * session, where it ran, what it last ran as (raw transcript spellings, from
 * the end of its transcript) and its title. */
export interface ResumePrefill {
  kind: "resume";
  sessionId: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** The title the session already carries. `claude --resume` does not restore
   * one, so a resume without `name` would come back under a derived name. */
  title?: string;
}

/** What the Timeline's "ここから fork" hands to the form: the session on
 * screen, the record to fork at (fork-point.ts), where and as what that
 * session runs, and its title. */
export interface ForkPrefill {
  kind: "fork";
  sessionId: string;
  resumeAt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** The source session's title. The fork is a new session, but it opens as
   * "this one, branched" (kawaz r259m62), so the source's name is the seed. */
  title?: string;
}

export type SessionCreatorPrefill = ForkPrefill | ResumePrefill;

/** The fork prefill for a session on screen, read out of AppState once at the
 * moment of the click. Only what the client already holds is read — nothing is
 * fetched for it:
 *
 * - cwd and title: a connected session's `peers` row and `agents` row; a
 *   session that is not connected (opened from Session Search) has neither,
 *   and the search hit it was opened from carries both from its transcript
 * - model / effort: the status entry's context observation (the Timeline
 *   subscribes the session it shows, DR-0020 §2.1)
 *
 * Whatever none of them knows is absent, and its field opens blank. */
export function forkPrefill(state: AppState, sessionId: string, resumeAt: string): ForkPrefill {
  const context = state.sessionStatuses.get(sessionId)?.context;
  const hit = state.sessionTrees.get(sessionId)?.searchHit;
  const cwd = state.peers.find((p) => p.sid === sessionId)?.cwd ?? hit?.cwd ?? undefined;
  const title =
    state.agents.find((a) => a.sessionId === sessionId)?.name ?? hit?.title ?? undefined;
  return {
    kind: "fork",
    sessionId,
    resumeAt,
    ...(cwd ? { cwd } : {}),
    ...(context?.model ? { model: context.model } : {}),
    ...(context?.effort ? { effort: context.effort } : {}),
    ...(title ? { title } : {}),
  };
}

/** The sidebar URL that opens the form on a session the user already chose.
 * Everything the opener knows goes into the link, so the link alone opens the
 * same form — pasted elsewhere, reloaded, or after the session disconnected.
 * A resume is `--resume <id>`; a fork adds `--fork-session` and the record to
 * fork at (`--resume-session-at`). A blank or unmappable value is left out,
 * and its field opens blank. */
export function prefillSidebarState(prefill: SessionCreatorPrefill): SidebarUrlState {
  const cwd = prefill.cwd?.trim();
  const model = prefill.model === undefined ? undefined : launchModelFromTranscript(prefill.model);
  const effort =
    prefill.effort === undefined ? undefined : launchEffortFromTranscript(prefill.effort);
  const title = prefill.title?.trim();
  return {
    panel: "session-creator",
    search: null,
    launch: {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      resume: prefill.sessionId,
      ...(prefill.kind === "fork"
        ? { resume_session_at: prefill.resumeAt, fork_session: "true" }
        : {}),
      ...(title ? { name: title } : {}),
    },
  };
}

/** issue 2026-07-17-session-creator-cwd-picker-unify: the cwd picker has two
 * display modes — "editing" shows the unified search/direct-entry input plus
 * CwdTree, "confirmed" shows the picked path as text with an edit (✎) button.
 * Kept beside the form rather than in it — mode is presentation state, not
 * part of the launch. */
export type CwdPickerMode = "editing" | "confirmed";

/** "confirmed" only when a cwd is already set (a prefill or a URL brought it). */
export function initialCwdPickerMode(cwd: string): CwdPickerMode {
  return cwd.trim() === "" ? "editing" : "confirmed";
}

/** Direct-entry commit for the unified cwd input: the input that filters
 * CwdTree also takes a full path typed by hand and confirmed with Enter. An
 * empty Enter is a no-op rather than a confirm-with-blank-cwd. */
export function commitCwdInput(value: string): { cwd: string; mode: CwdPickerMode } | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return { cwd: trimmed, mode: "confirmed" };
}
