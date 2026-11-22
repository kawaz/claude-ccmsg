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
  if (user.kind === "unreadable") return "ユーザの設定が読めないので結果は分かりません";
  if (user.kind === "with-defaults") {
    return "ユーザの設定に $defaults があるので組み込みは効いています";
  }
  if (p && project.defaults) return "プロジェクトの $defaults で組み込みが効いています";
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
