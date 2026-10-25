// Starting a Claude Code session (DR-0018 §3): the launch a person (the webui)
// or an agent (the `launch` tool) asks for, what the daemon hands the
// configured launch command on standard input, and what it answers.
//
// The launch and the launch command's input are two types: the daemon adds the
// new session's id to a `new` or `fork` launch before the command sees it, and
// nobody else may choose that id.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// parse.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** The models a launch may name (`claude --model`). */
export const LaunchModelSchema = v.picklist(["fable", "opus", "sonnet", "haiku"]);
export type LaunchModel = Output<typeof LaunchModelSchema>;

/** The efforts a launch may name (`claude --effort`). */
export const LaunchEffortSchema = v.picklist(["low", "medium", "high", "xhigh", "max"]);
export type LaunchEffort = Output<typeof LaunchEffortSchema>;

const LaunchCwdSchema = v.pipe(
  v.string(),
  v.check((p) => p.startsWith("/"), "must be an absolute path"),
);

/** "Not given" is the field's absence alone, so an empty text is refused. */
const NonEmptySchema = v.pipe(v.string(), v.minLength(1, "must not be empty"));

const SessionUuidSchema = v.pipe(v.string(), v.uuid("must be a uuid"));

const common = {
  cwd: LaunchCwdSchema,
  name: v.optional(NonEmptySchema),
  prompt: v.optional(NonEmptySchema),
};

// Each type is strict: a field the type has no use for (a `resume_session_id`
// on `new`) is refused, since dropping it would let the caller believe it had
// an effect.

export const NewLaunchSchema = v.strictObject({
  type: v.literal("new"),
  ...common,
  model: LaunchModelSchema,
  effort: LaunchEffortSchema,
});

export const ContinueLaunchSchema = v.strictObject({
  type: v.literal("continue"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
});

export const ResumeLaunchSchema = v.strictObject({
  type: v.literal("resume"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
  resume_session_id: SessionUuidSchema,
});

export const ForkLaunchSchema = v.strictObject({
  type: v.literal("fork"),
  ...common,
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
  resume_session_id: SessionUuidSchema,
  /** The transcript record the fork copies up to; absent copies to the tip. */
  resume_at: v.optional(SessionUuidSchema),
});

/** A launch, as the `launch` tool and the `session_launch` op both read it. */
export const LaunchInputSchema = v.variant("type", [
  NewLaunchSchema,
  ContinueLaunchSchema,
  ResumeLaunchSchema,
  ForkLaunchSchema,
]);
export type LaunchInput = Output<typeof LaunchInputSchema>;
export type LaunchType = LaunchInput["type"];

/** What the launch command reads on standard input (docs/design/launch-command.md):
 * the launch with its `cwd` resolved to a realpath, and on `new` and `fork`
 * the id the daemon chose for the new session. `continue` and `resume` carry
 * none: claude refuses `--session-id` on a resume that does not fork. */
export const LaunchCommandInputSchema = v.variant("type", [
  v.strictObject({ ...NewLaunchSchema.entries, session_id: SessionUuidSchema }),
  ContinueLaunchSchema,
  ResumeLaunchSchema,
  v.strictObject({ ...ForkLaunchSchema.entries, session_id: SessionUuidSchema }),
]);
export type LaunchCommandInput = Output<typeof LaunchCommandInputSchema>;

/** The `session_launch` reply: what the launch command did, uninterpreted.
 *
 * - `session_id`: on `new` and `fork` when `exit_code` is 0, the id handed to
 *   the command. The command fails before it starts a session or exits 0
 *   after, so a non-zero code means no session has this id.
 * - `exit_code`: the command's exit code, or `128 + <signal number>` when a
 *   signal ended it (143 for the timeout's SIGTERM, 137 for SIGKILL).
 * - `stdout` / `stderr`: the command's output as UTF-8, or, from 4096 bytes
 *   on, `output is <N> bytes, file: <path>` in its place (or `..., not saved:
 *   <why>` when the file could not be written). */
export const SessionLaunchResponseSchema = v.object({
  ok: v.literal(true),
  session_id: v.optional(SessionUuidSchema),
  exit_code: v.pipe(v.number(), v.safeInteger()),
  stdout: v.string(),
  stderr: v.string(),
});
export type SessionLaunchResponse = Output<typeof SessionLaunchResponseSchema>;
