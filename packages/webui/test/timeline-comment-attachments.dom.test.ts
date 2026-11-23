// A comment's attachments in the Timeline (DR-0062 §3, §7, §12, §13), mounted.
// The FAB's box and the comment form share the attaching parts (the upload,
// the chips, the `[FILE<N>]` put at the caret): what the FAB's box does with
// them is session-input-composer.dom.test.ts's.
// 何を保証するか:
//   - コメントのフォームに貼り付けた・📎 で選んだファイルは upload され、チップ
//     (FILE<N>: 名前) が出て、本文の caret の位置に [FILE<N>] が入る
//   - 保存の comment_add に、upload の済んだ添付 (番号・名前・パス) が載る。upload の
//     途中は保存できない
//   - 未送信のコメントの吹き出しは、送ったものと同じく添付を置き換えた届く形の本文を出し
//     (チップは出さない)、「直す」でチップの × と 📎 を持つ。× は本文の [FILE<N>] ごと
//     外し、保存の comment_update に残った添付が載る
//   - 送ったコメントの吹き出しは、添付を置き換えた本文 ([FILE<N>:<名前>](<パス>)) を
//     ユーザの発言と同じ描き方で出し、state dir の下の添付は画像 (他はリンク) で出る。
//     記録から描く時 (transcript にまだ出ていない) も同じ。届いた FAB の下書きの人の行も同じ
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  commentsPromptText,
  type CommentRecord,
  type PromptDraftAttachment,
  type UserComment,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState } from "../src/client/useStore.ts";
import { line as jsonl, userContentRow } from "../../protocol/test/transcript-rows.ts";
import { instanceOf, MemStorage, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
  uuidOf,
} from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
});

/** Where an uploaded file of the test lands (POST /attachment's answer). */
const UPLOADED = "/tmp/claude-ccmsg-501/attachment/11111111-1111-4111-8111-000000000001.png";
/** Where the daemon keeps a comment's attachment (DR-0062 P29). */
const KEPT = `/state/sessions/${SID}.att-11111111-1111-4111-8111-000000000001.png`;

/** An XHR whose upload ends at once with POST /attachment's answer for
 * UPLOADED, the file's own name. */
class DoneXhr {
  upload = {};
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  open(): void {}
  send(form: FormData): void {
    const file = form.get("file");
    const name = file instanceof File ? file.name : "";
    queueMicrotask(() => {
      this.status = 200;
      this.responseText = JSON.stringify({
        ok: true,
        uuid: "11111111-1111-4111-8111-000000000001",
        ext: ".png",
        size: 1,
        mime: "image/png",
        path: UPLOADED,
        name,
      });
      this.onload?.();
    });
  }
}

/** An XHR whose upload never ends. */
class PendingXhr {
  upload = {};
  open(): void {}
  send(): void {}
}

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

function comment(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
    updated_at: "2030-01-01T00:00:00.000Z",
    btw: false,
    status: "draft",
    ...patch,
  };
}

type FakeHandle = FakeTranscriptWs["handle"];
type AddInput = Parameters<FakeHandle["commentAdd"]>[1];
interface UpdateInput {
  cid: string;
  body: string;
  attachments: PromptDraftAttachment[];
}

