// Pure derivations for SessionCreator (DR-0018 §2.1/§3.4). Kept out of
// utils.ts as a standalone module, same convention as rooms-filter.ts /
// in-view-search.ts — the form model and its wire-request projection are
// exercised in isolation by session-creator.test.ts, and neither reads
// AppState nor does I/O (that's SessionCreator.tsx's job, per DR-0005 §1).
//
// The form is entirely driven by the selected template's `params` declaration:
// which inputs exist, in what order, and what they start as all come from
// config. Nothing here reads the command text to guess at fields.
import {
  LAUNCHER_CWD_PARAM,
  type LauncherParam,
  type SessionLauncherConfigTemplate,
  type SessionLaunchRequest,
} from "@ccmsg/protocol";

/** DR-0018 §2.1 fixed dropdown options — the DR explicitly scopes "コマンド
 * テンプレの UI 編集" out (§2.3), so these lists are hardcoded here rather
 * than sourced from config. They decide what the MODEL / EFFORT widgets offer;
 * whether those inputs appear at all is the template's `params` declaration. */
export const SESSION_CREATOR_MODELS = [
  "sonnet",
  "opus",
  "fable",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
/** The effort levels `claude --effort` accepts, verbatim. An unknown value is
 * not an error there — the CLI warns on stderr and silently runs at its default
 * effort — so an option list that drifts from the CLI's costs the user the
 * setting without telling them. */
export const SESSION_CREATOR_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Parameter names the fork flow seeds: the source session and the record to
 * resume at. A template that declares neither simply cannot be forked into. */
export const RESUME_SID_PARAM = "RESUME_SID";
export const RESUME_AT_PARAM = "RESUME_AT";

/** Parameter name the resume flow seeds: the session to continue in place
 * (`claude --resume <sid>`). Distinct from RESUME_SID_PARAM because the two
 * flows differ in kind — a fork branches off a chosen record and needs a fork
 * point, a resume re-enters the session itself at its end. */
export const SESSION_ID_PARAM = "SESSION_ID";

/** Parameter name carrying the name the relaunched session should run under
 * (`claude --name`). A resume seeds it with the title the session already had,
 * because the CLI does not restore one: a `claude --resume` with no `--name`
 * registers under a name it derives from the directory (observed:
 * `"name":"main-41","nameSource":"derived"` in the peer's session record),
 * which then displaces the session's own title everywhere live name wins. */
export const TITLE_PARAM = "TITLE";

/** Which input a declared parameter gets. Chosen by name, because a name is
 * all the form knows about a parameter it did not invent: the four it
 * recognizes have a better control than a text box, and anything else — a
 * parameter this webui has never heard of — gets a plain one rather than not
 * being offered at all. */
export type ParamWidget = "cwd" | "model" | "effort" | "prompt" | "text";

export function paramWidget(name: string): ParamWidget {
  if (name === LAUNCHER_CWD_PARAM) return "cwd";
  if (name === "MODEL") return "model";
  if (name === "EFFORT") return "effort";
  if (name === "PROMPT") return "prompt";
  return "text";
}

export interface SessionCreatorForm {
  /** Which configured template the form is on, by name. Sent as
   * SessionLaunchRequest.template; also decides which parameters the form
   * shows and what the "default" buttons restore. */
  template: string;
  /** User-editable shell command template (DR-0018 §3.2 addendum 2026-07-17).
   * Initialized to the selected template's command verbatim (no variable
   * substitution — `$CWD` and the rest stay literal); the "default" button
   * restores that value. Sent as SessionLaunchRequest.command only when it
   * differs from the selected template's command (see
   * buildSessionLaunchRequest), so the common no-edit case keeps the wire
   * request identical to a plain configured launch. */
  command: string;
  /** Current value per declared parameter name, seeded from the declaration's
   * defaults. Keyed rather than positional so a template switch can carry the
   * user's edits across by name. */
  params: Record<string, string>;
}

/** What the Timeline's "ここから fork" action hands to the form: the session to
 * resume and the record to resume at (the selected item's own uuid — see
 * fork-point.ts). Both land in editable fields, so this is a starting point
 * rather than a fixed choice. */
export interface ForkPrefill {
  kind: "fork";
  resumeSid: string;
  resumeAt: string;
}

/** What the Session Search result row's "resume" action hands to the form: the
 * session to continue and where it ran. Unlike a fork, the cwd is part of the
 * request rather than inherited from live state — a historical hit has no peer
 * row to read it from, the search response carries it. */
export interface ResumePrefill {
  kind: "resume";
  cwd: string;
  sessionId: string;
  /** What the session last ran as, in raw transcript spellings (the search hit
   * carries both — see SessionSearchHit.model/effort). Resuming a session with
   * whatever the launcher happens to default to would silently switch it to
   * another model, so these are mapped onto the form's options the same way a
   * fork maps its source's. Absent when the search could not establish them. */
  model?: string;
  effort?: string;
  /** The title the session already carries (`SessionSearchHit.title`, from the
   * transcript's `custom-title` records). Seeded so the relaunched process
   * registers under its own name instead of a derived one. Absent when the
   * session was never renamed — there is nothing to carry, and the recipe's
   * declared default decides what happens then. */
  title?: string;
}

/** How the launcher was opened with a session already in hand. The two kinds
 * pick different recipes and seed different parameters, so callers say which
 * they meant rather than the form guessing from which fields are present. */
export type SessionCreatorPrefill = ForkPrefill | ResumePrefill;

/** Whether a template declares a given parameter — the single question that
 * decides both "does this recipe fork?" and "does this input exist?". */
export function templateDeclares(template: SessionLauncherConfigTemplate, name: string): boolean {
  return template.params.some((p) => p.name === name);
}

/** The template the form opens on, decided by how the form was opened rather
 * than by config order: a fork opens on the first recipe that takes a fork
 * point (`forkTemplate`), a resume on the first that takes a session id
 * (`resumeTemplate`), a plain "+ 新規" on the first that takes neither
 * (`plainTemplate`). All fall back to `templates[0]` when the config has no
 * recipe of the asked-for kind. */
export function initialTemplate(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill | null,
): SessionLauncherConfigTemplate | undefined {
  if (prefill?.kind === "fork") return forkTemplate(templates) ?? templates[0];
  if (prefill?.kind === "resume") return resumeTemplate(templates) ?? templates[0];
  return plainTemplate(templates) ?? templates[0];
}

/** Which configured recipe is a plain-launch recipe: the first that declares
 * neither the fork point nor a session id. Either one needs a session the user
 * chose elsewhere to mean anything, so such a recipe is never what "+ 新規"
 * asked for. */
export function plainTemplate(
  templates: SessionLauncherConfigTemplate[],
): SessionLauncherConfigTemplate | undefined {
  return templates.find(
    (t) => !templateDeclares(t, RESUME_AT_PARAM) && !templateDeclares(t, SESSION_ID_PARAM),
  );
}

/** Which configured recipe is a fork recipe: the first that declares the fork
 * point. Read from the declaration rather than from a naming convention or the
 * command text — the config says what a recipe takes. */
export function forkTemplate(
  templates: SessionLauncherConfigTemplate[],
): SessionLauncherConfigTemplate | undefined {
  return templates.find((t) => templateDeclares(t, RESUME_AT_PARAM));
}

/** Which configured recipe resumes a session in place: the first that declares
 * a session id. Same rule as `forkTemplate` — the declaration decides, not the
 * recipe's name. */
export function resumeTemplate(
  templates: SessionLauncherConfigTemplate[],
): SessionLauncherConfigTemplate | undefined {
  return templates.find((t) => templateDeclares(t, SESSION_ID_PARAM));
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

/** The dropdown option a raw transcript effort maps to, or undefined when none
 * does. The transcript records the level the session ran at in the same
 * vocabulary the CLI takes, so this is a membership check rather than a
 * translation: a level this form does not offer (a newer CC rung) has no
 * option to select and leaves the field at its default. */
export function launcherEffortFromTranscript(raw: string): string | undefined {
  const options: readonly string[] = SESSION_CREATOR_EFFORTS;
  return options.includes(raw) ? raw : undefined;
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

/** Seed values a fork inherits from its source, as parameter values. Values
 * that cannot be established honestly are simply absent, so the declared
 * defaults survive: an unmappable model or effort leaves the form exactly
 * where a non-fork open leaves it, and a cwd outside the configured roots
 * stays at its default so the user picks one rather than pressing 実行 on a
 * path the daemon will refuse. */
export function forkSourceDefaults(
  info: ForkSourceInfo | null,
  rootDirs: string[],
): Record<string, string> {
  if (!info) return {};
  const cwd = info.cwd?.trim();
  return {
    ...(cwd && cwdWithinRoots(cwd, rootDirs) ? { [LAUNCHER_CWD_PARAM]: cwd } : {}),
    ...launchDefaultsFromTranscript(info),
  };
}

/** MODEL / EFFORT seed values for a form opened on an existing session, from
 * that session's raw transcript spellings. Both openings that continue an
 * existing session want this — a fork and a resume differ in where they read
 * the session's values from, not in what "run it as what it is" means. */
export function launchDefaultsFromTranscript(source: {
  model?: string;
  effort?: string;
}): Record<string, string> {
  const model = source.model === undefined ? undefined : launcherModelFromTranscript(source.model);
  const effort =
    source.effort === undefined ? undefined : launcherEffortFromTranscript(source.effort);
  return {
    ...(model ? { MODEL: model } : {}),
    ...(effort ? { EFFORT: effort } : {}),
  };
}

/** Declared defaults as a value map, overlaid with whatever seed values apply
 * to parameters this template actually declares. A seed for an undeclared
 * parameter is dropped rather than carried invisibly — the request may only
 * carry declared values, and an input the user cannot see should not decide
 * anything. */
function paramValues(
  params: LauncherParam[],
  seed: Record<string, string> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { name, default: value } of params) {
    values[name] = seed[name] ?? value;
  }
  return values;
}

/** The parameter values an opening carries with it. A fork brings its fork
 * point; a resume brings the session and, unlike a fork, its own cwd,
 * model/effort and title — the search hit carries them all, and a historical
 * session has no live peer row or status entry for `forkSourceDefaults` to
 * read them from. A blank title is left out rather than seeded as "", so a
 * session that never had one keeps the recipe's declared default.
 * The session id is placed last so it cannot be displaced. A blank cwd is left out
 * rather than seeded, so a recipe with a declared default CWD keeps it and the
 * picker opens in "editing" mode for the user to choose. */
function prefillSeed(prefill: SessionCreatorPrefill | null): Record<string, string> {
  if (!prefill) return {};
  if (prefill.kind === "fork") {
    return { [RESUME_SID_PARAM]: prefill.resumeSid, [RESUME_AT_PARAM]: prefill.resumeAt };
  }
  const title = prefill.title?.trim();
  return {
    ...(prefill.cwd.trim() === "" ? {} : { [LAUNCHER_CWD_PARAM]: prefill.cwd }),
    ...launchDefaultsFromTranscript(prefill),
    ...(title ? { [TITLE_PARAM]: title } : {}),
    [SESSION_ID_PARAM]: prefill.sessionId,
  };
}

/** Initial form state once the template list is known
 * (session_launcher_config response). An empty template list cannot happen
 * (the daemon disables the launcher instead), so the fields fall back to empty
 * only to keep this total.
 *
 * `defaults` is what a fork inherits from its source (`forkSourceDefaults`);
 * on a plain open it is empty and every parameter keeps its declared default.
 * The prefill's own values are seeded the same way, so a template that does not
 * declare them simply ignores them. */
export function initialSessionCreatorForm(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill | null = null,
  defaults: Record<string, string> = {},
): SessionCreatorForm {
  const template = initialTemplate(templates, prefill);
  const seed = {
    ...defaults,
    ...prefillSeed(prefill),
  };
  return {
    template: template?.name ?? "",
    command: template?.command ?? "",
    params: paramValues(template?.params ?? [], seed),
  };
}

/** Switch the form to another configured template. The command follows the new
 * recipe wholesale — it is that recipe's text, so keeping the old one's edits
 * would leave the form showing a command the chosen template never had.
 * Parameters restart from the new declaration, except that a value the user
 * moved away from the old recipe's default carries over when the new recipe
 * declares the same name: a picked cwd or a typed prompt is the user's work and
 * survives, while an untouched field takes the new recipe's default. Unknown
 * names leave the form untouched. */
export function selectSessionCreatorTemplate(
  form: SessionCreatorForm,
  templates: SessionLauncherConfigTemplate[],
  name: string,
): SessionCreatorForm {
  const template = templates.find((t) => t.name === name);
  if (!template) return form;
  const previous = templates.find((t) => t.name === form.template);
  const edited: Record<string, string> = {};
  for (const { name: param, default: previousDefault } of previous?.params ?? []) {
    const value = form.params[param];
    if (value !== undefined && value !== previousDefault) edited[param] = value;
  }
  return {
    template: template.name,
    command: template.command,
    params: paramValues(template.params, edited),
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
 * already set — which happens when a fork inherits its source's directory, or
 * when the template declares a default CWD. */
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

/** The form's current working directory: the CWD parameter's value. Every
 * template declares it (the daemon adds it when config omits it), so this is
 * only total-by-construction for a form built from a template list. */
export function sessionCreatorCwd(form: SessionCreatorForm): string {
  return form.params[LAUNCHER_CWD_PARAM] ?? "";
}

/** Run button gate: `session_launch` requires a real `cwd` (dir_tree picks
 * only ever produce non-empty absolute paths, but the field is free-typeable
 * too — DR-0018 doesn't forbid typing a path directly, it just describes the
 * click-to-pick affordance). Other parameters may legitimately be empty (an
 * agent launched with no prompt is still a valid `claude` invocation), so
 * nothing else is part of this gate. */
export function sessionCreatorFormValid(form: SessionCreatorForm): boolean {
  return sessionCreatorCwd(form).trim() !== "";
}

/** Builds the wire `session_launch` request body (op and the 2-phase
 * request_id excluded — ws.ts's `sessionLaunch` adds both, same convention as
 * SessionSearchPanel's buildSessionSearchRequest). Returns null when the form
 * isn't launchable yet (mirrors sessionCreatorFormValid) so callers can't
 * accidentally fire a request with an empty cwd.
 *
 * CWD travels as the request's own `cwd` (the daemon containment-checks it and
 * spawns there); every other declared parameter travels in `params`. The
 * selected template's command is the comparison baseline: when the form's
 * `command` matches it verbatim, the override field is omitted so the daemon
 * runs the configured recipe (no-edit case). Any difference — including
 * whitespace-only changes the user made deliberately — is sent as-is. Empty
 * command isn't special-cased here (an empty template runs nothing
 * meaningful): the daemon rejects it with invalid_args so the user sees the
 * error rather than a silent fallback to the config value. */
export function buildSessionLaunchRequest(
  form: SessionCreatorForm,
  templates: SessionLauncherConfigTemplate[],
): Omit<SessionLaunchRequest, "op" | "request_id"> | null {
  if (!sessionCreatorFormValid(form)) return null;
  const selected = templates.find((t) => t.name === form.template);
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(form.params)) {
    if (name !== LAUNCHER_CWD_PARAM) params[name] = value;
  }
  const req: Omit<SessionLaunchRequest, "op" | "request_id"> = {
    cwd: sessionCreatorCwd(form).trim(),
    params,
    ...(form.template === "" ? {} : { template: form.template }),
  };
  if (form.command === selected?.command) return req;
  return { ...req, command: form.command };
}
