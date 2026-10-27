// The reading dictionary on the CLI side (DR-0042): the dictionary shipped
// beside this file with `<configDir>/say-dictionary.tsv` laid over it, and
// finding which of `say`'s arguments are the text to speak. The lines and the
// replacement themselves are protocol's say-dictionary.ts.
//
// The CLI reads the file afresh on every speech: each `ccmsg say` is its own
// short process, so an edit is in effect from the next speech with nothing to
// watch or reload.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compileSayDictionary,
  readSayDictionaryLines,
  sayDictionaryEntries,
  sayDictionaryProblems,
  type SayDictionary,
  type SayDictionaryEntry,
} from "@ccmsg/protocol";

/** The dictionary shipped with ccmsg, under the user's file. */
export const BUILTIN_SAY_DICTIONARY = fileURLToPath(
  new URL("./say-dictionary.default.tsv", import.meta.url),
);

/** The entries of `file`, each line that does not read said through `warn`
 * and skipped. A file that does not exist has no entries; one that cannot be
 * read at all is said through `warn` and has none either. */
function readEntries(file: string, warn: (msg: string) => void): readonly SayDictionaryEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      warn(`${file}: ${e instanceof Error ? e.message : "unreadable"} — not used`);
    }
    return [];
  }
  const lines = readSayDictionaryLines(text);
  for (const p of sayDictionaryProblems(lines)) {
    warn(`${file}:${String(p.line)}: ${p.reason} — line skipped`);
  }
  return sayDictionaryEntries(lines);
}

/** The dictionary to speak with: the shipped entries, then `file`'s, so a
 * word in `file` wins over the same word shipped (a later entry wins). */
export function loadSayDictionary(file: string, warn: (msg: string) => void): SayDictionary {
  return compileSayDictionary([
    ...readEntries(BUILTIN_SAY_DICTIONARY, warn),
    ...readEntries(file, warn),
  ]);
}

/** `say`'s options that take a value, as the separate next argument when
 * not written `--name=value` (or `-vValue`). From say(1). */
const SAY_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-v",
  "--voice",
  "-r",
  "--rate",
  "-o",
  "--output-file",
  "-f",
  "--input-file",
  "-n",
  "--network-send",
  "-a",
  "--audio-device",
  "--file-format",
  "--data-format",
  "--channels",
  "--bit-rate",
  "--quality",
]);

/** How `say` will get its text from `args`. */
export interface SpeechText {
  /** The indexes in `args` of the words of the text to speak. */
  readonly words: readonly number[];
  /** No text in the arguments and no input file: say reads standard
   * input. */
  readonly fromStdin: boolean;
}

/** Which of `args` are the text `say` speaks, read with say(1)'s options:
 * the value of an option is not text, an argument after `--` is, and an
 * argument starting with `-` that is not a known option is passed on as the
 * option it looks like. With no text and no `-f`, say reads standard input. */
export function speechTextOf(args: readonly string[]): SpeechText {
  const words: number[] = [];
  let inputFile = false;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!options || arg === "-" || !arg.startsWith("-")) {
      words.push(i);
      continue;
    }
    if (arg === "--") {
      options = false;
      continue;
    }
    if (arg === "-f" || arg === "--input-file" || arg.startsWith("--input-file=")) inputFile = true;
    if (arg.startsWith("-f") && arg.length > 2) inputFile = true;
    if (SAY_VALUE_OPTIONS.has(arg)) i++;
  }
  return { words, fromStdin: words.length === 0 && !inputFile };
}
