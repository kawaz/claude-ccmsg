// Starting a Claude Code session (DR-0018 §3): the launch a person (the webui)
// or an agent (the `launch` tool) asks for, what the daemon hands the
// configured launch command on standard input, and what it answers.
//
// A launch's fields are claude's options in snake_case (`--fork-session` is
// `fork_session`), an option without an argument a boolean. Which options go
// together is said once, by the checks of LaunchInputSchema; the tool's
// schema, the command's input and the webui's form are all read with it.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// the protocol files that import nothing else.
import * as v from "valibot";
import { SESSION_ID_SHAPE } from "./ccmsg-address.ts";
import { jsonText, type Output } from "./parse.ts";

/** The models a launch may name (`claude --model`). */
export const LaunchModelSchema = v.picklist(["fable", "opus", "sonnet", "haiku"]);
export type LaunchModel = Output<typeof LaunchModelSchema>;

/** The efforts a launch may name (`claude --effort`). */
export const LaunchEffortSchema = v.picklist(["low", "medium", "high", "xhigh", "max"]);
export type LaunchEffort = Output<typeof LaunchEffortSchema>;

const LaunchCwdSchema = v.pipe(
  v.string(),
  v.check((p) => p.startsWith("/"), "絶対パスで指定する"),
);

/** "Not given" is the field's absence alone, so an empty text is refused. */
const NonEmptySchema = v.pipe(
  v.string(),
  v.minLength(1, "空にはできない (指定しない時は field ごと書かない)"),
);

/** A session id as hello takes one: a lowercase UUID. */
const SessionUuidSchema = v.pipe(v.string(), v.regex(SESSION_ID_SHAPE, "小文字の uuid で指定する"));

/** The fields of a launch, each one of claude's options (DR-0018 §3.2). The
 * object is strict: a field it does not have is refused rather than dropped,
 * since dropping it would let the caller believe it had an effect. */
export const LaunchFieldsSchema = v.strictObject({
  cwd: LaunchCwdSchema,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
  continue: v.optional(v.boolean()),
  resume: v.optional(SessionUuidSchema),
  /** The transcript record a fork copies up to (`--resume-session-at`). */
  resume_session_at: v.optional(SessionUuidSchema),
  fork_session: v.optional(v.boolean()),
  name: v.optional(NonEmptySchema),
  prompt: v.optional(NonEmptySchema),
});

/** Whether a launch carries on from an existing session (`--continue` or
 * `--resume`) rather than starting a new one. */
export function launchContinues(launch: {
  readonly continue?: boolean;
  readonly resume?: string;
}): boolean {
  return launch.continue === true || launch.resume !== undefined;
}

/** Whether the daemon chooses the id of the session a launch starts: a new
 * session, or a fork (`--fork-session`). A resume that does not fork keeps the
 * id it resumes, and claude refuses `--session-id` there. */
export function launchMakesSession(launch: {
  readonly continue?: boolean;
  readonly resume?: string;
  readonly fork_session?: boolean;
}): boolean {
  return !launchContinues(launch) || launch.fork_session === true;
}

/** Why a new launch without a model or an effort does not read, as the webui
 * shows it under the select and the tool tells the agent. */
export const LAUNCH_CHOOSE_MESSAGE = "選んでください (continue も resume も無い新規の起動では必須)";

const NEEDS_SOURCE = "continue か resume と一緒に指定する";

/** A launch, as the `session_launch` op and the webui's form read it. The
 * checks are the combinations claude refuses or ignores
 * (docs/findings/2026-10-25-fork-with-session-id.md); each is placed on the
 * field to change, and runs as soon as the fields it reads are readable, so a
 * form shows every reason at once. */
export const LaunchInputSchema = v.pipe(
  LaunchFieldsSchema,
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"]],
      (launch) => !(launch.continue === true && launch.resume !== undefined),
      "continue と resume は同時に指定できない",
    ),
    ["resume"],
  ),
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"], ["fork_session"]],
      (launch) => launch.fork_session !== true || launchContinues(launch),
      NEEDS_SOURCE,
    ),
    ["fork_session"],
  ),
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"], ["resume_session_at"]],
      (launch) => launch.resume_session_at === undefined || launchContinues(launch),
      NEEDS_SOURCE,
    ),
    ["resume_session_at"],
  ),
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"], ["model"]],
      (launch) => launchContinues(launch) || launch.model !== undefined,
      LAUNCH_CHOOSE_MESSAGE,
    ),
    ["model"],
  ),
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"], ["effort"]],
      (launch) => launchContinues(launch) || launch.effort !== undefined,
      LAUNCH_CHOOSE_MESSAGE,
    ),
    ["effort"],
  ),
);
export type LaunchInput = Output<typeof LaunchInputSchema>;
/** What `ccmsg sidecar launch` takes on standard input: one launch. */
export const LaunchInputTextSchema = jsonText(LaunchInputSchema);

