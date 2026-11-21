// 許可依頼バブルの「.claude/settings.local.json の修正許可」区画 (DR-0040 §12)
// を Timeline にマウントして、読み手に見えるものと各「許可する」が送るものを
// 固定する。
// - project_permissions のある依頼にだけ区画が出て、本文の最後の「許可する」の
//   前に置かれる。project_permissions だけの依頼には「許可する」が無い
// - 設定ファイルは依頼の行の cwd の .claude/settings.local.json で、既定で閉じた
//   折り畳み。開いた時に daemon から読む (permit_settings_read)。無いファイルは
//   「(無し)」
// - 変更は項目ごとの li に、daemon が書く rule の組 (ev:"permit_state" の
//   rules。まだ無い間はエージェントが書いた rule) の diff の行 (+ は
//   tl-diff-add、- は tl-diff-delete) で並ぶ。symlink の組も 1 つの li で、
//   「許可する」は 1 つ。「許可する」はその項目の位置を permit_permission_apply
//   で送る
// - 適用済みの行はボタンが無効で「適用済み HH:MM」。断られたら理由を出し、
//   ボタンは押せるまま
// - 開いている間に適用が ev:"permit_state" に乗ると、中身を読み直す
// - add の項目の行は「適用」「削除」、remove の項目の行は「削除」「やらない」。
//   「適用」「削除」は項目の位置と change (add / remove) を permit_permission_apply
//   で送り、「やらない」は permit_dismiss で送る
// daemon の代わりに、permit_permission_apply / permit_dismiss を受けたらその
// 項目に run / dismiss の mark を付け、store に ev:"permit_state" と同じ action
// を流す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { parseWith, PermitCallInputSchema } from "@ccmsg/protocol";
import type {
  JsonObject,
  PermitAttachment,
  PermitItemKind,
  PermitItemMark,
  ReplyOf,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { formatSentAt } from "../src/client/components/session-input.ts";
import { useApp } from "../src/client/context.ts";
import { useStoreState } from "../src/client/useStore.ts";
import type { Store } from "../src/client/useStore.ts";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { permitRows } from "./permit-rows.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: null,
    active: true,
    visible: true,
  });
}

const FILE = "/w/.claude/settings.local.json";

const ID = "toolu_p1";

const ASKED: JsonObject = {
  blocked: "`just deploy` が止められた",
  commands: [{ command: "just deploy" }],
  project_permissions: [{ add: "Bash(just deploy)" }, { remove: "Bash(just deploy-old)" }],
};

const APPLIED_AT = "2026-11-08T03:04:05.000Z";

