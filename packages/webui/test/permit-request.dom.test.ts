// 許可依頼バブル (PermitRequestBubble) を Timeline にマウントして、読み手に
// 見えるものと「許可する」が写すものを固定する。
// - 依頼は transcript の permit の行で、結果が PERMIT_REQUESTED_TEXT のものだけが
//   その行の位置にバブルになる (断られた呼び出し・結果の無い呼び出しは出ない、
//   subagent の TL の呼び出しは断られているので出ない)
// - 止められた行動・添付 (パスだけの折り畳み)・許可してほしいこと (intent と
//   コマンド) の節を出し、添付が無ければその節を出さない
// - 添付は開いた時に daemon から読み (permit_attachment_read)、中身か読めない
//   理由を差し込む。読めた後は開き直しても読み直さない
// - 「許可する」は許可の文をクリップボードに写し、写せたら「コピーしました」
//   を出して依頼を既読にする。写せなければそう言い、既読にしない
// - 未読 (ev:"permit_state" の unread に居る) は閉じた錠 🔐、既読は開いた錠 🔓。
//   既読になってもバブルは消えず、見た目は変えない
// - 許可の文には添付のパスを全部並べる。開いたか、読めたかは問わない
// - 外枠は TL の他の吹き出しと同じ部品 (.tl-bubble / -body / -footer / -time)
// - 結果の行が後から live で届くと、その時にバブルになる
// daemon の代わりに、store へ ev:"permit_state" と同じ action を流し、
// permit_read で受けた id を未読から外して返し、permit_attachment_read には
// パスごとに決めた答えを返す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  type JsonObject,
  type PermitAttachment,
  type PermitCall,
  type ReplyOf,
  type UnreadPermit,
} from "@ccmsg/protocol";
import { OpenComposerContext } from "../src/client/components/SessionInputComposer.tsx";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { permitGrantText } from "../src/client/permit-request-view.ts";
import { useStoreState } from "../src/client/useStore.ts";
import type { Store } from "../src/client/useStore.ts";
import type { WsHandle } from "../src/client/ws.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
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

function TimelineOf({ agent }: { agent?: AgentRef }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: agent ?? null,
    active: true,
    visible: true,
  });
}

const ID = "toolu_p1";

const ASKED: PermitCall = {
  blocked: "`aws s3api put-bucket-policy` が止められた",
  attachments: ["/w/policy.json", "/w/gone.sh", "/w/offline.txt"],
  intents: ["`/w/a.ts` の編集"],
  commands: [
    {
      command: "aws s3api put-bucket-policy --bucket b --policy file://policy.json",
      description: "公開読み取りの policy を当てる",
    },
    { command: "ls" },
  ],
  project_permissions: [],
};

/** The call's input as the model wrote it: `ASKED` with `fields` over it. */
function inputOf(fields: Partial<PermitCall> = {}): JsonObject {
  const call = { ...ASKED, ...fields };
  return {
    blocked: call.blocked,
    attachments: [...call.attachments],
    intents: [...call.intents],
    commands: call.commands.map((c): JsonObject => ({ ...c })),
  };
}

/** What the fake daemon answers for each attachment: its content, why it
 * cannot be read, or (for /w/offline.txt) a refusal. */
const OPENED: Readonly<Record<string, PermitAttachment>> = {
  "/w/policy.json": {
    path: "/w/policy.json",
    read: true,
    content: '{"Statement":[]}\n',
    bytes: 17,
    truncated: false,
  },
  "/w/gone.sh": { path: "/w/gone.sh", read: false, reason: "missing" },
};

function unread(id: string): UnreadPermit {
  return { session_id: SID, tool_use_id: id, ts: "2026-10-25T00:00:01.000Z" };
}