/** The `launch` tool's fields, as the model is shown them: the launch's
 * without `resume_session_at`, which names a transcript record an agent has
 * no way to see. The tool's input is read with LaunchInputSchema (its
 * checks), from these fields alone. */
export const LaunchToolFieldsSchema = v.omit(LaunchFieldsSchema, ["resume_session_at"]);

/** Who asked for a launch: the person (`user`), or the asking session's id. */
const RequestedBySchema = v.union([v.literal("user"), SessionUuidSchema]);

/** What the launch command reads on standard input
 * (docs/design/launch-command.md): the launch with its `cwd` resolved to a
 * realpath, who asked, and, when the launch makes a session
 * (`launchMakesSession`), the id the daemon chose for it. */
export const LaunchCommandInputSchema = v.pipe(
  v.strictObject({
    ...LaunchFieldsSchema.entries,
    session_id: v.optional(SessionUuidSchema),
    requested_by: RequestedBySchema,
  }),
  v.check(
    ({ session_id: _id, requested_by: _by, ...launch }) => v.is(LaunchInputSchema, launch),
    "the launch does not read",
  ),
  v.forward(
    v.partialCheck(
      [["continue"], ["resume"], ["fork_session"], ["session_id"]],
      (input) => launchMakesSession(input) === (input.session_id !== undefined),
      "present exactly when the launch makes a session",
    ),
    ["session_id"],
  ),
);
export type LaunchCommandInput = Output<typeof LaunchCommandInputSchema>;

/** The `session_launch` reply: what the launch command did, uninterpreted.
 *
 * - `session_id`: when the launch makes a session and `exit_code` is 0, the
 *   id handed to the command. The command fails before it starts a session or
 *   exits 0 after, so a non-zero code means no session has this id.
 * - `exit_code`: the command's exit code, or `128 + <signal number>` when a
 *   signal ended it (143 for the timeout's SIGTERM, 137 for SIGKILL).
 * - `stdout` / `stderr`: the command's output as UTF-8, or, from 4096 bytes
 *   on, `output is <N> bytes, file: <path>` in its place (DR-0018 §3.6). */
export const SessionLaunchResponseSchema = v.object({
  ok: v.literal(true),
  session_id: v.optional(SessionUuidSchema),
  exit_code: v.pipe(v.number(), v.safeInteger()),
  stdout: v.string(),
  stderr: v.string(),
});
export type SessionLaunchResponse = Output<typeof SessionLaunchResponseSchema>;
/** The session_launch reply, as `ccmsg sidecar launch` prints it. */
export const SessionLaunchResponseTextSchema = jsonText(SessionLaunchResponseSchema);

/** The launch command's longest wait (`timeout_seconds`, DR-0018 §3.1). */
export const LAUNCH_TIMEOUT_SECONDS_MAX = 50;
/** After the timeout's SIGTERM, how long the command has before SIGKILL, and
 * after SIGKILL how long the daemon waits to see it exit (DR-0018 §3.5). */
export const LAUNCH_KILL_GRACE_MS = 500;
/** After the command exits, how long the daemon waits for its stdout / stderr
 * to reach EOF (DR-0018 §3.5). */
export const LAUNCH_PIPE_DRAIN_GRACE_MS = 500;

/** What a refused or failed `session_launch` means for the caller, in words
 * the webui and the tool both say: the daemon refuses a launch before it runs
 * the command, so a refusal is "not started", except `internal` (an op that
 * threw), which may have stopped after the command ran. */
export function launchErrorText(error: { readonly code: string; readonly msg: string }): {
  readonly started: "no" | "unknown";
  readonly text: string;
} {
  if (error.code === "internal") {
    return { started: "unknown", text: `起動したか確かめられなかった: ${error.msg}` };
  }
  return {
    started: "no",
    text: `ccmsg の daemon が起動を断ったので、起動していない (${error.code}): ${error.msg}`,
  };
}
