// Pure derivations for SessionCreator (DR-0018 §2.1/§3.4). Kept out of
// utils.ts as a standalone module, same convention as rooms-filter.ts /
// in-view-search.ts — the form model and its wire-request projection are
// exercised in isolation by session-creator.test.ts, and neither reads
// AppState nor does I/O (that's SessionCreator.tsx's job, per DR-0005 §1).
import type { SessionLauncherConfigTemplate, SessionLaunchRequest } from "@ccmsg/protocol";

/** DR-0018 §2.1 fixed dropdown options — the DR explicitly scopes "コマンド
 * テンプレの UI 編集" out (§2.3), so these lists are hardcoded here rather
 * than sourced from config; only `root_dirs`/`default_prompt` come from the
 * daemon (session_launcher_config). */
export const SESSION_CREATOR_MODELS = [
  "sonnet",
  "opus",
  "fable",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
export const SESSION_CREATOR_EFFORTS = ["low", "middle", "high", "xhigh"] as const;

export const DEFAULT_SESSION_CREATOR_MODEL = "fable";
export const DEFAULT_SESSION_CREATOR_EFFORT = "middle";

export interface SessionCreatorForm {
  cwd: string;
  model: string;
  effort: string;
  prompt: string;
  /** Which configured template the form is on, by name. Sent as
   * SessionLaunchRequest.template; also decides which `command`/`default_prompt`
   * the "default" buttons restore. */
  template: string;
  /** User-editable shell command template (DR-0018 §3.2 addendum 2026-07-17).
   * Initialized to the selected template's command verbatim (no variable
   * substitution — $CWD/$MODEL/$EFFORT/$PROMPT/$RESUME_SID/$RESUME_AT stay
   * literal); the "default" button restores that value. Sent as
   * SessionLaunchRequest.command only when it differs from the selected
   * template's command (see buildSessionLaunchRequest), so the common no-edit
   * case keeps the wire request identical to before. */
  command: string;
  /** Fork source session id and fork point record uuid, empty on a plain
   * launch. Both reach the command as `$RESUME_SID` / `$RESUME_AT`; the form
   * never builds a `claude` argv itself, so what a fork actually does is
   * whatever the chosen template's command says. */
  resumeSid: string;
  resumeAt: string;
}

/** What the Timeline's "ここから fork" action hands to the form: the session to
 * resume and the record to resume at (the selected item's own uuid — see
 * fork-point.ts). Both land in editable fields, so this is a starting point
 * rather than a fixed choice. */
export interface SessionCreatorPrefill {
  resumeSid: string;
  resumeAt: string;
}

/** The template the form opens on: for a fork, the first recipe that actually
 * uses the fork point (see `forkTemplate`); otherwise the configured default.
 * Falls back to the default template when a fork was requested but no recipe
 * consumes `$RESUME_AT` — SessionCreator warns in that case rather than
 * silently launching a non-fork command. */
export function initialTemplate(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill | null,
): SessionLauncherConfigTemplate | undefined {
  if (prefill) return forkTemplate(templates) ?? templates[0];
  return templates[0];
}

/** Which configured recipe is a fork recipe: the first whose command reads the
 * fork point. Derived from the command text rather than from a naming
 * convention or an extra config flag — a template that never expands
 * `$RESUME_AT` cannot fork no matter what it is called, and one that does
 * needs no declaration. Both `$RESUME_AT` and `${RESUME_AT}` count. */
export function forkTemplate(
  templates: SessionLauncherConfigTemplate[],
): SessionLauncherConfigTemplate | undefined {
  return templates.find((t) => usesForkPoint(t.command));
}

/** Whether a command text reads the fork point. Also answers the question the
 * form asks about the command the user is actually about to run — which may be
 * an edited one, or a template they switched to after asking for a fork. */
export function usesForkPoint(command: string): boolean {
  return /\$\{?RESUME_AT\b/.test(command);
}

/** What the form can inherit from the session a fork resumes: where it ran and
 * what it ran as. Assembled by SessionCreator.tsx from AppState — `cwd` from
 * the fork source's `peers` row, `model`/`effort` from its
 * `sessionStatuses` context observation (the latest main-context assistant
 * row) — and reduced to form values by `forkSourceDefaults`. Every field is
 * optional because each source can be absent independently: a fork of a
 * session that has since disconnected has no peer row, and a transcript from
 * an older CC version carries no `effort`. */
export interface ForkSourceInfo {
  cwd?: string;
  /** Raw `message.model`, e.g. "claude-fable-5[1m]" / "gpt-5.6-sol". */
  model?: string;
  /** Raw transcript `effort`, e.g. "medium". */
  effort?: string;
}

/** The dropdown option a raw transcript model maps to, or undefined when none
 * does. The launch form's models are families ("fable", "opus", "gpt-5.6-sol")
 * while a transcript records the concrete model the API answered as, so the
 * `[1m]` launch suffix is dropped and a `claude-<family>-<version...>` id is
 * reduced to its family. Ids that already are an option (the gpt-5.6-* ones,
 * and bare "opus"-style values) match directly. Anything else — "<synthetic>"
 * rows, a family with no option such as haiku — has no honest answer. */
export function launcherModelFromTranscript(raw: string): string | undefined {
  const model = raw.replace(/\[[^\]]*\]$/, "");
  const options: readonly string[] = SESSION_CREATOR_MODELS;
  if (options.includes(model)) return model;
  const family = /^claude-([a-z0-9.]+)-/.exec(model)?.[1];
  if (family && options.includes(family)) return family;
  return undefined;
}

/** The dropdown option a raw transcript effort maps to, or undefined. The two
 * vocabularies agree except at the middle rung, which the transcript spells
 * "medium" and the form "middle". */
export function launcherEffortFromTranscript(raw: string): string | undefined {
  const effort = raw === "medium" ? "middle" : raw;
  const options: readonly string[] = SESSION_CREATOR_EFFORTS;
  return options.includes(effort) ? effort : undefined;
}

/** Whether a path may be offered as a prefilled cwd: absolute and lexically
 * inside a configured launcher root. Purely lexical on purpose — the daemon
 * re-checks by realpath at launch (launcher-paths.ts), and the webui has no
 * way to resolve symlinks, so this only avoids seeding a value the daemon is
 * certain to reject. */
export function cwdWithinRoots(cwd: string, rootDirs: string[]): boolean {
  if (!cwd.startsWith("/")) return false;
  return rootDirs.some(
    (root) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
}

/** The form fields a fork inherits from its source, as a partial form. Values
 * that cannot be established honestly are simply absent, so
 * `initialSessionCreatorForm` keeps its own defaults for them: an unmappable
 * model or effort leaves the form exactly where a non-fork open leaves it, and
 * a cwd outside the configured roots stays empty so the user picks one rather
 * than pressing 実行 on a path the daemon will refuse. */
export function forkSourceDefaults(
  info: ForkSourceInfo | null,
  rootDirs: string[],
): Partial<Pick<SessionCreatorForm, "cwd" | "model" | "effort">> {
  if (!info) return {};
  const cwd = info.cwd?.trim();
  const model = info.model === undefined ? undefined : launcherModelFromTranscript(info.model);
  const effort = info.effort === undefined ? undefined : launcherEffortFromTranscript(info.effort);
  return {
    ...(cwd && cwdWithinRoots(cwd, rootDirs) ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Initial form state once the template list is known
 * (session_launcher_config response) — `cwd` starts empty; the run button
 * stays disabled until the CwdTree picker sets one (see
 * `sessionCreatorFormValid`). An empty template list cannot happen (the daemon
 * disables the launcher instead), so the fields fall back to empty strings
 * only to keep this total.
 *
 * `defaults` is what a fork inherits from its source (`forkSourceDefaults`);
 * on a plain open it is empty and every field keeps the values below. */
export function initialSessionCreatorForm(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill | null = null,
  defaults: Partial<Pick<SessionCreatorForm, "cwd" | "model" | "effort">> = {},
): SessionCreatorForm {
  const template = initialTemplate(templates, prefill);
  return {
    cwd: defaults.cwd ?? "",
    model: defaults.model ?? DEFAULT_SESSION_CREATOR_MODEL,
    effort: defaults.effort ?? DEFAULT_SESSION_CREATOR_EFFORT,
    prompt: template?.default_prompt ?? "",
    template: template?.name ?? "",
    command: template?.command ?? "",
    resumeSid: prefill?.resumeSid ?? "",
    resumeAt: prefill?.resumeAt ?? "",
  };
}

/** Switch the form to another configured template. Prompt and command follow
 * the new recipe wholesale: they are that recipe's text, so keeping the old
 * recipe's edits would leave the form showing a command the chosen template
 * never had. cwd/model/effort and the fork point are the user's own picks and
 * survive the switch. Unknown names leave the form untouched. */
export function selectSessionCreatorTemplate(
  form: SessionCreatorForm,
  templates: SessionLauncherConfigTemplate[],
  name: string,
): SessionCreatorForm {
  const template = templates.find((t) => t.name === name);
  if (!template) return form;
  return {
    ...form,
    template: template.name,
    prompt: template.default_prompt,
    command: template.command,
  };
}

/** issue 2026-07-17-session-creator-cwd-picker-unify: the cwd picker has two
 * display modes — "editing" shows the unified search/direct-entry input plus
 * CwdTree, "confirmed" shows the picked path as text with an edit (✎) button.
 * Kept as a form-adjacent enum (not part of SessionCreatorForm itself — mode
 * is presentation state, not part of the wire request) so SessionCreator.tsx
 * can hold it in its own useState alongside `form`. */
export type CwdPickerMode = "editing" | "confirmed";

/** Initial mode once the form is constructed: "confirmed" only when a cwd is
 * already set. `initialSessionCreatorForm`'s cwd always starts `""` today (no
 * default-cwd source exists yet), so this resolves to "editing" in practice —
 * kept as a pure function anyway so a future default-cwd source lands in
 * "confirmed" mode for free, and so the branch is unit-testable. */
export function initialCwdPickerMode(cwd: string): CwdPickerMode {
  return cwd.trim() === "" ? "editing" : "confirmed";
}

/** Direct-entry commit for the unified cwd input (issue requirement 5): the
 * same input that filters CwdTree also accepts a full path typed by hand and
 * confirmed (Enter). Trims and only transitions to "confirmed" on a non-blank
 * value — an empty Enter press is a no-op rather than an accidental
 * confirm-with-blank-cwd, mirroring `sessionCreatorFormValid`'s blank check. */
export function commitCwdInput(value: string): { cwd: string; mode: CwdPickerMode } | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return { cwd: trimmed, mode: "confirmed" };
}

/** Run button gate: `session_launch` requires a real `cwd` (dir_tree picks
 * only ever produce non-empty absolute paths, but the field is free-typeable
 * too — DR-0018 doesn't forbid typing a path directly, it just describes the
 * click-to-pick affordance). Prompt may legitimately be empty (an agent
 * launched with no prompt is still a valid `claude` invocation), so it's not
 * part of this gate. */
export function sessionCreatorFormValid(form: SessionCreatorForm): boolean {
  return form.cwd.trim() !== "";
}

/** Builds the wire `session_launch` request body (op and the 2-phase
 * request_id excluded — ws.ts's `sessionLaunch` adds both, same convention as
 * SessionSearchPanel's buildSessionSearchRequest). Returns null when the form
 * isn't launchable yet (mirrors sessionCreatorFormValid) so callers can't
 * accidentally fire a request with an empty cwd.
 *
 * The selected template's command is the comparison baseline: when the form's
 * `command` matches it verbatim, the override field is omitted so the daemon
 * runs the configured recipe (no-edit case). Any difference — including
 * whitespace-only changes the user made deliberately — is sent as-is. Empty
 * command isn't special-cased here (an empty template runs nothing
 * meaningful): the daemon rejects it with invalid_args so the user sees the
 * error rather than a silent fallback to the config value. Empty resume
 * fields are omitted rather than sent blank, for the same reason — the daemon
 * rejects a present-but-empty one. */
export function buildSessionLaunchRequest(
  form: SessionCreatorForm,
  templates: SessionLauncherConfigTemplate[],
): Omit<SessionLaunchRequest, "op" | "request_id"> | null {
  if (!sessionCreatorFormValid(form)) return null;
  const selected = templates.find((t) => t.name === form.template);
  const req: Omit<SessionLaunchRequest, "op" | "request_id"> = {
    cwd: form.cwd.trim(),
    model: form.model,
    effort: form.effort,
    prompt: form.prompt,
    ...(form.template === "" ? {} : { template: form.template }),
    ...(form.resumeSid === "" ? {} : { resume_sid: form.resumeSid }),
    ...(form.resumeAt === "" ? {} : { resume_at: form.resumeAt }),
  };
  if (form.command === selected?.command) return req;
  return { ...req, command: form.command };
}
