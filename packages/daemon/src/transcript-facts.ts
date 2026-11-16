// What a session's transcript says of the session as of its last line, read once, whole, when the daemon first knows the session and where its transcript is (DR-0053): when it last did something, when a person last put something into it, and the model and effort its main thread last ran at. These are the values the Sessions list shows for every row, and a daemon that has just started, or a session without a hooks module, has no other source for them.
//
// The read is the same quantity the live sources hold, taken from the same rows: the user-input judgment is session-user-input.ts' (the live fold's), and the model and effort are read as session-search.ts reads a session's launch context. Nothing here decides what a row means on its own.
import { errorText, parseWith, TranscriptRowTimestampLineSchema } from "@ccmsg/protocol";
import { launchContextFromRow } from "./session-search.ts";
import { userInputAtOfLine } from "./session-user-input.ts";
import { scanTranscriptLines } from "./transcript.ts";

/** What one whole read of a transcript found. A value the transcript has no row for is absent. */
export interface TranscriptFacts {
  /** The latest `timestamp` of the rows that carry one. The metadata rows Claude Code keeps appending (titles, modes, the last prompt, cost state) carry none, so the file's last line is often not the last activity. */
  lastActivityAt?: string;
  /** The latest timestamp of a row the live fold counts as a person's input (classifyUserInputRow). */
  lastUserInputAt?: string;
  /** The model and the effort of the file's last assistant row of the main thread that is not Claude Code's own (`<synthetic>`). Taken as a pair from that one row: a row written before Claude Code recorded the effort names the model only. */
  engine?: { model: string; effort?: string };
}

export type TranscriptFactsRead =
  | {
      kind: "read";
      facts: TranscriptFacts;
      /** Lines that did not read as a row (not JSON, or a `timestamp` that is not a string). They are skipped; the values come from the rest. */
      unreadableLines: number;
    }
  /** There is no file at the path: a session nothing has been typed into yet, whose transcript Claude Code has not created. It may be there later. */
  | { kind: "missing" }
  /** The file is there and could not be read (no permission, not a file). */
  | { kind: "failed"; reason: string };

/** Read `file` whole and take its facts. Never rejects: a file that is not there answers `missing`, one that cannot be read `failed` with why. A line still being written (no newline yet) is not read. */
export async function readTranscriptFacts(file: string): Promise<TranscriptFactsRead> {
  const facts: TranscriptFacts = {};
  let unreadableLines = 0;
  try {
    await scanTranscriptLines(file, undefined, (line) => {
      if (line.trim() === "") return;
      const head = parseWith(TranscriptRowTimestampLineSchema, line);
      if (!head.ok) {
        unreadableLines++;
        return;
      }
      const at = head.value.timestamp;
      if (at !== undefined && isLater(at, facts.lastActivityAt)) facts.lastActivityAt = at;
      // Every line goes through the row's own parse: a substring test on `"assistant"` would miss a row written with spaces in its JSON, and one read of each session's file is not worth that risk.
      const engine = launchContextFromRow(line);
      if (engine?.model !== undefined) {
        facts.engine = {
          model: engine.model,
          ...(engine.effort !== undefined ? { effort: engine.effort } : {}),
        };
      }
      const input = userInputAtOfLine(line);
      // Compared as the live fold compares them (session-user-input.ts foldLine), so the two take the same row as the latest.
      if (
        input !== undefined &&
        (facts.lastUserInputAt === undefined || input > facts.lastUserInputAt)
      ) {
        facts.lastUserInputAt = input;
      }
    });
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return { kind: "missing" };
    return { kind: "failed", reason: errorText(e) };
  }
  return { kind: "read", facts, unreadableLines };
}

/** Whether ISO time `at` is later than `than` (or `than` is absent). A time that does not read as one is never later. */
export function isLater(at: string, than: string | undefined): boolean {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return false;
  if (than === undefined) return true;
  const thanMs = Date.parse(than);
  return Number.isNaN(thanMs) || ms > thanMs;
}
