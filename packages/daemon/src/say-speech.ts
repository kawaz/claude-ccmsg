// The daemon's voice (DR-0045 §6): what a session's `say` tool call and a
// request for permission speak. Each speech runs the say command of the
// config (or the built-in one) with the speech as JSON on its standard input
// (docs/design/say-command.md). The speeches go one after another, so two
// sessions speaking at once are not heard over each other. Each reads the
// reading dictionary afresh (`<configDir>/say-dictionary.tsv` over the shipped
// one), so an edit is in effect from the next speech.
import * as fs from "node:fs";
import {
  applySayDictionary,
  userSayDictionary,
  type SayCommandInput,
  type SayCommandKind,
} from "@ccmsg/protocol";
import { defaultSayCommand } from "./config.ts";

/** How long one speech may run before it is killed and the next goes: a long
 * text takes as long as it is to say, and a command that never ends must not
 * keep every later speech waiting. */
export const SPEECH_TIMEOUT_MS = 120_000;

export interface SpeechLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** One speech asked for: what asked, which session, and the text as written. */
export interface Speech {
  kind: SayCommandKind;
  sessionId: string;
  text: string;
}

export interface Speaker {
  /** Speak `speech` after the speeches before it. Never rejects; a failure is
   * written to the log. */
  speak(speech: Speech): void;
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

/** SIGKILL to the say command's process group: the command and the speech
 * program it started. A group that is already gone is nothing to stop. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: every member has exited.
  }
}

/** One speech: the say command with the speech's JSON on its standard input. */
async function speakOnce(
  command: readonly string[],
  speech: Speech,
  dictionaryFile: string,
  log: SpeechLog,
): Promise<void> {
  const input: SayCommandInput = {
    kind: speech.kind,
    session_id: speech.sessionId,
    text: speech.text,
    spoken: await spokenText(speech.text, dictionaryFile, log),
  };
  const name = command[0] ?? "";
  let proc: Bun.Subprocess<Blob, "ignore", "pipe">;
  try {
    proc = Bun.spawn([...command], {
      // Bun writes the whole text and closes the pipe.
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "ignore",
      stderr: "pipe",
      // Its own process group (setsid), so the timeout stops the speech
      // program the command started along with the command.
      detached: true,
    });
  } catch (e) {
    log.warn(`say: could not start ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const timer = setTimeout(() => {
    log.warn(`say: ${name} ran over ${String(SPEECH_TIMEOUT_MS)} ms — killed`);
    killGroup(proc.pid);
  }, SPEECH_TIMEOUT_MS);
  try {
    const [code, errText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      log.warn(`say: ${name} exited ${String(code)}: ${errText.trim().split("\n")[0] ?? ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The say command a daemon runs for each speech: the config's
 * (`sayCommand`), else the built-in one. A daemon a test run started
 * (CCMSG_TEST_LIFELINE in `env`) whose test named no say command speaks
 * nothing (null): the built-in one would speak aloud on the machine running
 * the tests.
 *
 * Design rationale: the silence hangs on the test run's lifeline rather than
 * on a variable of its own, so the say command has one way in (the config)
 * and a test's daemon cannot reach the speaker by leaving a setting out. */
export function sayCommandOf(
  sayCommand: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | null {
  if (sayCommand !== undefined) return sayCommand;
  const lifeline = env.CCMSG_TEST_LIFELINE;
  if (lifeline !== undefined && lifeline !== "") return null;
  return defaultSayCommand();
}

export function createSpeaker(options: {
  /** The say command's argv (config `say_command` or the built-in one), or
   * null for a daemon that speaks nothing (a test's daemon given none). */
  command: readonly string[] | null;
  /** `<configDir>/say-dictionary.tsv`. */
  dictionaryFile: string;
  log: SpeechLog;
}): Speaker {
  let tail: Promise<void> = Promise.resolve();
  const { command } = options;
  return {
    speak(speech) {
      if (command === null) return;
      tail = tail.then(() =>
        speakOnce(command, speech, options.dictionaryFile, options.log).catch((e: unknown) => {
          options.log.warn(`say: speech failed: ${e instanceof Error ? e.message : String(e)}`);
        }),
      );
    },
    idle: () => tail,
  };
}
