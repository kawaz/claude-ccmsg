// `ccmsg secret take <id>`: the value the person handed to a session from the
// webui, written to standard output for the next command of a pipe
// (DR-0052 §6). The one command an agent calls on its own (DR-0039 §4's
// exception, DR-0052 §10): a value a tool returned would be in the
// conversation.
import { errorText, resolvePaths } from "@ccmsg/protocol";
import { connectIfRunning, helloRequest } from "./client.ts";

export const SECRET_HELP = `ccmsg secret — the secret values the person hands to this host's sessions
from the webui's Status tab. The daemon holds each in memory for 5 minutes
under an id, and tells the session the id.

Usage:
  ccmsg secret take <id>       Write the value held under <id> to standard
                               output, as it was pasted (no newline added or
                               removed). Pipe it into the command that uses it:
                                 ccmsg secret take <id> | <command>
                               It can be taken again until it expires. Exits 1,
                               writing nothing to standard output and the
                               reason to standard error, when nothing is held
                               under <id> (expired, never issued) or
                               the daemon is not running

Options:
  -h, --help                   Show this help
`;

const TAKE_USAGE = "ccmsg secret take <id>";

/** Say why nothing was written and exit 1. */
function refuse(why: string): never {
  process.stderr.write(`ccmsg secret take: ${why}\n`);
  process.exit(1);
}

/** `ccmsg secret <args>`. */
export async function runSecretCommand(args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help")) {
    process.stdout.write(SECRET_HELP);
    return;
  }
  if (sub !== "take") {
    process.stderr.write(`ccmsg secret: unknown subcommand '${sub}'\n\n${SECRET_HELP}`);
    process.exit(1);
  }
  const positionals = rest[0] === "--" ? rest.slice(1) : rest;
  const [id, extra] = positionals;
  if (id === undefined || id === "") refuse(`missing <id>\n  usage: ${TAKE_USAGE}`);
  if (extra !== undefined) refuse(`unexpected argument "${extra}"\n  usage: ${TAKE_USAGE}`);
  await take(id);
}

/** Write the value held under `id` to standard output and exit 0.
 *
 * Design rationale: the daemon is not started and not replaced
 * (`connectIfRunning`, not `ensureDaemon`). A secret lives in the running
 * daemon's memory only, so a daemon this command started holds none, and
 * the upgrade a newer CLI does to an older daemon (DR-0002 §4) would drop
 * the very value asked for. The hello is the user role's, whatever session
 * runs this, as `ccmsg agents` does: `secret_take` answers the user role
 * only (DR-0052 §6). */
async function take(id: string): Promise<never> {
  const client = await connectIfRunning(resolvePaths());
  if (client === null) {
    refuse("the ccmsg daemon is not running, so it holds no secret");
  }
  try {
    const hello = await client.request(helloRequest({ role: "user" }));
    if (!hello.ok) refuse(`the daemon refused the hello: ${hello.error.msg}`);
    const res = await client.request({ op: "secret_take", id });
    if (!res.ok) refuse(res.error.msg);
    await Bun.write(Bun.stdout, res.value);
  } catch (e) {
    refuse(errorText(e));
  } finally {
    client.close();
  }
  process.exit(0);
}
