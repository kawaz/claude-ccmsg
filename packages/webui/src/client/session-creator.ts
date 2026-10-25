// Pure derivations for SessionCreator (DR-0018 §3.9). Kept out of utils.ts as
// a standalone module, same convention as rooms-filter.ts / in-view-search.ts —
// the form model and its projection onto a launch are exercised in isolation
// by session-creator.test.ts, and nothing here does I/O (that's
// SessionCreator.tsx's job, per DR-0005 §1).
//
// The form is one of the four launch types (DR-0018 §3.2). Which fields a type
// takes, which of them it requires, and whether a value is acceptable are all
// read off the protocol's LaunchInputSchema: the form holds text, builds the
// launch the schema reads, and sends only what the schema accepted.
import {
  LaunchEffortSchema,
  LaunchInputSchema,
  LaunchModelSchema,
  parseWith,
  type LaunchEffort,
  type LaunchInput,
  type LaunchModel,
  type LaunchType,
} from "@ccmsg/protocol";
import * as v from "valibot";
import {
  LAUNCH_FORM_FIELDS,
  type LaunchFormField,
  type LaunchSeed,
  type SidebarUrlState,
} from "./sidebar-url.ts";
import type { AppState } from "./store.ts";

/** The launch types in the order the type select offers them, read off the
 * schema's options so the form offers exactly the types the daemon reads. */
export const LAUNCH_TYPES: readonly LaunchType[] = LaunchInputSchema.options.map(
  (option) => option.entries.type.literal,
);
const LaunchTypeSchema = v.picklist(LAUNCH_TYPES);

/** The model / effort select options: the protocol's picklists, verbatim. */
export const LAUNCH_MODELS: readonly LaunchModel[] = LaunchModelSchema.options;
export const LAUNCH_EFFORTS: readonly LaunchEffort[] = LaunchEffortSchema.options;

/** What each type does, shown under the type select (DR-0018 §3.2's table). */
export const LAUNCH_TYPE_HINTS: Readonly<Record<LaunchType, string>> = {
  new: "新しいセッションを起動する",
  continue: "cwd で最も新しいセッションを続ける",
  resume: "指定したセッションを続ける (id は変わらない)",
  fork: "指定したセッションの履歴を写した新しいセッションを起動する",
};

/** Every field but the type: the ones the form holds as text. */
export type LaunchTextField = Exclude<LaunchFormField, "type">;
export const LAUNCH_TEXT_FIELDS: readonly LaunchTextField[] = LAUNCH_FORM_FIELDS.filter(
  (field): field is LaunchTextField => field !== "type",
);

/** Whether a type takes a field, and if so whether it may be left out. */
export type LaunchFieldRule = "required" | "optional";

function fieldRules(entries: v.ObjectEntries): Partial<Record<LaunchTextField, LaunchFieldRule>> {
  const rules: Partial<Record<LaunchTextField, LaunchFieldRule>> = {};
  for (const field of LAUNCH_TEXT_FIELDS) {
    const schema = entries[field];
    if (schema !== undefined) rules[field] = schema.type === "optional" ? "optional" : "required";
  }
  return rules;
}

const FIELD_RULES: ReadonlyMap<
  LaunchType,
  Partial<Record<LaunchTextField, LaunchFieldRule>>
> = new Map(
  LaunchInputSchema.options.map((option) => [
    option.entries.type.literal,
    fieldRules(option.entries),
  ]),
);

/** How `type` takes `field`; undefined when it does not, and the form then
 * shows no input for it. */
export function launchFieldRule(
  type: LaunchType,
  field: LaunchTextField,
): LaunchFieldRule | undefined {
  return FIELD_RULES.get(type)?.[field];
}

export interface SessionCreatorForm {
  type: LaunchType;
  /** The text of every field of every type. A field the current type does not
   * take keeps its text, so switching resume → fork → resume does not lose the
   * session id; it is neither shown nor sent while the type does not take it.
   * `model` / `effort` hold a picklist value or "" (指定しない). */
  values: Readonly<Record<LaunchTextField, string>>;
}

/** A seed model / effort the select can show: a picklist value, or "" when
 * the seed names none the select offers. */
function seededModel(value: string | undefined): string {
  const read = parseWith(LaunchModelSchema, value);
  return read.ok ? read.value : "";
}

function seededEffort(value: string | undefined): string {
  const read = parseWith(LaunchEffortSchema, value);
  return read.ok ? read.value : "";
}

/** The form a URL seed opens (`sb.<field>`). An absent or unknown `sb.type`
 * opens `new`; a model or effort outside the picklists opens as 指定しない,
 * since the select has no option to show it. Everything else is text the
 * user can see and edit, and the schema judges it on submit. */
export function initialSessionCreatorForm(seed: LaunchSeed): SessionCreatorForm {
  const type = parseWith(LaunchTypeSchema, seed.type);
  return {
    type: type.ok ? type.value : "new",
    values: {
      resume_session_id: seed.resume_session_id ?? "",
      resume_at: seed.resume_at ?? "",
      cwd: seed.cwd ?? "",
      model: seededModel(seed.model),
      effort: seededEffort(seed.effort),
      name: seed.name ?? "",
      prompt: seed.prompt ?? "",
    },
  };
}

/** The launch the form stands for, before the schema reads it: the type, and
 * each field the type takes. A blank optional field is left out — "not given"
 * is the field's absence (DR-0018 §3.2) — while a blank required one goes in
 * as "", so the schema says what is wrong with it rather than only that it is
 * missing. Values are trimmed except the prompt, whose spacing is the user's
 * text. */
export function launchCandidate(form: SessionCreatorForm): Record<string, string> {
  const candidate: Record<string, string> = { type: form.type };
  for (const field of LAUNCH_TEXT_FIELDS) {
    const rule = launchFieldRule(form.type, field);
    if (rule === undefined) continue;
    const text = form.values[field];
    const trimmed = text.trim();
    if (trimmed === "" && rule === "optional") continue;
    candidate[field] = field === "prompt" ? text : trimmed;
  }
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

export function checkSessionCreatorForm(form: SessionCreatorForm): LaunchFormCheck {
  const read = parseWith(LaunchInputSchema, launchCandidate(form));
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

/** The picklist model a raw transcript model stands for, or undefined. A
 * transcript records the concrete model the API answered as
 * (`claude-fable-5[1m]`), the launch names a family (`fable`), so a
 * `claude-<family>-…` id is reduced to its family; a value already spelled as
 * a family (with or without a context suffix) is read as it is. Anything else
 * — `<synthetic>` rows, another vendor's model — has no honest answer. */
export function launchModelFromTranscript(raw: string): LaunchModel | undefined {
  const family = /^claude-([a-z]+)-/.exec(raw)?.[1] ?? raw.replace(/\[[^\]]*\]$/, "");
  const read = parseWith(LaunchModelSchema, family);
  return read.ok ? read.value : undefined;
}

/** The picklist effort a raw transcript effort stands for, or undefined. The
 * transcript uses the CLI's vocabulary, so this is a membership check: a level
 * the picklist does not have leaves the select at 指定しない. */
export function launchEffortFromTranscript(raw: string): LaunchEffort | undefined {
  const read = parseWith(LaunchEffortSchema, raw);
  return read.ok ? read.value : undefined;
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
 * A blank or unmappable value is left out, and its field opens blank. */
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
      type: prefill.kind,
      resume_session_id: prefill.sessionId,
      ...(prefill.kind === "fork" ? { resume_at: prefill.resumeAt } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
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
