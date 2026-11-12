// A say command for a test's daemon (config `say_command`,
// docs/design/say-command.md) that makes no sound: it appends the speech's
// JSON it reads on standard input to a file, one line per speech, and the
// test reads the speeches back from there.
import * as fs from "node:fs";
import { parseWith, SayCommandInputTextSchema, type SayCommandInput } from "@ccmsg/protocol";

/** The script of a say command that appends its input to `file` as one line
 * and exits `exit`. */
export function sayRecorderScript(file: string, exit = 0): string {
  const to = JSON.stringify(file);
  return `#!/bin/sh\ncat >> ${to}\nprintf '\\n' >> ${to}\nexit ${String(exit)}\n`;
}

/** The speeches a say recorder appended to `file`, in order (none when it
 * never ran). A line that is not a speech fails the test. */
export function recordedSpeeches(file: string): SayCommandInput[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const read = parseWith(SayCommandInputTextSchema, line);
      if (!read.ok) throw new Error(`not a speech: ${line}: ${read.failure.summary}`);
      return read.value;
    });
}