async function openWith(
  rows: readonly string[],
  options: {
    /** The requests not acted on (ev:"permit_state"); `ID` unless told. */
    unread?: readonly UnreadPermit[];
    agent?: AgentRef;
    /** What the daemon answers a user_prompt (「! で実行」) with. */
    userPrompt?: WsHandle["userPrompt"];
    /** What the daemon answers a permit_read with, in place of marking the
     * ids read. */
    permitRead?: WsHandle["permitRead"];
  } = {},
): Promise<{
  root: HTMLElement;
  store: Store;
  reads: Array<readonly string[]>;
  opens: string[];
  /** How many times the bubble asked the session's composer to open. */
  composerOpens: () => number;
}> {
  const { agent, userPrompt } = options;
  const store = timelineStore(agent !== undefined ? { agent } : {});
  store.dispatch({
    type: "permit-state/loaded",
    unread: [...(options.unread ?? [unread(ID)])],
    applied: [],
  });
  const ws = new FakeTranscriptWs(store);
  const reads: Array<readonly string[]> = [];
  const opens: string[] = [];
  const handle = {
    ...ws.handle,
    permitRead: (ids: readonly string[]) => {
      reads.push(ids);
      const state = store.getState();
      store.dispatch({
        type: "permit-state/loaded",
        unread: state.permitUnread.filter((p) => !ids.includes(p.tool_use_id)),
        applied: state.permitApplied,
      });
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
    permitAttachmentRead: (
      sid: string,
      id: string,
      path: string,
    ): Promise<ReplyOf<"permit_attachment_read">> => {
      opens.push(`${sid} ${id} ${path}`);
      const attachment = OPENED[path];
      return Promise.resolve(
        attachment !== undefined
          ? { ok: true, attachment }
          : { ok: false, error: { code: "invalid_args", msg: `no permit request with id ${id}` } },
      );
    },
    ...(userPrompt !== undefined ? { userPrompt } : {}),
    ...(options.permitRead !== undefined ? { permitRead: options.permitRead } : {}),
  };
  let composerOpens = 0;
  const openComposer = (): void => {
    composerOpens++;
  };
  const root = await mounted.mount(
    store,
    handle,
    h(
      OpenComposerContext.Provider,
      { value: openComposer },
      h(TimelineOf, agent !== undefined ? { agent } : {}),
    ),
  );
  await ws.lastRead().answer(page(rows));
  return { root, store, reads, opens, composerOpens: () => composerOpens };
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  restores.push(stubProperty(navigator, "clipboard", { value: { writeText }, configurable: true }));
}

function bubbles(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".tl-bubble-permit")];
}

function foldsOf(root: HTMLElement): HTMLDetailsElement[] {
  return [...root.querySelectorAll<HTMLDetailsElement>("details.permit-attachment")];
}