async function openWith(
  input: JsonObject,
  answers: {
    /** What the daemon answers each settings read with, in turn. */
    reads?: PermitAttachment[];
    /** What the daemon answers an apply of the item at `index` with; by
     * default it applies. */
    apply?: (index: number) => ReplyOf<"permit_permission_apply"> | null;
  } = {},
): Promise<{
  root: HTMLElement;
  store: Store;
  reads: string[];
  applies: Array<{ id: string; index: number; change: "add" | "remove" }>;
  dismissals: Array<{ id: string; kind: PermitItemKind; index: number; dismissed: boolean }>;
}> {
  const store = timelineStore({});
  const ws = new FakeTranscriptWs(store);
  const reads: string[] = [];
  const applies: Array<{ id: string; index: number; change: "add" | "remove" }> = [];
  // Whether the item at `index` asks to add a rule (else to remove one).
  const asked = parseWith(PermitCallInputSchema, input);
  const addsAt = (index: number): boolean => {
    const item = asked.ok ? asked.value.project_permissions?.[index] : undefined;
    return item !== undefined && "add" in item;
  };
  const dismissals: Array<{
    id: string;
    kind: PermitItemKind;
    index: number;
    dismissed: boolean;
  }> = [];
  const queued = [...(answers.reads ?? [])];
  const marked = (mark: PermitItemMark): void => {
    const state = store.getState();
    store.dispatch({
      type: "permit-state/loaded",
      unread: state.permitUnread,
      granted: state.permitGranted,
      marks: [...state.permitMarks, mark],
      rules: state.permitRuleSets,
    });
  };
  const handle = {
    ...ws.handle,
    permitSettingsRead: (sid: string, id: string): Promise<ReplyOf<"permit_settings_read">> => {
      reads.push(`${sid} ${id}`);
      const attachment = queued.shift();
      return Promise.resolve(
        attachment !== undefined
          ? { ok: true, attachment }
          : { ok: false, error: { code: "invalid_args", msg: `no permit request with id ${id}` } },
      );
    },
    permitPermissionApply: (
      _sid: string,
      id: string,
      index: number,
      change: "add" | "remove",
    ): Promise<ReplyOf<"permit_permission_apply">> => {
      applies.push({ id, index, change });
      const refused = answers.apply?.(index) ?? null;
      if (refused !== null) return Promise.resolve(refused);
      // An add item taken out is dismissed; anything else is run. The last
      // operation stands.
      const state = store.getState();
      store.dispatch({
        type: "permit-state/loaded",
        unread: state.permitUnread,
        granted: state.permitGranted,
        marks: [
          ...state.permitMarks.filter(
            (m) => !(m.tool_use_id === id && m.kind === "project_permissions" && m.index === index),
          ),
          {
            tool_use_id: id,
            kind: "project_permissions",
            index,
            mark: addsAt(index) && change === "remove" ? "dismiss" : "run",
            at: APPLIED_AT,
          },
        ],
        rules: state.permitRuleSets,
      });
      return Promise.resolve({ ok: true, changed: true, applied_at: APPLIED_AT });
    },
    permitDismiss: (
      _sid: string,
      id: string,
      kind: PermitItemKind,
      index: number,
      dismissed: boolean,
    ): Promise<ReplyOf<"permit_dismiss">> => {
      dismissals.push({ id, kind, index, dismissed });
      if (dismissed) marked({ tool_use_id: id, kind, index, mark: "dismiss", at: APPLIED_AT });
      return Promise.resolve({ ok: true });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page(permitRows(1, ID, input)));
  return { root, store, reads, applies, dismissals };
}

function bubble(root: HTMLElement): HTMLElement {
  return defined(root.querySelector<HTMLElement>(".tl-bubble-permit"), "bubble");
}

function section(root: HTMLElement): HTMLElement {
  return defined(bubble(root).querySelector<HTMLElement>(".permit-settings"), "settings section");
}

function fold(root: HTMLElement): HTMLDetailsElement {
  return instanceOf(
    section(root).querySelector("details.permit-settings-file"),
    HTMLDetailsElement,
    "settings fold",
  );
}

/** Each item row's buttons: their words and whether they are disabled. */
function rowButtons(root: HTMLElement): [string, boolean][][] {
  return [...section(root).querySelectorAll(".permit-settings-change")].map((li) =>
    [...li.querySelectorAll<HTMLButtonElement>("button")].map((b): [string, boolean] => [
      b.textContent ?? "",
      b.disabled,
    ]),
  );
}

function applyButtons(root: HTMLElement): HTMLButtonElement[] {
  return [...section(root).querySelectorAll<HTMLButtonElement>("button.permit-settings-apply")];
}

/** Let replies and the effects they cause settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function setOpen(details: HTMLDetailsElement, open: boolean): Promise<void> {
  await act(async () => {
    const toggled = new Promise((resolve) =>
      details.addEventListener("toggle", resolve, { once: true }),
    );
    details.open = open;
    await toggled;
  });
  await settle();
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
}

describe("the project settings section of a permission request", () => {
  // 何を保証するか: 区画は「許可してほしいこと」の後、本文の最後の「許可する」
  // の前に出る。見出しはファイル名、ファイルはパスだけの閉じた折り畳み、変更は
  // 1 件ずつ diff の色の行。何も読まない。
  test("shows the file folded, and each change as a diff line, before 許可する", async () => {
    const { root, reads } = await openWith(ASKED);
    const shown = bubble(root);
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      "許可してほしいこと",
      ".claude/settings.local.json の修正許可",
    ]);
    expect(
      shown.querySelector(".tl-bubble-body > :last-child > button.permit-grant"),
    ).not.toBeNull();
    expect(fold(root).open).toBe(false);
    expect(fold(root).querySelector("summary")?.textContent).toBe(FILE);
    const lines = [...section(root).querySelectorAll(".permit-settings-diff .tl-diff-line")];
    expect(lines.map((line) => [line.className, line.textContent])).toEqual([
      ["tl-diff-line tl-diff-add", "+Bash(just deploy)"],
      ["tl-diff-line tl-diff-delete", "-Bash(just deploy-old)"],
    ]);
    expect(rowButtons(root)).toEqual([
      [
        ["適用", false],
        ["削除", false],
      ],
      [
        ["削除", false],
        ["やらない", false],
      ],
    ]);
    expect(reads).toEqual([]);
  });

  // 何を保証するか: project_permissions だけの依頼 (intents も commands も無い)
  // には「許可してほしいこと」と本文の最後の「許可する」を出さず、区画を
  // 出す (写す操作が無い)。本文の最後の行には「既読」だけが残る (どの rule も
  // 足さずに依頼を既読にできる)。
  test("a request of project permissions alone shows the section without 許可する", async () => {
    const { commands: _, ...alone } = ASKED;
    const { root } = await openWith(alone);
    const shown = bubble(root);
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      ".claude/settings.local.json の修正許可",
    ]);
    expect(shown.querySelector("button.permit-grant")).toBeNull();
    const last = defined(shown.querySelector(".tl-bubble-body > :last-child"), "last row");
    expect(last.className).toBe("permit-grant-row");
    expect([...last.querySelectorAll("button")].map((b) => [b.className, b.hidden])).toEqual([
      ["permit-read", false],
    ]);
    expect(rowButtons(root).length).toBe(2);
  });

  // 何を保証するか: project_permissions の無い依頼には区画が出ない。
  test("is not shown for a request with no project permissions", async () => {
    const { project_permissions: _, ...plain } = ASKED;
    const { root } = await openWith(plain);
    expect(bubble(root).querySelector(".permit-settings")).toBeNull();
  });

  // 何を保証するか: 開いた時に daemon から読み、無いファイルは「(無し)」、
  // あるファイルは中身をコードブロックで出す。開くたびに読み直す。
  test("reads the file when opened: (無し) when there is none, its content when there is", async () => {
    const { root, reads } = await openWith(ASKED, {
      reads: [
        { path: FILE, read: false, reason: "missing" },
        { path: FILE, read: true, content: '{"model":"x"}\n', bytes: 14, truncated: false },
      ],
    });
    await setOpen(fold(root), true);
    expect(fold(root).querySelector(".permit-attachment-status")?.textContent).toBe("(無し)");
    expect(fold(root).querySelector("pre")).toBeNull();
    await setOpen(fold(root), false);
    await setOpen(fold(root), true);
    // The code block may drop the last newline once the highlighter is loaded.
    expect(fold(root).querySelector("pre")?.textContent?.trimEnd()).toBe('{"model":"x"}');
    expect(reads).toEqual([`${SID} ${ID}`, `${SID} ${ID}`]);
  });

  // 何を保証するか: add の項目の「適用」はその項目の位置を change: "add" で送り、
  // daemon が run を marks に乗せると無効になって「適用済み HH:MM」になる。
  // 「削除」は状態にかかわらず押せ、change: "remove" で送る。daemon が dismiss を
  // 乗せると「適用」は押せるのに戻り、行を薄くする (data-mark)。適用と削除は
  // 最後の操作が勝つ (DR-0040 §12)。
  test("an add item's 適用 and 削除: the last pressed stands, 削除 always pressable", async () => {
    const { root, applies } = await openWith(ASKED);
    const row = (): Element =>
      defined(section(root).querySelector(".permit-settings-change"), "row");
    const button = (cls: string): HTMLButtonElement =>
      instanceOf(row().querySelector(`button.${cls}`), HTMLButtonElement, cls);
    await press(button("permit-settings-apply"));
    expect(rowButtons(root)[0]).toEqual([
      [`適用済み ${formatSentAt(APPLIED_AT)}`, true],
      ["削除", false],
    ]);
    await press(button("permit-settings-delete"));
    expect(rowButtons(root)[0]).toEqual([
      ["適用", false],
      ["削除", false],
    ]);
    expect(row().getAttribute("data-mark")).toBe("dismiss");
    await press(button("permit-settings-delete"));
    await press(button("permit-settings-apply"));
    expect(row().getAttribute("data-mark")).toBe("run");
    expect(applies).toEqual([
      { id: ID, index: 0, change: "add" },
      { id: ID, index: 0, change: "remove" },
      { id: ID, index: 0, change: "remove" },
      { id: ID, index: 0, change: "add" },
    ]);
  });

  // 何を保証するか: remove の項目の行には「削除」と「やらない」があり、書き戻し
  // (「適用」) は無い。「削除」は change: "remove" で送って run (「削除済み
  // HH:MM」、押せるまま)、「やらない」は permit_dismiss で dismiss にするだけで、
  // 何かが済んだ後は押せない。
  test("a remove item's 削除 and やらない, with nothing to add back", async () => {
    const { root, applies, dismissals } = await openWith({
      ...ASKED,
      project_permissions: [{ remove: "Bash(old)" }, { remove: "Bash(other)" }],
    });
    const rows = (): Element[] => [...section(root).querySelectorAll(".permit-settings-change")];
    const button = (i: number, cls: string): HTMLButtonElement =>
      instanceOf(rows()[i]?.querySelector(`button.${cls}`), HTMLButtonElement, cls);
    expect(applyButtons(root)).toEqual([]);
    await press(button(0, "permit-settings-delete"));
    await press(button(1, "permit-settings-dismiss"));
    expect(applies).toEqual([{ id: ID, index: 0, change: "remove" }]);
    expect(dismissals).toEqual([
      { id: ID, kind: "project_permissions", index: 1, dismissed: true },
    ]);
    expect(rowButtons(root)).toEqual([
      [
        [`削除済み ${formatSentAt(APPLIED_AT)}`, false],
        ["やらない", true],
      ],
      [
        ["削除", false],
        ["やらない", true],
      ],
    ]);
    expect(rows()[1]?.getAttribute("data-mark")).toBe("dismiss");
  });

  // 何を保証するか: 項目の行には daemon が書く rule の組 (ev:"permit_state" の
  // rules) を 1 rule 1 行で並べ、symlink の組も 1 つの li に 2 行、「適用」は
  // 1 つ。組がまだ無い間は、エージェントが書いた rule の 1 行。
  test("an item shows the rules the daemon writes for it, a symlink pair in one row", async () => {
    const { root, store, applies } = await openWith({
      ...ASKED,
      project_permissions: [{ add: "Edit(~/link/a.toml)" }, { add: "Bash(ls)" }],
    });
    const lines = (): string[][] =>
      [...section(root).querySelectorAll(".permit-settings-change")].map((li) =>
        [...li.querySelectorAll(".tl-diff-line")].map((line) => line.textContent ?? ""),
      );
    expect(lines()).toEqual([["+Edit(~/link/a.toml)"], ["+Bash(ls)"]]);
    await act(() =>
      store.dispatch({
        type: "permit-state/loaded",
        unread: [],
        granted: [],
        marks: [],
        rules: [
          { tool_use_id: ID, index: 0, rules: ["Edit(~/link/a.toml)", "Edit(//w/real/a.toml)"] },
          { tool_use_id: ID, index: 1, rules: ["Bash(ls)"] },
        ],
      }),
    );
    expect(lines()).toEqual([["+Edit(~/link/a.toml)", "+Edit(//w/real/a.toml)"], ["+Bash(ls)"]]);
    const first = defined(section(root).querySelector(".permit-settings-change"), "first item");
    expect([
      first.getAttribute("data-permit-kind"),
      first.getAttribute("data-permit-index"),
      first.querySelectorAll("button.permit-settings-apply").length,
    ]).toEqual(["project_permissions", "0", 1]);
    await press(defined(applyButtons(root)[0], "the pair's 適用"));
    expect(applies).toEqual([{ id: ID, index: 0, change: "add" }]);
  });

  // 何を保証するか: 断られた (読めない設定等) 時は理由を出し、ボタンは押せる
  // まま (適用済みにしない)。
  test("a refused apply says why, and the button stays", async () => {
    const { root } = await openWith(ASKED, {
      apply: () => ({
        ok: false,
        error: { code: "settings_unreadable", msg: `${FILE} does not read as settings` },
      }),
    });
    await press(defined(applyButtons(root)[0], "first button"));
    expect(section(root).querySelector(".permit-grant-error")?.textContent).toBe(
      `書き込めませんでした: ${FILE} does not read as settings`,
    );
    expect(applyButtons(root)[0]?.disabled).toBe(false);
  });

  // 何を保証するか: 開いている間に適用が記録に乗ると、ファイルを読み直して
  // 書き込み後の中身を出す。
  test("reads the file again when a change is applied while it is open", async () => {
    const after =
      '{\n  "permissions": {\n    "allow": [\n      "Bash(just deploy)"\n    ]\n  }\n}\n';
    const { root, reads } = await openWith(ASKED, {
      reads: [
        { path: FILE, read: false, reason: "missing" },
        { path: FILE, read: true, content: after, bytes: after.length, truncated: false },
      ],
    });
    await setOpen(fold(root), true);
    await press(defined(applyButtons(root)[0], "first button"));
    expect(reads).toEqual([`${SID} ${ID}`, `${SID} ${ID}`]);
    expect(fold(root).querySelector("pre")?.textContent?.trimEnd()).toBe(after.trimEnd());
  });
});
