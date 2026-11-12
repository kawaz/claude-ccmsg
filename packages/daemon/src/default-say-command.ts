// The say command the daemon runs when the config names none
// (docs/design/say-command.md): it reads the speech's JSON on standard input
// and speaks its `spoken` through macOS's say. The daemon starts it with the
// bun it runs on, so it needs nothing the daemon does not.
import * as fs from "node:fs";
import { parseWith } from "@ccmsg/protocol/parse";
import { SayCommandInputTextSchema } from "@ccmsg/protocol/say-command";

/** macOS's speech program. */
export const SYSTEM_SAY = "/usr/bin/say";

/** Whether `file` is a file this process may execute. */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Speak the speech `stdin` holds through `sayBin` (`[sayBin, "--",
 * spoken]`) and answer the exit code to end with. The `--` keeps a text that
 * starts with `-` from being read as say's option (measured: `say -o f "-v x"`
 * speaks nothing and exits 0). An input that does not read, or a `sayBin`
 * that is not there, is said on stderr and ends non-zero without speaking. */
export async function runDefaultSayCommand(stdin: string, sayBin: string): Promise<number> {
  const input = parseWith(SayCommandInputTextSchema, stdin);
  if (!input.ok) {
    console.error(`say command: the input does not read: ${input.failure.summary}`);
    return 2;
  }
  if (!isExecutable(sayBin)) {
    console.error(`say command: ${sayBin} is not there to speak with (it is macOS's say)`);
    return 1;
  }
  const proc = Bun.spawn([sayBin, "--", input.value.spoken], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

if (import.meta.main) {
  process.exit(await runDefaultSayCommand(await Bun.stdin.text(), SYSTEM_SAY));
}
