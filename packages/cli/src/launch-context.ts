// `ccmsg launch-context`: which session a launch that carries on from one
// carries on from, and what to add to its model and effort (the daemon's
// launch-context.ts). For a launch command: it starts a continue as the
// `--resume` of the id this names, or keeps the `--continue` when this says
// `--resume` would refuse that session (docs/design/launch-command.md), and
// passes the model and effort this adds. Reads the config dir a claude started in
// this environment would use and the cwd; does not start or reach the daemon.
import * as os from "node:os";
import {
  isSessionIdShape,
  launchEffortFromTranscript,
  launchModelFromTranscript,
  type LaunchRunsAs,
} from "@ccmsg/protocol";
import {
  claudeConfigDir,
  launchContext,
  type LaunchContextAsk,
} from "@ccmsg/daemon/launch-context";

export const LAUNCH_CONTEXT_USAGE =
  "ccmsg launch-context (--continue [--print] | --resume <session-id>) [--model <model>] [--effort <effort>]";

export const LAUNCH_CONTEXT_HELP = `ccmsg launch-context — the session a launch that carries on from one carries on from

Usage:
  ${LAUNCH_CONTEXT_USAGE}

Prints one JSON line: {"ok":true,"session_id":…,"keep_continue":…,"model":…,"effort":…}.
  session_id     --continue: the session \`claude --continue\` started here
                 would carry on (absent when it has none: an interactive claude
                 then says "No conversation found to continue", a -p one starts
                 a new session). --resume: the id as given
  keep_continue  --continue: true when \`claude --resume <session_id>\` would
                 refuse that session (it holds no conversation claude can
                 read); start the launch with --continue as given, which
                 carries on that session under session_id. Absent otherwise
  model          absent when --model is given; otherwise the session's, from
                 the newest main-context assistant row of its transcript, as a
                 launch names it (fable, opus, ...). Absent when none is read
  effort         the same for --effort. Not carried onto a --model that names
                 another model than the session's

The config dir is CLAUDE_CONFIG_DIR, or ~/.claude without it, the cwd this
process's: those of the claude the launch starts. Running sessions are chosen
as claude chooses them. Start the launch with --resume <session_id> rather than
--continue, so it carries on the session this named, unless keep_continue is
true.

Options:
  --continue          The launch is \`claude --continue\`
  --print             With --continue: the launch is \`claude -p --continue\`
                      (an interactive one passes over the -p and SDK sessions)
  --resume <id>       The launch is \`claude --resume <id>\`
  --model <model>     The model the launch names
  --effort <effort>   The effort the launch names
  -h, --help          Show this help
`;

/** The ask of `ccmsg launch-context`'s options, or the reason they do not
 * read. */
export function readLaunchContextAsk(
  positionals: readonly string[],
  opts: Readonly<Record<string, string | boolean>>,
): { ok: true; ask: LaunchContextAsk } | { ok: false; reason: string } {
  const refuse = (reason: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `${reason}\n  usage: ${LAUNCH_CONTEXT_USAGE}`,
  });
  if (positionals[0] !== undefined) return refuse(`unexpected argument "${positionals[0]}"`);
  const known = new Set(["continue", "print", "resume", "model", "effort"]);
  const unknown = Object.keys(opts).find((key) => !known.has(key));
  if (unknown !== undefined) return refuse(`unknown option --${unknown}`);
  let model: LaunchRunsAs["model"];
  if (opts.model !== undefined) {
    model = typeof opts.model === "string" ? launchModelFromTranscript(opts.model) : undefined;
    if (model === undefined) {
      return refuse(`--model names no model a launch can name (${String(opts.model)})`);
    }
  }
  let effort: LaunchRunsAs["effort"];
  if (opts.effort !== undefined) {
    effort = typeof opts.effort === "string" ? launchEffortFromTranscript(opts.effort) : undefined;
    if (effort === undefined) {
      return refuse(`--effort names no effort a launch can name (${String(opts.effort)})`);
    }
  }
  const runsAs: LaunchRunsAs = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
  const resume = opts.resume;
  if (opts.continue === true) {
    if (resume !== undefined) return refuse("--continue and --resume do not go together");
    return {
      ok: true,
      ask: { ...runsAs, continue: opts.print === true ? "print" : "interactive" },
    };
  }
  if (opts.continue !== undefined) return refuse("--continue takes no value");
  if (opts.print !== undefined) return refuse("--print goes with --continue");
  if (resume === undefined) return refuse("--continue or --resume <session-id> is needed");
  if (typeof resume !== "string" || !isSessionIdShape(resume)) {
    return refuse("--resume takes a session id (a lowercase uuid)");
  }
  return { ok: true, ask: { ...runsAs, resume } };
}

/** `ccmsg launch-context`: prints the launch context of the ask as one JSON
 * line and exits 0, or the reason the options do not read and exits 1. */
export async function runLaunchContext(
  positionals: readonly string[],
  opts: Readonly<Record<string, string | boolean>>,
): Promise<void> {
  if (opts.help === true) {
    process.stdout.write(LAUNCH_CONTEXT_HELP);
    return;
  }
  const read = readLaunchContextAsk(positionals, opts);
  if (!read.ok) {
    process.stderr.write(`ccmsg: ${read.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const context = await launchContext(
    read.ask,
    { configDir: claudeConfigDir(process.env, os.homedir()), cwd: process.cwd() },
    { warn: (msg) => process.stderr.write(`ccmsg: ${msg}\n`) },
  );
  process.stdout.write(`${JSON.stringify({ ok: true, ...context })}\n`);
}
