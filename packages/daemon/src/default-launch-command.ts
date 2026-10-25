// The built-in launch command (DR-0018 §3.1): what the daemon runs when the
// config names no `launch_command`. It reads the launch command's input on
// standard input (docs/design/launch-command.md), writes each field as the
// claude option of the same name, and runs
// `hyoui run --detached -- claude <options>`, ending with hyoui's exit code.
//
// It adds nothing of the user's environment: no direnv, no model suffix, no
// session name decoration, no trust dialog handling, no cwd trust check. A
// setup that needs any of these writes its own launch command. What it refuses
// (an input that does not read, no hyoui, the first step of a fork at a
// record failing) it refuses before claude starts, exiting non-zero with the
// reason on standard error. A fork point without a fork does not read: the
// schema requires `fork_session` with `resume_session_at`.
//
// The daemon runs it as `[<the bun running the daemon>, <this file>]`, so it
// depends on nothing but bun and the protocol.
import {
  jsonText,
  LaunchCommandInputSchema,
  parseWith,
  type LaunchCommandInput,
} from "@ccmsg/protocol";

/** The claude options a launch command input stands for, the prompt last
 * after `--` (one argument, so a prompt starting with `-` is not read as an
 * option). An option without an argument is written only when it is true.
 * `resume_session_at` is not among them: the interactive claude ignores it
 * (forkAtRecordArgv). */
export function claudeArgv(input: LaunchCommandInput): string[] {
  return [
    ...(input.continue === true ? ["--continue"] : []),
    ...(input.resume !== undefined ? ["--resume", input.resume] : []),
    ...(input.fork_session === true ? ["--fork-session"] : []),
    ...(input.session_id !== undefined ? ["--session-id", input.session_id] : []),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.effort !== undefined ? ["--effort", input.effort] : []),
    ...(input.name !== undefined ? ["--name", input.name] : []),
    ...(input.prompt !== undefined ? ["--", input.prompt] : []),
  ];
}

/** A fork at a record (`fork_session` with `resume_session_at`) as the two
 * steps launch-command.md gives: `first`, the `-p` run that makes the fork cut
 * at the record under the new id, and `second`, the interactive resume of it.
 * `--resume-session-at` takes effect only with `-p`; given to the interactive
 * claude it is ignored and the whole history is copied. Undefined for any
 * other launch. */
export function forkAtRecordArgv(
  input: LaunchCommandInput,
): { first: string[]; second: string[] } | undefined {
  if (input.resume_session_at === undefined || input.session_id === undefined) return undefined;
  return {
    first: [
      "-p",
      ...(input.continue === true ? ["--continue"] : []),
      ...(input.resume !== undefined ? ["--resume", input.resume] : []),
      "--fork-session",
      "--session-id",
      input.session_id,
      "--resume-session-at",
      input.resume_session_at,
      "--output-format",
      "json",
      "/exit",
    ],
    second: claudeArgv({
      resume: input.session_id,
      cwd: input.cwd,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    }),
  };
}

const InputTextSchema = jsonText(LaunchCommandInputSchema);

function refuse(why: string): never {
  process.stderr.write(`ccmsg default launch command: ${why}\n`);
  process.exit(2);
}

async function main(): Promise<never> {
  const read = parseWith(InputTextSchema, await Bun.stdin.text());
  if (!read.ok) refuse(`the input does not read: ${read.failure.summary}`);
  const input = read.value;
  const hyoui = Bun.which("hyoui");
  if (hyoui === null) refuse("hyoui is not found in PATH");
  let argv = claudeArgv(input);
  const fork = forkAtRecordArgv(input);
  if (fork !== undefined) {
    const claude = Bun.which("claude");
    if (claude === null) refuse("claude is not found in PATH");
    const first = Bun.spawn([claude, ...fork.first], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    const code = await first.exited;
    if (code !== 0)
      refuse(
        `the fork at ${input.resume_session_at ?? ""} failed (claude -p exited ${String(code)})`,
      );
    argv = fork.second;
  }
  const run = Bun.spawn([hyoui, "run", "--detached", "--", "claude", ...argv], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await run.exited);
}

if (import.meta.main) await main();
