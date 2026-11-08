// 許可依頼バブルの「.claude/settings.local.json の修正許可」区画 (DR-0040 §12)
// を Timeline にマウントして、読み手に見えるものと各「許可する」が送るものを
// 固定する。
// - project_permissions のある依頼にだけ区画が出て、本文の最後の「許可する」の
//   前に置かれる。project_permissions だけの依頼には「許可する」が無い
// - 設定ファイルは依頼の行の cwd の .claude/settings.local.json で、既定で閉じた
//   折り畳み。開いた時に daemon から読む (permit_settings_read)。無いファイルは
//   「(無し)」
// - 変更は 1 件ずつ diff の行 (+ は tl-diff-add、- は tl-diff-delete) で並び、
//   各行の「許可する」はその 1 件だけを permit_permission_apply で送る
// - 適用済みの行はボタンが無効で「適用済み HH:MM」。断られたら理由を出し、
//   ボタンは押せるまま
// - 開いている間に適用が ev:"permit_state" に乗ると、中身を読み直す
// daemon の代わりに、permit_permission_apply を受けたらその変更を適用済みにして
// store に ev:"permit_state" と同じ action を流す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type {
  JsonObject,
  PermitAttachment,
  PermitProjectPermission,
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
    /** What the daemon answers an apply with; by default it applies. */
    apply?: (permission: PermitProjectPermission) => ReplyOf<"permit_permission_apply"> | null;
  } = {},
): Promise<{
  root: HTMLElement;
  store: Store;
  reads: string[];
  applies: Array<{ id: string; permission: PermitProjectPermission }>;
}> {
  const store = timelineStore({});
  const ws = new FakeTranscriptWs(store);
  const reads: string[] = [];
  const applies: Array<{ id: string; permission: PermitProjectPermission }> = [];
  const queued = [...(answers.reads ?? [])];
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
      permission: PermitProjectPermission,
    ): Promise<ReplyOf<"permit_permission_apply">> => {
      applies.push({ id, permission });
      const refused = answers.apply?.(permission) ?? null;
      if (refused !== null) return Promise.resolve(refused);
      const state = store.getState();
      store.dispatch({
        type: "permit-state/loaded",
        unread: state.permitUnread,
        applied: [...state.permitApplied, { tool_use_id: id, permission, applied_at: APPLIED_AT }],
      });
      return Promise.resolve({ ok: true, changed: true, applied_at: APPLIED_AT });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page(permitRows(1, ID, input)));
  return { root, store, reads, applies };
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
    expect(applyButtons(root).map((b) => [b.textContent, b.disabled])).toEqual([
      ["✅ 許可する", false],
      ["✅ 許可する", false],
    ]);
    expect(reads).toEqual([]);
  });

  // 何を保証するか: project_permissions だけの依頼 (intents も commands も無い)
  // には「許可してほしいこと」と本文の最後の「許可する」を出さず、区画だけを
  // 出す (写す操作が無い)。
  test("a request of project permissions alone shows the section without 許可する", async () => {
    const { commands: _, ...alone } = ASKED;
    const { root } = await openWith(alone);
    const shown = bubble(root);
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      ".claude/settings.local.json の修正許可",
    ]);
    expect(shown.querySelector("button.permit-grant")).toBeNull();
    expect(applyButtons(root).length).toBe(2);
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

  // 何を保証するか: 「許可する」はその 1 件だけを送り、daemon が適用を記録に
  // 乗せると、そのボタンが無効になって「適用済み HH:MM」になる。他の行は
  // 押せるまま。
  test("許可する applies that change alone, and the line then says when it was applied", async () => {
    const { root, applies } = await openWith(ASKED);
    await press(defined(applyButtons(root)[0], "first button"));
    expect(applies).toEqual([{ id: ID, permission: { add: "Bash(just deploy)" } }]);
    expect(applyButtons(root).map((b) => [b.textContent, b.disabled])).toEqual([
      [`適用済み ${formatSentAt(APPLIED_AT)}`, true],
      ["✅ 許可する", false],
    ]);
    await press(defined(applyButtons(root)[1], "second button"));
    expect(applies.at(-1)).toEqual({ id: ID, permission: { remove: "Bash(just deploy-old)" } });
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
