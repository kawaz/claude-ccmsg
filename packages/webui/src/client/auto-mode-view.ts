// What the Status tab's autoMode shows of one section (DR-0063 §1, §6): the
// state of the user's list, whether the built-in defaults hold, and the
// sentence that says why, from the project's section and the user's list.
import {
  AUTO_MODE_DEFAULTS_ENTRY,
  type AutoModeSection,
  type AutoModeSectionName,
  type UserAutoMode,
} from "@ccmsg/protocol";

/** The user's list of a section as the rule of DR-0063 §1 reads it. */
export type UserListState =
  | { kind: "unreadable" }
  /** Not written, or written empty (the same, measured). */
  | { kind: "unwritten" }
  | { kind: "with-defaults" }
  | { kind: "without-defaults"; count: number };

export function userListState(user: UserAutoMode, name: AutoModeSectionName): UserListState {
  if ("unavailable" in user) return { kind: "unreadable" };
  const list = user.autoMode[name] ?? [];
  if (list.length === 0) return { kind: "unwritten" };
  if (list.includes(AUTO_MODE_DEFAULTS_ENTRY)) return { kind: "with-defaults" };
  return { kind: "without-defaults", count: list.length };
}

/** The user's side on the `$defaults` row. */
export function userStateText(state: UserListState): string {
  switch (state.kind) {
    case "unreadable":
      return "ユーザ: 読めない";
    case "unwritten":
      return "ユーザ: 書いていない";
    case "with-defaults":
      return "ユーザ: $defaults あり";
    case "without-defaults":
      return `ユーザ: $defaults なし (${String(state.count)} 件)`;
  }
}

/** Whether the built-in defaults of the section hold (DR-0063 §1): a layer
 * with entries puts `$defaults` in, or no layer writes the list. Undefined
 * when the user's list is not known and the project's alone does not decide
 * it. */
export function builtinApplies(project: AutoModeSection, user: UserListState): boolean | undefined {
  const p = project.entries.length > 0;
  if (p && project.defaults) return true;
  if (user.kind === "unreadable") return undefined;
  if (user.kind === "with-defaults") return true;
  return !p && user.kind === "unwritten";
}

/** The sentence of the section's result on the `$defaults` row (DR-0063
 * §6). */
export function resultText(project: AutoModeSection, user: UserListState): string {
  const p = project.entries.length > 0;
  if (user.kind === "with-defaults") {
    return "ユーザの設定に $defaults があるので組み込みは効いています";
  }
  // The project's own $defaults decides it whatever the user writes, so a
  // user's settings that do not read leave it known (as builtinApplies).
  if (p && project.defaults) return "プロジェクトの $defaults で組み込みが効いています";
  if (user.kind === "unreadable") return "ユーザの設定が読めないので結果は分かりません";
  if (!p && user.kind === "unwritten") {
    const told = "どの設定もこのセクションを書いていないので組み込みが効いています";
    return project.defaults ? told : `${told}。項目が無いのでチェックを外しても変わりません`;
  }
  if (!p) {
    const told =
      "ユーザの設定が $defaults なしで書いているので組み込みは効いていません (ユーザの項目だけ)";
    return project.defaults ? `${told}。チェックはプロジェクトに項目がある時に効きます` : told;
  }
  return "組み込みは効いていません";
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