async function open(
  lines: readonly string[],
  records: readonly CommentRecord[] = [],
  filter: "comment" | null = null,
) {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  const store = timelineStore();
  if (filter !== null) {
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, filter },
      sidebar: CLOSED_SIDEBAR,
    });
  }
  store.dispatch({
    type: "comments/loaded",
    sid: SID,
    comments: [...records],
    threads: [],
    drafts: [],
  });
  const ws = new FakeTranscriptWs(store);
  const adds: AddInput[] = [];
  const updates: UpdateInput[] = [];
  const handle: FakeHandle = {
    ...ws.handle,
    commentAdd: (sid, input) => {
      adds.push(input);
      return Promise.resolve({
        ok: true as const,
        comment: comment({ cid: "c9999", session_id: sid, body: input.body }),
      });
    },
    commentUpdate: (_sid, cid, _seen, body, attachments) => {
      updates.push({ cid, body, attachments: [...attachments] });
      return Promise.resolve({ ok: true as const, comment: comment({ cid, body }) });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...lines]));
  return { root, adds, updates };
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`[data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `the item of ${uuid}`,
  );
}

function fileItem(file: File) {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }),
  };
}

/** A paste of `files` on `el`, as a browser sends one. */
async function paste(el: HTMLElement, files: File[]): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  restores.push(stubProperty(event, "clipboardData", { value: { items: files.map(fileItem) } }));
  await act(async () => {
    el.dispatchEvent(event);
    // The upload's answer comes in a microtask after it is sent.
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function typeInto(el: HTMLTextAreaElement, text: string, caret = text.length): Promise<void> {
  await act(() => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  el.setSelectionRange(caret, caret);
}

function chipLabels(scope: Element): string[] {
  return Array.from(
    scope.querySelectorAll(".composer-attachment-label"),
    (n) => n.textContent ?? "",
  );
}

/** Opens the form of a comment on answer 1 (its 返信). */
async function openFormOnAnswer(root: HTMLElement) {
  const reply = instanceOf(
    itemOf(root, uuidOf("a", 1)).querySelector(".tl-comment-reply"),
    HTMLButtonElement,
    "返信",
  );
  await act(() => reply.click());
  const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
  const input = instanceOf(float.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
  return { float, input };
}

async function submit(float: HTMLElement): Promise<void> {
  const form = instanceOf(float.querySelector(".tl-comment-form"), HTMLFormElement, "form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("attaching to a comment in its form", () => {
  beforeEach(() => {
    restores.push(stubGlobal("XMLHttpRequest", DoneXhr));
  });

  // FAB の入力と同じ添付の操作: 貼り付けたファイルは upload され、チップが出て、本文の
  // caret の位置に [FILE<N>] が入る (DR-0015 §2.4)。フォームは 📎 のボタンも持つ。保存の
  // comment_add には upload の済んだ添付が、本文が名指す番号のまま載る (番号をセッションの
  // 続きに振り直すのは daemon)。
  test("a file pasted is uploaded, shows as a chip and a [FILE<N>] at the caret, and goes with the save", async () => {
    const { root, adds } = await open([...exchange(1)]);
    const { float, input } = await openFormOnAnswer(root);
    expect(float.querySelector(".composer-attach-btn")?.getAttribute("aria-label")).toBe(
      "ファイルを添付",
    );
    await typeInto(input, "これを見て", 2);
    await paste(input, [new File([new Uint8Array([1])], "a.png", { type: "image/png" })]);
    expect(input.value).toBe("これ[FILE1]を見て");
    expect(chipLabels(float)).toEqual(["FILE1: a.png"]);
    await submit(float);
    expect(adds).toEqual([
      {
        anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
        body: "これ[FILE1]を見て",
        attachments: [{ n: 1, name: "a.png", path: UPLOADED }],
        btw: false,
        sendNow: true,
      },
    ]);
  });

  // 📎 で選んだファイルも同じ経路で upload される。2 つ目は 1 つ目の番号の次を取る。
  test("files picked with 📎 are numbered on, each with its chip", async () => {
    const { root } = await open([...exchange(1)]);
    const { float, input } = await openFormOnAnswer(root);
    const picker = instanceOf(
      float.querySelector(".composer-attach-file"),
      HTMLInputElement,
      "the file input",
    );
    restores.push(
      stubProperty(picker, "files", {
        value: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
          new File([new Uint8Array([2])], "b.txt", { type: "text/plain" }),
        ],
        configurable: true,
      }),
    );
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe("[FILE1][FILE2]");
    expect(chipLabels(float)).toEqual(["FILE1: a.png", "FILE2: b.txt"]);
  });

  // upload の途中は保存できない: 添付の無いコメントや、[FILE<N>] がファイルを指さない
  // コメントを作らないため (FAB の送信と同じ)。
  test("the save waits for an upload in flight", async () => {
    restores.push(stubGlobal("XMLHttpRequest", PendingXhr));
    const { root, adds } = await open([...exchange(1)]);
    const { float, input } = await openFormOnAnswer(root);
    await typeInto(input, "見て ");
    await paste(input, [new File([new Uint8Array([1])], "a.png", { type: "image/png" })]);
    const save = instanceOf(
      float.querySelector(".tl-comment-form button[type=submit]"),
      HTMLButtonElement,
      "the save",
    );
    expect(save.disabled).toBe(true);
    // The text shown (the pill's other texts are drawn hidden in the same cell).
    expect(save.querySelector("span:not(.session-input-send-off)")?.textContent).toBe(
      "アップロード中...",
    );
    await submit(float);
    expect(adds).toEqual([]);
  });
});

/** The bubble of the one unsent comment (the 💬 filter's). */
function unsentBubble(root: HTMLElement): HTMLElement {
  return instanceOf(
    root.querySelector(".tl-bubble-comment[data-unsent]"),
    HTMLElement,
    "the unsent comment",
  );
}

describe("an unsent comment's attachments", () => {
  beforeEach(() => {
    restores.push(stubGlobal("XMLHttpRequest", DoneXhr));
  });

  const withFile = comment({
    cid: "c0001",
    body: "[FILE3] を見て",
    attachments: [{ n: 3, name: "a.png", path: KEPT }],
  });

  // 未送信のコメントの吹き出しは、送ったものと同じく添付を置き換えた後の届く形
  // ([FILE3:a.png](<パス>) を見て) を描く: state dir の下の画像は画像で出る。直して
  // いない間はチップも × も持たない。
  test("the unsent comment's bubble shows the body as it goes, its kept file put in", async () => {
    const { root } = await open([...exchange(1)], [withFile], "comment");
    const card = unsentBubble(root);
    const body = card.querySelector(".tl-comment-body");
    expect(body?.querySelector("img.md-attachment-image")?.getAttribute("src")).toBe(
      `/attachment/${SID}.att-11111111-1111-4111-8111-000000000001.png`,
    );
    expect(body?.textContent).toBe(" を見て");
    expect(chipLabels(card)).toEqual([]);
    expect(card.querySelector(".composer-attachment-remove")).toBeNull();
  });

  // 「直す」では添付を足し引きできる: チップの × は本文の [FILE<N>] ごと外し、📎・貼り付け
  // で足した添付は入力欄の中の次の番号を取る (今ある添付と本文の [FILE<N>] の最大の次。
  // セッションの続きの番号に振り直すのは daemon)。保存の comment_update には今ある添付が
  // 載り、既にある添付は daemon が置いたパスのまま (daemon はパスで見分けて番号を保つ)。
  test("直す takes a chip off with its [FILE<N>], adds one, and the save carries what is left", async () => {
    const { root, updates } = await open([...exchange(1)], [withFile], "comment");
    const card = unsentBubble(root);
    const edit = [...card.querySelectorAll("button")].find((b) => b.textContent === "直す");
    await act(() => edit?.click());
    expect(card.querySelector(".composer-attach-btn")).not.toBeNull();
    const input = instanceOf(card.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
    expect(input.value).toBe("[FILE3] を見て");
    const remove = instanceOf(
      card.querySelector(".composer-attachment-remove"),
      HTMLButtonElement,
      "the chip's ×",
    );
    await act(() => remove.click());
    expect(input.value).toBe(" を見て");
    expect(chipLabels(card)).toEqual([]);
    input.setSelectionRange(0, 0);
    await paste(input, [new File([new Uint8Array([1])], "b.png", { type: "image/png" })]);
    expect(input.value).toBe("[FILE1] を見て");
    const save = [...card.querySelectorAll("button")].find((b) => b.textContent === "保存");
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(updates).toEqual([
      {
        cid: "c0001",
        body: "[FILE1] を見て",
        attachments: [{ n: 1, name: "b.png", path: UPLOADED }],
      },
    ]);
  });

  // 添付を変えない直しも、今ある添付をそのまま載せる (落とさない)。
  test("a change of the text alone carries the attachments held", async () => {
    const { root, updates } = await open([...exchange(1)], [withFile], "comment");
    const card = unsentBubble(root);
    const edit = [...card.querySelectorAll("button")].find((b) => b.textContent === "直す");
    await act(() => edit?.click());
    const input = instanceOf(card.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
    await typeInto(input, "[FILE3] をよく見て");
    const save = [...card.querySelectorAll("button")].find((b) => b.textContent === "保存");
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(updates).toEqual([
      {
        cid: "c0001",
        body: "[FILE3] をよく見て",
        attachments: [{ n: 3, name: "a.png", path: KEPT }],
      },
    ]);
  });
});

describe("a sent comment's attachments, and a FAB's draft's", () => {
  // 送ったコメントの吹き出しは、届いた形 (添付を置き換えた本文) をユーザの発言と同じ
  // 描き方で出す: 打たれた文字のまま、リンクになれるもの (添付・URL・確かめたファイル)
  // だけをリンクにする。コメントの添付は daemon が state dir の下 (sessions/<sid>.att-
  // <uuid><ext>) に移したもので、daemon がその名前で配るので、画像は <img>、他は添付の
  // リンクになる。transcript の行から描く時も、行が出る前に記録から描く時も同じ。
  test("its bubble shows the body as it went, its kept files as attachments, from the row and from its record", async () => {
    const KEPT_TXT = `/state/sessions/${SID}.att-11111111-1111-4111-8111-000000000002.txt`;
    const prompt = commentsPromptText([
      {
        comment: "c0001",
        on: { kind: "msg_start_with", value: "answer 1" },
        body: `[FILE1:a.png](${KEPT}) を見て`,
      },
    ]);
    const { root } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [
        comment({
          cid: "c0001",
          status: "delivered",
          body: "[FILE1] を見て",
          attachments: [{ n: 1, name: "a.png", path: KEPT }],
          sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
        }),
        comment({
          cid: "c0002",
          status: "sent",
          body: "[FILE2] も",
          attachments: [{ n: 2, name: "b.txt", path: KEPT_TXT }],
          sent: { at: "2030-01-01T00:00:02.000Z", after_uuid: uuidOf("a", 1) },
        }),
      ],
    );
    const bodies = [...root.querySelectorAll(".tl-bubble-comment .tl-comment-body")];
    // The one sent later and not in the transcript yet stands where it was
    // sent (after answer 1), before the row of the one delivered.
    expect(bodies.length).toBe(2);
    const [fromRecord, fromRow] = bodies;
    expect(fromRow?.querySelector("img.md-attachment-image")?.getAttribute("src")).toBe(
      `/attachment/${SID}.att-11111111-1111-4111-8111-000000000001.png`,
    );
    expect(fromRow?.textContent).toBe(" を見て");
    const link = fromRecord?.querySelector("a.md-attachment-link");
    expect(link?.getAttribute("href")).toBe(
      `/attachment/${SID}.att-11111111-1111-4111-8111-000000000002.txt`,
    );
    expect(fromRecord?.textContent).toBe("FILE2:b.txt も");
  });

  // FAB のキューの下書きも、送る時に添付が state dir の下のパスに置き換わる (DR-0062
  // §15)。届いた後の人の行 (普通のユーザの発言) でも、その添付は画像で出る。
  test("a FAB's draft's kept file shows as an image in the person's row it landed as", async () => {
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(`[FILE1:a.png](${KEPT}) あとで見て`, { uuid: uuidOf("u", 2) })),
    ]);
    const row = itemOf(root, uuidOf("u", 2));
    expect(row.querySelector("img.md-attachment-image")?.getAttribute("src")).toBe(
      `/attachment/${SID}.att-11111111-1111-4111-8111-000000000001.png`,
    );
  });
});