/** Open or close a fold as the person does, and let its read settle. */
async function toggle(fold: HTMLDetailsElement | undefined, open: boolean): Promise<void> {
  const details = defined(fold, "fold");
  await act(async () => {
    // happy-dom fires `toggle` itself when `open` changes, after the change
    // as browsers do: wait for that event, then for the reply.
    const toggled = new Promise((resolve) =>
      details.addEventListener("toggle", resolve, { once: true }),
    );
    details.open = open;
    await toggled;
    await Promise.resolve();
  });
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function grantButton(bubble: HTMLElement): HTMLButtonElement {
  return instanceOf(bubble.querySelector("button.permit-grant"), HTMLButtonElement, "grant");
}

describe("permission request bubbles", () => {
  test("show the session's request: what was stopped, the files, and what to permit", async () => {
    const { root } = await openWith(permitRows(1, ID, inputOf()));
    const [bubble, ...others] = bubbles(root);
    expect(others.length).toBe(0);
    const shown = defined(bubble, "the session's bubble");
    // The same frame as the Timeline's other bubbles: the body, then the
    // footer row with the time alone. The button is the body's last row.
    expect(shown.classList.contains("tl-bubble")).toBe(true);
    expect(shown.classList.contains("tl-bubble-left")).toBe(true);
    expect([...shown.children].map((el) => el.className)).toEqual([
      "tl-bubble-body",
      "tl-bubble-footer",
    ]);
    expect(shown.querySelector(".tl-bubble-body > .tl-bubble-from")?.textContent).toBe(
      "🔐許可依頼",
    );
    expect(
      [...defined(shown.querySelector(".tl-bubble-footer"), "footer").children].map(
        (el) => el.className,
      ),
    ).toEqual(["tl-bubble-time"]);
    // DR-0040 §7: the body's last row ends with 許可する (at its right end,
    // by the row's flex-end), with 既読 just left of it.
    const lastRow = defined(shown.querySelector(".tl-bubble-body > :last-child"), "last row");
    expect(lastRow.className).toBe("permit-grant-row");
    expect([...lastRow.children].map((el) => el.className)).toEqual([
      "permit-read",
      "permit-grant",
    ]);
    expect(lastRow.querySelector("button.permit-read")?.textContent).toBe("既読");
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      "添付",
      "許可してほしいこと",
    ]);
    expect(shown.querySelector(".permit-section .md")?.textContent).toContain(
      "aws s3api put-bucket-policy が止められた",
    );
    // Each file is a closed fold showing its path alone, nothing read yet.
    const folds = [...shown.querySelectorAll("details.permit-attachment")];
    expect(
      folds.map((d) => [d.querySelector("summary")?.textContent, d.hasAttribute("open")]),
    ).toEqual([
      ["/w/policy.json", false],
      ["/w/gone.sh", false],
      ["/w/offline.txt", false],
    ]);
    expect(shown.querySelector(".permit-attachment pre")).toBeNull();
    const asks = [...shown.querySelectorAll(".permit-asks > li")].map((li) => li.textContent);
    expect(asks).toEqual([
      "/w/a.ts の編集",
      "以下コマンドの実行（公開読み取りの policy を当てる）aws s3api put-bucket-policy --bucket b --policy file://policy.json",
      "以下コマンドの実行ls",
    ]);
  });

  // 何を保証するか: 添付は開いた時に読み、中身か読めない理由をその折り畳みに
  // 差し込む。読めた後は閉じて開き直しても読み直さない。daemon が答えなかった
  // 時はそう言い、次に開いた時に読み直す。
  test("read a file when it is opened, once it has been read", async () => {
    const { root, opens } = await openWith(permitRows(1, ID, inputOf()));
    const folds = foldsOf(root);
    await toggle(folds[0], true);
    expect(folds[0]?.querySelector("pre")?.textContent).toBe('{"Statement":[]}\n');
    await toggle(folds[0], false);
    await toggle(folds[0], true);
    await toggle(folds[1], true);
    expect(folds[1]?.querySelector(".permit-attachment-status")?.textContent).toBe(
      "ファイルが無い",
    );
    expect(folds[1]?.querySelector("pre")).toBeNull();
    await toggle(folds[2], true);
    expect(folds[2]?.querySelector(".permit-attachment-status")?.textContent).toBe(
      `読めませんでした: no permit request with id ${ID}`,
    );
    await toggle(folds[2], false);
    await toggle(folds[2], true);
    expect(opens).toEqual([
      `${SID} ${ID} /w/policy.json`,
      `${SID} ${ID} /w/gone.sh`,
      `${SID} ${ID} /w/offline.txt`,
      `${SID} ${ID} /w/offline.txt`,
    ]);
  });

  // 何を保証するか: 結果が「許可依頼を出した」でない呼び出し (断られた
  // subagent の呼び出し、他の断り) と、結果がまだ無い呼び出しはバブルにならない。
  // subagent の TL の呼び出しは module が断っているので、そこにも出ない。
  test("are not shown for a refused call, nor for one not answered yet", async () => {
    const refused = "permit は subagent からは使えない。止められた操作は委譲元に報告して止まる";
    const rows = [
      ...permitRows(1, "toolu_refused", inputOf(), { result: refused }),
      ...permitRows(2, "toolu_failed", inputOf(), { result: "許可依頼を出せなかった: x" }),
      ...permitRows(3, "toolu_waiting", inputOf(), { result: null }),
    ];
    const { root } = await openWith(rows);
    expect(bubbles(root).length).toBe(0);
    await mounted.unmount();
    const inAgent = await openWith(permitRows(1, ID, inputOf(), { result: refused }), {
      agent: { agentId: "a1" },
    });
    expect(bubbles(inAgent.root).length).toBe(0);
  });

  test("leave out the 添付 section when there are none", async () => {
    const { root } = await openWith(permitRows(1, ID, inputOf({ attachments: [] })));
    const shown = defined(bubbles(root)[0], "bubble");
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      "許可してほしいこと",
    ]);
  });

  test("許可する copies the permission, says it did, marks the request read, and opens the composer", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { root, store, reads, composerOpens } = await openWith(permitRows(1, ID, inputOf()));
    const bubble = defined(bubbles(root)[0], "bubble");
    const button = grantButton(bubble);
    expect(button.classList.contains("copied")).toBe(false);
    // Unread: the closed lock.
    expect(bubble.querySelector(".tl-bubble-from")?.textContent).toBe("🔐許可依頼");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(written).toEqual([permitGrantText(ASKED)]);
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.querySelector(".permit-grant-copied")?.getAttribute("aria-hidden")).toBe("false");
    expect(root.querySelector(".permit-grant-error")).toBeNull();
    expect(reads).toEqual([[ID]]);
    expect(store.getState().permitUnread).toEqual([]);
    // Read: the open lock, in the same bubble with the same look.
    const settled = defined(bubbles(root)[0], "bubble");
    expect(settled.className).toBe(bubble.className);
    expect(settled.querySelector(".tl-bubble-from")?.textContent).toBe("🔓許可依頼");
    // DR-0040 §7: the session's input box opens to paste the text into.
    expect(composerOpens()).toBe(1);
    // A request read already is not marked again.
    await act(async () => {
      grantButton(defined(bubbles(root)[0], "bubble")).click();
      await Promise.resolve();
    });
    expect(reads).toEqual([[ID]]);
  });

  // 何を保証するか: 「既読」は許可の文を写さず、入力欄も開かずに依頼を既読に
  // する (Sessions 一覧の 🔐 の数から外す)。既読の依頼では押せない。
  test("既読 marks the request read without copying or opening the composer", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { root, store, reads, composerOpens } = await openWith(permitRows(1, ID, inputOf()));
    const readButton = (): HTMLButtonElement =>
      instanceOf(
        defined(bubbles(root)[0], "bubble").querySelector("button.permit-read"),
        HTMLButtonElement,
        "既読",
      );
    expect(readButton().disabled).toBe(false);
    await press(readButton());
    expect(reads).toEqual([[ID]]);
    expect(store.getState().permitUnread).toEqual([]);
    expect(written).toEqual([]);
    expect(composerOpens()).toBe(0);
    expect(defined(bubbles(root)[0], "bubble").querySelector(".tl-bubble-from")?.textContent).toBe(
      "🔓許可依頼",
    );
    expect(readButton().disabled).toBe(true);
  });

  // 何を保証するか: 既読にできなかった理由は、写せなかった理由と同じく
  // ボタンの左 (行の先頭) に出し、ボタンの並び (既読、許可する) を動かさない。
  test("a refused 既読 says why, left of the buttons", async () => {
    const { root } = await openWith(permitRows(1, ID, inputOf()), {
      permitRead: () =>
        Promise.resolve({
          ok: false,
          error: { code: "invalid_args", msg: `no permit request with id ${ID}` },
        }),
    });
    const bubble = defined(bubbles(root)[0], "bubble");
    await press(instanceOf(bubble.querySelector("button.permit-read"), HTMLButtonElement, "既読"));
    const row = defined(bubble.querySelector(".permit-grant-row"), "row");
    expect([...row.children].map((el) => el.className)).toEqual([
      "permit-grant-notes",
      "permit-read",
      "permit-grant",
    ]);
    expect(row.querySelector(".permit-grant-error")?.textContent).toBe(
      `no permit request with id ${ID}`,
    );
  });

  // 何を保証するか: 許可の文には添付を全部並べる。開いていない添付も、開いて
  // 読めなかった添付 (無い、daemon が答えなかった) も並べる。確認したかは人が
  // 判断することで、バブルは開いたかを追わない。
  test("lists every file, opened or not, read or not", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { root } = await openWith(permitRows(1, ID, inputOf()));
    const folds = foldsOf(root);
    await toggle(folds[1], true);
    await toggle(folds[2], true);
    await press(grantButton(defined(bubbles(root)[0], "bubble")));
    expect(written).toEqual([permitGrantText(ASKED)]);
    expect(written[0]).toContain(
      "以下ファイルの内容を確認しました。問題無し。\n- /w/policy.json\n- /w/gone.sh\n- /w/offline.txt\n\n",
    );
  });

  test("says so when the permission could not be copied", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    const { root, reads, composerOpens } = await openWith(permitRows(1, ID, inputOf()));
    const button = grantButton(defined(bubbles(root)[0], "bubble"));
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.classList.contains("copied")).toBe(false);
    expect(reads).toEqual([]);
    // Nothing to paste, so the input box stays as it was.
    expect(composerOpens()).toBe(0);
    expect(root.querySelector(".permit-grant-error")?.textContent).toContain(
      "コピーできませんでした",
    );
  });

  // 何を保証するか: live で届いた permit の呼び出しは、結果の行が届いた時に
  // その呼び出しの行の位置でバブルになる。既読かどうかは ev:"permit_state" に
  // 従い、バブルの錠だけが替わる。
  test("a call whose result comes later becomes a bubble then, its lock following the daemon", async () => {
    const first = permitRows(1, ID, inputOf());
    const { root, store } = await openWith(first);
    const later = permitRows(2, "toolu_p2", inputOf({ blocked: "later" }));
    const size = (lines: readonly string[]): number =>
      lines.reduce((sum, text) => sum + new TextEncoder().encode(text).length + 1, 0);
    const tail = (lines: readonly string[], start: number): void =>
      store.dispatch({
        type: "timeline/tail",
        sid: SID,
        lines: [...lines],
        start,
        end: start + size(lines),
        size: start + size(lines),
      });
    await act(() => tail([later[0] ?? ""], size(first)));
    expect(bubbles(root).length).toBe(1);
    await act(() => tail([later[1] ?? ""], size([...first, later[0] ?? ""])));
    expect(bubbles(root).map((b) => b.querySelector(".permit-section .md")?.textContent)).toEqual([
      "aws s3api put-bucket-policy が止められた",
      "later",
    ]);
    expect(bubbles(root).map((b) => b.querySelector(".tl-bubble-from")?.textContent)).toEqual([
      "🔐許可依頼",
      "🔓許可依頼",
    ]);
    await act(() =>
      store.dispatch({ type: "permit-state/loaded", unread: [unread("toolu_p2")], applied: [] }),
    );
    expect(bubbles(root).map((b) => b.querySelector(".tl-bubble-from")?.textContent)).toEqual([
      "🔓許可依頼",
      "🔐許可依頼",
    ]);
  });
});

