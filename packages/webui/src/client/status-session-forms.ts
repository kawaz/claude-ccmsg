// The Status tab's session forms (DR-0028 「restart」, DR-0018 §3.9): 新セッションを起動
// (a new session in this session's cwd), 再起動 and fork. Pure: what the forms
// open with, what they send, what the person saved as their defaults and how
// that is stored. The storage I/O and the sends are the components'
// (StatusSessionForms.tsx).
//
// The defaults belong to the session's working directory, not to its sid, for
// the reason a pin does (pinned-sessions.ts): the session that follows in the
// same directory — a restart's resumed one aside, a handed-over successor —
// has a new sid, and should open the forms with what was saved there.
import {
  LaunchInputSchema,
  jsonText,
  launchEffortFromTranscript,
  launchModelFromTranscript,
  parseWith,
  type LaunchEffort,
  type LaunchInput,
  type LaunchModel,
  type Output,
  type Parsed,
  type RequestOverrideState,
  type SessionContextUsage,
} from "@ccmsg/protocol";
import * as v from "valibot";
import { DEFAULT_LAUNCH_EFFORT, type SessionCreatorForm } from "./session-creator.ts";
import type { SessionRestartAsk } from "./ws.ts";

/** The new session's first prompt when nothing was saved. */
export const LAUNCH_DEFAULT_PROMPT = "準備して待て";

/** The fork's first prompt when nothing was saved: RESTART_PROMPT turned to a
 * fork, where the session it came from goes on and keeps what it runs. */
export const FORK_PROMPT =
  "fork (--fork-session) しました。元のセッションは動いたまま。teammate/subagent・workflow・background・cron/schedule は元のセッションのものなので、再開・貼り直しはしない。";

/** What a form saved: its first prompt. The model and effort are not saved:
 * a new session starts on the launch's defaults, a restart and a fork on what
 * the session runs as. A stored model or effort (an older save) is dropped as
 * it is read. */
const PromptDefaultSchema = v.object({ prompt: v.string() });
export type PromptDefault = Output<typeof PromptDefaultSchema>;

/** The stored defaults of one cwd, in a versioned envelope so a later shape
 * adds an option here and keeps reading what was written before. */
const StatusFormDefaultsSchema = v.object({
  v: v.literal(1),
  launch: v.optional(PromptDefaultSchema),
  restart: v.optional(PromptDefaultSchema),
  fork: v.optional(PromptDefaultSchema),
});
export type StatusFormDefaults = Output<typeof StatusFormDefaultsSchema>;

/** The forms whose prompt is saved, each under its own key. */
export type StatusFormName = "launch" | "restart" | "fork";

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

/** What the session runs as now, in the launch's vocabulary, per field: the
 * value its main-thread requests are sent with under the session override
 * (DR-0041 §5: the override's field over the session's own), else the session's
 * own as its hooks module names it, else the transcript's last answer. A
 * one-shot override is not taken: it holds for one turn only. A field whose
 * spelling names no picklist value is left out. */
export function sessionRunsAs(
  context: SessionContextUsage | undefined,
  overrides: RequestOverrideState | undefined,
): RunsAs {
  const rawModel = overrides?.session.model ?? context?.engine?.model ?? context?.model;
  const rawEffort = overrides?.session.effort ?? context?.engine?.effort ?? context?.effort;
  const model = rawModel === undefined ? undefined : launchModelFromTranscript(rawModel);
  const effort = rawEffort === undefined ? undefined : launchEffortFromTranscript(rawEffort);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** A model and an effort in the launch's vocabulary, each absent when there
 * is none to name: what a session runs as (`sessionRunsAs`), or what the
 * person chose in a restart or fork form (`chooseModel` / `chooseEffort`). */
export interface RunsAs {
  model?: LaunchModel;
  effort?: LaunchEffort;
}

/** A model chosen in a restart or fork form: the effort becomes that model's
 * `DEFAULT_LAUNCH_EFFORT`, over an effort chosen before. */
export function chooseModel(model: LaunchModel): RunsAs {
  return { model, effort: DEFAULT_LAUNCH_EFFORT[model] };
}

/** An effort chosen in a restart or fork form; the model chosen stays. */
export function chooseEffort(chosen: RunsAs, effort: LaunchEffort): RunsAs {
  return { ...chosen, effort };
}

/** What a restart or fork form's selects show: the person's choice over what
 * the session runs as. A field absent shows as 元の model / 元の effort. */
export function shownRunsAs(runsAs: RunsAs, chosen: RunsAs): RunsAs {
  return { ...runsAs, ...chosen };
}

/** The restart asked for: the prompt, and only the fields the person chose.
 * A field left as it opened is left out, for the daemon to resume with what
 * the session runs as at the restart (DR-0028 step 3), so the session goes
 * on on the model it runs on. */
export function restartAsk(prompt: string, chosen: RunsAs): SessionRestartAsk {
  return { prompt, ...chosen };
}

/** The fork's launch: `session_launch` resuming `sid` with `fork_session`, in
 * `cwd`, under the session's `name` (the launch command marks it a fork),
 * with the model and effort the form shows. Those are named whenever the form
 * can name them: a launch leaves a field it does not name to the launch
 * command, which leaves it to claude's settings, not the session's. */
export function forkLaunch(fork: {
  sid: string;
  cwd: string;
  name: string;
  prompt: string;
  runsAs: RunsAs;
  chosen: RunsAs;
}): Parsed<LaunchInput> {
  const name = fork.name.trim();
  return parseWith(LaunchInputSchema, {
    cwd: fork.cwd,
    resume: fork.sid,
    fork_session: true,
    ...shownRunsAs(fork.runsAs, fork.chosen),
    ...(name !== "" ? { name } : {}),
    prompt: fork.prompt,
  });
}

/** The new-session form 新セッションを起動 opens with: the SessionCreator's
 * defaults — `fable`, and the model's `DEFAULT_LAUNCH_EFFORT` (model and
 * effort left undefined) — whatever the session runs as and whatever was
 * saved, and the prompt saved for the cwd, else 準備して待て. Only cwd, model,
 * effort and prompt are of this form; the rest stays off. */
export function initialLaunchForm(
  cwd: string,
  saved: PromptDefault | undefined,
): SessionCreatorForm {
  return {
    cwd,
    model: undefined,
    effort: undefined,
    continue: false,
    resume: "",
    fork_session: false,
    name: "",
    prompt: saved?.prompt ?? LAUNCH_DEFAULT_PROMPT,
  };
}
