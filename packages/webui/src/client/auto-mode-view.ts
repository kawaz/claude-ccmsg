// What the Status tab's autoMode shows of one section (DR-0063 §1, §6):
// whether the built-in defaults hold, from the project's entries and the
// user's list, and the rows of the project's entries with the edits among
// them.
import type { AutoModeSectionName, UserAutoMode } from "@ccmsg/protocol";

/** Whether the built-in defaults of section `name` hold (DR-0063 §1): the
 * daemon puts `$defaults` first in every section the project has entries in,
 * so they hold then; otherwise unless the user's list is written without
 * `$defaults`. Undefined when the user's settings do not read and the
 * project's entries alone do not decide it. */
export function builtinApplies(
  entries: readonly string[],
  user: UserAutoMode,
  name: AutoModeSectionName,
): boolean | undefined {
  if (entries.length > 0) return true;
  if ("unavailable" in user) return undefined;
  return !user.defaults_dropped.includes(name);
}

/** One of a section's entries being edited: the entry at `index` that read
 * `before` when the edit began, among `count` entries. `conflicted` once a
 * save of it was refused because another page changed it first. */
export interface EntryEdit {
  readonly id: number;
  readonly index: number;
  readonly before: string;
  readonly count: number;
  readonly conflicted: boolean;
}

/** A row of a section's project entries: an entry, or an edit in its place. */
export type EntryRow =
  | { readonly kind: "entry"; readonly index: number; readonly text: string }
  | {
      readonly kind: "edit";
      readonly edit: EntryEdit;
      /** Where it stands in the entries now; undefined when its entry is gone. */
      readonly index: number | undefined;
      /** The entry's text there now, when it is not `before`: another page
       * changed it. */
      readonly changed: string | undefined;
    };

/** The rows of `entries` with `edits` in place (DR-0063 §6): an edit stays
 * with its entry when another page adds, removes or moves entries around
 * it (found by its text); stands at its index over the entry another page
 * changed when there are as many entries as when it began; and goes after
 * the entries otherwise (its entry is taken as gone: a save then appends
 * rather than overwrite an entry it was never opened on), so what is being
 * written is never lost. */
export function entryRows(entries: readonly string[], edits: readonly EntryEdit[]): EntryRow[] {
  const claimed = new Map<number, EntryRow>();
  const gone: EntryRow[] = [];
  const free = (i: number): boolean => i < entries.length && !claimed.has(i);
  for (const edit of edits) {
    const same =
      free(edit.index) && entries[edit.index] === edit.before
        ? edit.index
        : entries.findIndex((text, i) => text === edit.before && free(i));
    if (same >= 0) {
      claimed.set(same, { kind: "edit", edit, index: same, changed: undefined });
    } else if (entries.length === edit.count && free(edit.index)) {
      claimed.set(edit.index, {
        kind: "edit",
        edit,
        index: edit.index,
        changed: entries[edit.index],
      });
    } else {
      gone.push({ kind: "edit", edit, index: undefined, changed: undefined });
    }
  }
  const rows: EntryRow[] = entries.map(
    (text, index) => claimed.get(index) ?? { kind: "entry", index, text },
  );
  return [...rows, ...gone];
}
