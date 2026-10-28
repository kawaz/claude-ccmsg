// The reading dictionary (DR-0045 §6): the readings the daemon puts in place
// of words just before it speaks, the ones shipped here with
// `<configDir>/say-dictionary.tsv` laid over them, edited by hand (a person
// or an agent). A line is `word<TAB>reading`; a line starting with `#` is
// a comment and an empty line is nothing. A line that is neither and does not
// read as an entry is reported and skipped, the rest of the file still in use.
//
// Everything here is pure (text in, text out): reading the file and the
// speech binary live in the daemon.
import * as v from "valibot";
import { parseWith } from "./parse.ts";

/** A word looked up in the text: no white space, so it is one token of the
 * line and of the text spoken. */
const SayWordSchema = v.pipe(
  v.string(),
  v.regex(/^\S+$/u, "the word must be non-empty with no white space"),
);

/** What the word is spoken as: anything but a tab or a line break, with
 * something other than white space in it. */
const SayReadingSchema = v.pipe(
  v.string(),
  v.regex(/^[^\t\r\n]*\S[^\t\r\n]*$/u, "the reading must not be blank"),
);

/** One entry line, split at its tabs: exactly the word and the reading. The
 * count is looked at first, so a line without its tab, or with one too many,
 * says just that. */
const SayDictionaryEntryFieldsSchema = v.pipe(
  v.array(v.string()),
  v.length(2, "an entry is `word<TAB>reading`, one tab between them"),
  v.strictTuple([SayWordSchema, SayReadingSchema]),
);

export interface SayDictionaryEntry {
  readonly word: string;
  readonly reading: string;
}

/** One line of the file: an entry, a comment or empty line, or a line that
 * does not read and why. */
export type SayDictionaryLine =
  | { readonly kind: "entry"; readonly entry: SayDictionaryEntry }
  | { readonly kind: "other" }
  | { readonly kind: "invalid"; readonly reason: string };

/** A line that did not read, by its 1-based line number. */
export interface SayDictionaryProblem {
  readonly line: number;
  readonly reason: string;
}

/** The file's text as lines. A trailing line break ends the last line rather
 * than starting an empty one; a `\r` before a line break is part of the
 * break. */
export function readSayDictionaryLines(text: string): readonly SayDictionaryLine[] {
  const raw = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (raw.at(-1) === "") raw.pop();
  return raw.map(readSayDictionaryLine);
}

function readSayDictionaryLine(text: string): SayDictionaryLine {
  if (text.trim() === "" || text.startsWith("#")) return { kind: "other" };
  const read = parseWith(SayDictionaryEntryFieldsSchema, text.split("\t"), { firstIssue: true });
  if (!read.ok) return { kind: "invalid", reason: read.failure.summary };
  const [word, reading] = read.value;
  return { kind: "entry", entry: { word, reading } };
}

export function sayDictionaryEntries(
  lines: readonly SayDictionaryLine[],
): readonly SayDictionaryEntry[] {
  return lines.flatMap((l) => (l.kind === "entry" ? [l.entry] : []));
}

export function sayDictionaryProblems(
  lines: readonly SayDictionaryLine[],
): readonly SayDictionaryProblem[] {
  return lines.flatMap((l, i) => (l.kind === "invalid" ? [{ line: i + 1, reason: l.reason }] : []));
}

/** The readings shipped with ccmsg, under the user's file: a word there wins
 * over the same word here. */
export const BUILTIN_SAY_DICTIONARY: readonly SayDictionaryEntry[] = [
  { word: "1Password", reading: "ワンパスワード" },
  { word: "daemon", reading: "デーモン" },
  { word: "sidecar", reading: "サイドカー" },
  { word: "plugin", reading: "プラグイン" },
  { word: "OTP", reading: "オーティーピー" },
  { word: "URL", reading: "ユーアールエル" },
  { word: "API", reading: "エーピーアイ" },
  { word: "CI", reading: "シーアイ" },
  { word: "PR", reading: "ピーアール" },
  { word: "jj", reading: "ジェイジェイ" },
  { word: "Kyell", reading: "ケイエール" },
];

/** The dictionary to speak with: the shipped entries, then those of the
 * user's file (`fileText`, undefined when there is none), with the lines of
 * the file that did not read. */
export function userSayDictionary(fileText: string | undefined): {
  dictionary: SayDictionary;
  problems: readonly SayDictionaryProblem[];
} {
  const lines = fileText === undefined ? [] : readSayDictionaryLines(fileText);
  return {
    dictionary: compileSayDictionary([...BUILTIN_SAY_DICTIONARY, ...sayDictionaryEntries(lines)]),
    problems: sayDictionaryProblems(lines),
  };
}

/** The entries made into one lookup. */
export interface SayDictionary {
  /** null when there are no entries: nothing to look for. */
  readonly pattern: RegExp | null;
  /** Each word in lower case, to its reading. */
  readonly readings: ReadonlyMap<string, string>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/** The entries as one lookup. A later entry for a word wins over an earlier
 * one. A word is found only where neither side touches a letter or a digit
 * (an underscore, a space, Japanese text or the end of the text all do not),
 * so `daemon` is found in `_daemon_` and `の daemon で` but not in
 * `daemonize`. Where several words start at one place, the longest is
 * found. */
export function compileSayDictionary(entries: readonly SayDictionaryEntry[]): SayDictionary {
  const readings = new Map<string, string>();
  for (const e of entries) readings.set(e.word.toLowerCase(), e.reading);
  if (readings.size === 0) return { pattern: null, readings };
  const words = [...readings.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])(?:${words.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`,
    "giu",
  );
  return { pattern, readings };
}

/** `text` with every word of the dictionary in it put as its reading. A word
 * the dictionary does not hold stays as it is. */
export function applySayDictionary(dict: SayDictionary, text: string): string {
  if (dict.pattern === null) return text;
  return text.replace(dict.pattern, (found) => dict.readings.get(found.toLowerCase()) ?? found);
}
