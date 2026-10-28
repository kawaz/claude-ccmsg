// The daemon's voice (DR-0045 §6): what a session's `say` tool call and a
// request for permission speak. The speeches go one after another, so two
// sessions speaking at once are not heard over each other. Each reads the
// reading dictionary afresh (`<configDir>/say-dictionary.tsv` over the shipped
// one), so an edit is in effect from the next speech.
import * as fs from "node:fs";
import { applySayDictionary, userSayDictionary } from "@ccmsg/protocol";

/** The speech binary when the daemon's environment names none
 * (`CCMSG_SAY_BIN`). */
export const SYSTEM_SAY = "/usr/bin/say";

/** How long one speech may run before it is killed and the next goes: a long
 * text takes as long as it is to say, and a binary that never ends must not
 * keep every later speech waiting. */
export const SPEECH_TIMEOUT_MS = 120_000;

export interface SpeechLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface Speaker {
  /** Speak `text` after the speeches before it. Never rejects; a failure is
   * written to the log. */
  speak(text: string): void;
  /** Resolves once every speech asked for so far has ended (tests). */
  idle(): Promise<void>;
}

/** The user's dictionary file, or undefined when there is none. A file that
 * cannot be read is said in the log and not used. */
async function readDictionaryFile(file: string, log: SpeechLog): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      log.warn(`say: ${file}: ${e instanceof Error ? e.message : "unreadable"} — not used`);
    }
    return undefined;
  }
}

/** `text` as it is spoken: the dictionary's readings put in place of its
 * words, each line of the file that did not read said in the log. */
async function spokenText(text: string, dictionaryFile: string, log: SpeechLog): Promise<string> {
  const { dictionary, problems } = userSayDictionary(await readDictionaryFile(dictionaryFile, log));
  for (const p of problems) {
    log.warn(`say: ${dictionaryFile}:${String(p.line)}: ${p.reason} — line skipped`);
  }
  return applySayDictionary(dictionary, text);
}

/** One speech: `[bin, "--", text]`. The `--` keeps a text that starts with
 * `-` from being read as say's option (measured: `say -o f "-v x"` speaks
 * nothing and exits 0). */
async function speakOnce(
  bin: string,
  text: string,
  dictionaryFile: string,
  log: SpeechLog,
): Promise<void> {
  const spoken = await spokenText(text, dictionaryFile, log);
  let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    proc = Bun.spawn([bin, "--", spoken], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: SPEECH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    log.warn(`say: could not start ${bin}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const [code, errText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    log.warn(`say: ${bin} exited ${String(code)}: ${errText.trim().split("\n")[0] ?? ""}`);
  }
}

export function createSpeaker(options: {
  /** The speech binary (`CCMSG_SAY_BIN` or SYSTEM_SAY). */
  bin: string;
  /** `<configDir>/say-dictionary.tsv`. */
  dictionaryFile: string;
  log: SpeechLog;
}): Speaker {
  let tail: Promise<void> = Promise.resolve();
  return {
    speak(text) {
      tail = tail.then(() =>
        speakOnce(options.bin, text, options.dictionaryFile, options.log).catch((e: unknown) => {
          options.log.warn(`say: speech failed: ${e instanceof Error ? e.message : String(e)}`);
        }),
      );
    },
    idle: () => tail,
  };
}
