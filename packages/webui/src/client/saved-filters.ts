// The words a person keeps for a filter box (DR-0043 §9, kawaz 2026-11-24),
// each list in the order the words were saved. The SESSIONS quick filter has
// one list. The Files pane's name search has one per project: the session's
// repository (`host/owner/name`, so the workspaces and sessions of one
// repository share it), else its cwd; a session with neither has none (and its
// box no save). Content in storage.ts's table (localStorage): a word kept in
// one window is there in the next and after a reload.
//
// The page holds each list once, for every box that shows it (the Files
// pane's box is in each kept session view at once), and the boxes hear a
// change through `subscribeSavedFilters`. A save or a removal starts from
// what is stored rather than what this page holds, so it does not drop a word
// another window kept since this page read the list; a word another window
// kept shows here at this page's next save or removal, or after a reload (as
// the SESSIONS list's folds do).
import * as v from "valibot";
import { jsonText, parseWith, type SessionRepository } from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";

/** The SESSIONS quick filter's list: an array of words. */
export const SESSION_SAVED_FILTERS_KEY = "ccmsg.sessionList.savedFilters";

/** The Files pane's name search's lists: an object from a project's key
 * (`repo:<host>/<owner>/<name>` or `cwd:<cwd>`) to its array of words. One
 * value for every project, so the keys do not grow with the projects. A
 * project's list is never swept: the person takes words off with their ×. */
export const FILE_SAVED_FILTERS_KEY = "ccmsg.fileSearch.savedFilters";

/** Which list: the SESSIONS one, or the Files one of a project. */
export type SavedFiltersId = "sessions" | `files:${string}`;

export const SESSION_SAVED_FILTERS: SavedFiltersId = "sessions";

/** The Files list of a session that works on `repository` (the peer row's),
 * else in `cwd` (resolveSessionTopbar's); null when neither is known. */
export function fileSavedFiltersId(
  repository: SessionRepository | undefined,
  cwd: string | null,
): SavedFiltersId | null {
  if (repository !== undefined) {
    return `files:repo:${repository.host}/${repository.owner}/${repository.name}`;
  }
  return cwd === null || cwd === "" ? null : `files:cwd:${cwd}`;
}

/** The word `text` saves as: the text without the blanks at its ends. The
 * words a filter matches by are what is between its blanks, so those at the
 * ends say nothing. */
export function savedFilterWord(text: string): string {
  return text.trim();
}

/** How many characters of a kept word its pill shows (kawaz 2026-11-24). */
export const SAVED_FILTER_LABEL_LENGTH = 5;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A kept word as its pill shows it: the word when it has at most
 * SAVED_FILTER_LABEL_LENGTH characters (graphemes: what reads as one
 * character), else its first ones and `…`. */
export function savedFilterLabel(word: string): string {
  let head = "";
  let count = 0;
  for (const { segment } of graphemes.segment(word)) {
    if (count === SAVED_FILTER_LABEL_LENGTH) return `${head}…`;
    head += segment;
    count += 1;
  }
  return word;
}

/** `words` with each word once, at its first place, and none empty. */
function distinctWords(words: string[]): string[] {
  return [...new Set(words.map(savedFilterWord))].filter((word) => word !== "");
}

const WordsSchema = v.pipe(v.array(v.string()), v.transform(distinctWords));
const SessionWordsTextSchema = jsonText(WordsSchema);
const FileWordsTextSchema = jsonText(v.record(v.string(), WordsSchema));

const lists = new Map<SavedFiltersId, readonly string[]>();
const listeners = new Map<SavedFiltersId, Set<() => void>>();

/** Every project's Files list as stored. A value that is not such an object
 * reads as none. */
function storedFileLists(): Record<string, readonly string[]> {
  const raw = readStorage(FILE_SAVED_FILTERS_KEY);
  const read = raw === null ? null : parseWith(FileWordsTextSchema, raw);
  return read?.ok ? { ...read.value } : {};
}

/** `id`'s list as stored. A value that does not read as words is none. */
function storedList(id: SavedFiltersId): readonly string[] {
  if (id === "sessions") {
    const raw = readStorage(SESSION_SAVED_FILTERS_KEY);
    const read = raw === null ? null : parseWith(SessionWordsTextSchema, raw);
    return read?.ok ? read.value : [];
  }
  return storedFileLists()[id.slice("files:".length)] ?? [];
}

function keep(id: SavedFiltersId, list: readonly string[]): void {
  if (id === "sessions") {
    writeStorage(SESSION_SAVED_FILTERS_KEY, JSON.stringify(list));
  } else {
    const all = storedFileLists();
    const project = id.slice("files:".length);
    if (list.length === 0) delete all[project];
    else all[project] = list;
    writeStorage(FILE_SAVED_FILTERS_KEY, JSON.stringify(all));
  }
  lists.set(id, list);
  for (const listener of listeners.get(id) ?? []) listener();
}

/** The words of `id` (useSyncExternalStore's snapshot: the same array until
 * the list changes). */
export function savedFilters(id: SavedFiltersId): readonly string[] {
  const held = lists.get(id);
  if (held !== undefined) return held;
  const list = storedList(id);
  lists.set(id, list);
  return list;
}

/** Hear when the words of `id` change (useSyncExternalStore's subscribe). */
export function subscribeSavedFilters(id: SavedFiltersId, listener: () => void): () => void {
  const set = listeners.get(id) ?? new Set();
  listeners.set(id, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Whether `text` would add a word to `words`: it has one, not saved yet. */
export function canSaveFilter(words: readonly string[], text: string): boolean {
  const word = savedFilterWord(text);
  return word !== "" && !words.includes(word);
}

/** Add the word of `text` to the end of `id`'s list, unless it is empty or
 * there already. */
export function saveFilter(id: SavedFiltersId, text: string): void {
  const word = savedFilterWord(text);
  if (word === "") return;
  const stored = storedList(id);
  keep(id, stored.includes(word) ? stored : [...stored, word]);
}

/** Take `word` out of `id`'s list. */
export function removeSavedFilter(id: SavedFiltersId, word: string): void {
  keep(
    id,
    storedList(id).filter((kept) => kept !== word),
  );
}

/** Test only: forget the lists the page holds (what is stored stays), as a
 * reload does. */
export function _resetSavedFiltersForTest(): void {
  lists.clear();
}