// DR-0040 §7: a one-line command has 「! で実行」 under its code block, which
// runs it in the asking session as the person's `! <command>` (user_prompt
// with mode bash). The button is apart from 許可する: it neither copies nor
// marks the request read. Its words come from CSS, not the DOM, so they join
// neither the commands' copied text nor the Timeline's search.
describe("! で実行", () => {
  const ONE_AND_MANY = permitRows(
    1,
    ID,
    inputOf({
      attachments: [],
      commands: [{ command: "ls -la", description: "一覧" }, { command: "cat <<EOF\nx\nEOF" }],
    }),
  );

  /** A user_prompt that records what it was asked and answers `reply`. */
  function answering(reply: ReplyOf<"user_prompt">, asked: unknown[][]): WsHandle["userPrompt"] {
    return (...args) => {
      asked.push(args);
      return Promise.resolve(reply);
    };
  }

  function bangOf(li: Element | undefined): HTMLButtonElement | null {
    return defined(li, "command").querySelector<HTMLButtonElement>("button.permit-bang");
  }

  test("sits under the code block of each one-line command, and of no multi-line one", async () => {
    const { root } = await openWith(ONE_AND_MANY);
    const [oneLine, multiLine] = [...root.querySelectorAll(".permit-command")];
    const button = instanceOf(bangOf(oneLine), HTMLButtonElement, "! で実行");
    expect(button.getAttribute("aria-label")).toBe("! で実行");
    expect(button.textContent).toBe("");
    // Right under the code block: the row after the code's frame.
    const row = defined(button.parentElement, "row");
    expect(row.className).toBe("permit-bang-row");
    expect(row.previousElementSibling?.className).toContain("code-copy-frame");
    expect(bangOf(multiLine)).toBeNull();
  });

  test("runs the command as bash mode in the asking session, and says when", async () => {
    const asked: unknown[][] = [];
    const { root, reads, composerOpens } = await openWith(ONE_AND_MANY, {
      userPrompt: answering({ ok: true, outcome: "accepted" }, asked),
    });
    const li = root.querySelector(".permit-command") ?? undefined;
    await press(instanceOf(bangOf(li), HTMLButtonElement, "! で実行"));
    expect(asked).toEqual([[SID, "ls -la", undefined, "bash"]]);
    expect(li?.querySelector(".permit-bang-sent")?.textContent).toContain(
      "に送りました。出力はコマンドが終わると Timeline に出ます",
    );
    expect(li?.querySelector(".session-input-notice")).toBeNull();
    // Apart from 許可する: nothing copied, not marked read, no composer.
    expect(reads).toEqual([]);
    expect(composerOpens()).toBe(0);
  });

  test("cannot be pressed again while its run is being sent", async () => {
    const asked: unknown[][] = [];
    let answer: (reply: ReplyOf<"user_prompt">) => void = () => {};
    const { root } = await openWith(ONE_AND_MANY, {
      userPrompt: (...args) => {
        asked.push(args);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const li = root.querySelector(".permit-command") ?? undefined;
    const button = instanceOf(bangOf(li), HTMLButtonElement, "! で実行");
    await press(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.click();
    expect(asked.length).toBe(1);
    await act(async () => {
      answer({ ok: true, outcome: "accepted" });
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
  });

  test("not delivered, or not known to be, shows the input box's notice", async () => {
    for (const [reply, tone, title] of [
      [{ ok: true, outcome: "not_delivered", reason: "dialog" }, "danger", "届きませんでした"],
      [
        { ok: false, error: { code: "request_timeout", msg: "no reply" } },
        "warn",
        "届いたか確認できませんでした",
      ],
    ] as const) {
      const asked: unknown[][] = [];
      const { root } = await openWith(ONE_AND_MANY, { userPrompt: answering(reply, asked) });
      const li = root.querySelector(".permit-command") ?? undefined;
      await press(instanceOf(bangOf(li), HTMLButtonElement, "! で実行"));
      const notice = defined(li?.querySelector(".session-input-notice") ?? undefined, "notice");
      expect(notice.classList.contains(`session-input-notice-${tone}`)).toBe(true);
      expect(notice.querySelector(".session-input-notice-title")?.textContent).toBe(title);
      expect(li?.querySelector(".permit-bang-sent")).toBeNull();
      await mounted.unmount();
    }
  });
});
