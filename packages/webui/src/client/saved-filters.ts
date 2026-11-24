// The words a person keeps for a filter box (DR-0043 §9, kawaz 2026-11-24):
// the SESSIONS quick filter and the Files pane's name search
// each keep one list, in the order the words were saved. Content in
// storage.ts's table (localStorage): a word kept in one window is there in
// the next and after a reload.
//
// The page holds each list once, for every box that shows it (the Files
// pane's box is in each kept session view at once), and the boxes hear a
// change through `subscribeSavedFilters`. A save or a removal starts from
// what is stored rather than what this page holds, so it does not drop a word
// another window kept since this page read the list; a word another window
// kept shows here at this page's next save or removal, or after a reload (as
// the SESSIONS list's folds do).
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";

/** The SESSIONS quick filter's list. */
export const SESSION_SAVED_FILTERS_KEY = "ccmsg.sessionList.savedFilters";

/** The Files pane's name search's list: one for every session. */
export const FILE_SAVED_FILTERS_KEY = "ccmsg.fileSearch.savedFilters";

export type SavedFiltersKey = typeof SESSION_SAVED_FILTERS_KEY | typeof FILE_SAVED_FILTERS_KEY;

/** The word `text` saves as: the text without the blanks at its ends. The
 * words a filter matches by are what is between its blanks, so those at the
 * ends say nothing. */
export function savedFilterWord(text: string): string {
  return text.trim();
}

/** `words` with each word once, at its first place, and none empty. */
function distinctWords(words: string[]): string[] {
  return [...new Set(words.map(savedFilterWord))].filter((word) => word !== "");
}

const SavedFiltersTextSchema = jsonText(v.pipe(v.array(v.string()), v.transform(distinctWords)));

const lists = new Map<SavedFiltersKey, readonly string[]>();
const listeners = new Map<SavedFiltersKey, Set<() => void>>();

/** The list as stored. A value that is not a list of words reads as none. */
function storedList(key: SavedFiltersKey): readonly string[] {
  const raw = readStorage(key);
  const read = raw === null ? null : parseWith(SavedFiltersTextSchema, raw);
  return read?.ok ? read.value : [];
}

function keep(key: SavedFiltersKey, list: readonly string[]): void {
  writeStorage(key, JSON.stringify(list));
  lists.set(key, list);
  for (const listener of listeners.get(key) ?? []) listener();
}

/** The words of `key` (useSyncExternalStore's snapshot: the same array until
 * the list changes). */
export function savedFilters(key: SavedFiltersKey): readonly string[] {
  const held = lists.get(key);
  if (held !== undefined) return held;
  const list = storedList(key);
  lists.set(key, list);
  return list;
}

/** Hear when the words of `key` change (useSyncExternalStore's subscribe). */
export function subscribeSavedFilters(key: SavedFiltersKey, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
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

/** Add the word of `text` to the end of `key`'s list, unless it is empty or
 * there already. */
export function saveFilter(key: SavedFiltersKey, text: string): void {
  const word = savedFilterWord(text);
  if (word === "") return;
  const stored = storedList(key);
  keep(key, stored.includes(word) ? stored : [...stored, word]);
}

/** Take `word` out of `key`'s list. */
export function removeSavedFilter(key: SavedFiltersKey, word: string): void {
  keep(
    key,
    storedList(key).filter((kept) => kept !== word),
  );
}

/** Test only: forget the lists the page holds (what is stored stays), as a
 * reload does. */
export function _resetSavedFiltersForTest(): void {
  lists.clear();
}
