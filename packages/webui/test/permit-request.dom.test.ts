// 許可依頼バブル (usePermitBubbles + PermitRequestBubble) を Timeline に
// マウントして、読み手に見えるものと「許可する」が写すものを固定する。
// - そのセッションの依頼だけが出る (別セッションの依頼、agent TL には出ない)
// - 止められた行動・添付 (パスだけの折り畳み)・許可してほしいこと (intent と
//   コマンド) の節を出し、添付が無ければその節を出さない
// - 添付は開いた時に daemon から読み (permit_attachment_read)、中身か読めない
//   理由を差し込む。読めた後は開き直しても読み直さない
// - 「許可する」は許可の文をクリップボードに写し、写せたら「コピーしました」
//   を出して依頼を既読にする。写せなければそう言い、既読にしない
// - 許可の文には添付のパスを全部並べる。開いたか、読めたかは問わない
// - 外枠は TL の他の吹き出しと同じ部品 (.tl-bubble / -body / -footer / -time)
// - 後から届いた依頼・既読になった依頼 (ev:"permit_request") が同じ TL の同じ
//   場所に入る
// daemon の代わりに、store へ ev:"permit_requests" / ev:"permit_request" と
// 同じ action を流し、permit_request_read で受けた id を既読にして返し、
// permit_attachment_read にはパスごとに決めた答えを返す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { PermitAttachment, PermitRequestRecord, ReplyOf } from "@ccmsg/protocol";
import { OpenComposerContext } from "../src/client/components/SessionInputComposer.tsx";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { permitGrantText } from "../src/client/permit-request-view.ts";
import { useStoreState } from "../src/client/useStore.ts";
import type { Store } from "../src/client/useStore.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
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

const ASKED: PermitRequestRecord = {
  id: "i/1",
  sid: SID,
  ts: "2026-10-25T00:00:01.000Z",
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
  read: false,
};

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

async function openWith(
  requests: readonly PermitRequestRecord[],
  agent?: AgentRef,
): Promise<{
  root: HTMLElement;
  store: Store;
  reads: Array<readonly string[]>;
  opens: string[];
  /** How many times the bubble asked the session's composer to open. */
  composerOpens: () => number;
}> {
  const store = timelineStore(agent !== undefined ? { agent } : {});
  store.dispatch({ type: "permit-requests/loaded", requests: [...requests] });
  const ws = new FakeTranscriptWs(store);
  const reads: Array<readonly string[]> = [];
  const opens: string[] = [];
  const handle = {
    ...ws.handle,
    permitRequestRead: (ids: readonly string[]) => {
      reads.push(ids);
      for (const request of store.getState().permitRequests) {
        if (ids.includes(request.id)) {
          store.dispatch({ type: "permit-requests/updated", request: { ...request, read: true } });
        }
      }
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
    permitAttachmentRead: (
      id: string,
      path: string,
    ): Promise<ReplyOf<"permit_attachment_read">> => {
      opens.push(`${id} ${path}`);
      const attachment = OPENED[path];
      return Promise.resolve(
        attachment !== undefined
          ? { ok: true, attachment }
          : { ok: false, error: { code: "invalid_args", msg: `no permit request with id ${id}` } },
      );
    },
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
  await ws.lastRead().answer(page([]));
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
    const { root } = await openWith([ASKED, { ...ASKED, id: "i/2", sid: "someone-else" }]);
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
    expect(
      shown.querySelector(".tl-bubble-body > :last-child > button.permit-grant"),
    ).not.toBeNull();
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
    const { root, opens } = await openWith([ASKED]);
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
      "読めませんでした: no permit request with id i/1",
    );
    await toggle(folds[2], false);
    await toggle(folds[2], true);
    expect(opens).toEqual([
      "i/1 /w/policy.json",
      "i/1 /w/gone.sh",
      "i/1 /w/offline.txt",
      "i/1 /w/offline.txt",
    ]);
  });

  // The subagent's Timeline shows that subagent's transcript; the request is
  // the session's, asked by its main thread.
  test("are not shown in a subagent's Timeline", async () => {
    const { root } = await openWith([ASKED], { agentId: "a1" });
    expect(bubbles(root).length).toBe(0);
  });

  test("leave out the 添付 section when there are none", async () => {
    const { root } = await openWith([{ ...ASKED, attachments: [] }]);
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
    const { root, store, reads, composerOpens } = await openWith([ASKED]);
    const button = grantButton(defined(bubbles(root)[0], "bubble"));
    expect(button.classList.contains("copied")).toBe(false);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(written).toEqual([permitGrantText(ASKED)]);
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.querySelector(".permit-grant-copied")?.getAttribute("aria-hidden")).toBe("false");
    expect(root.querySelector(".permit-grant-error")).toBeNull();
    expect(reads).toEqual([[ASKED.id]]);
    expect(store.getState().permitRequests.map((r) => r.read)).toEqual([true]);
    // DR-0040 §7: the session's input box opens to paste the text into.
    expect(composerOpens()).toBe(1);
    // A request read already is not marked again.
    await act(async () => {
      grantButton(defined(bubbles(root)[0], "bubble")).click();
      await Promise.resolve();
    });
    expect(reads).toEqual([[ASKED.id]]);
  });

  // 何を保証するか: 許可の文には添付を全部並べる。開いていない添付も、開いて
  // 読めなかった添付 (無い、daemon が答えなかった) も並べる。確認したかは人が
  // 判断することで、バブルは開いたかを追わない。
  test("lists every file, opened or not, read or not", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { root } = await openWith([ASKED]);
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
    const { root, reads, composerOpens } = await openWith([ASKED]);
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

  // A request recorded after the tab caught up arrives on its own, and one
  // the catch-up already held (here marked read since) takes its own place
  // rather than being drawn twice.
  test("a request pushed later joins the Timeline once, and a read one takes its place", async () => {
    const { root, store } = await openWith([ASKED]);
    const later = { ...ASKED, id: "i/3", ts: "2026-10-25T00:00:05.000Z", blocked: "later" };
    await act(() => {
      store.dispatch({ type: "permit-requests/updated", request: later });
      store.dispatch({ type: "permit-requests/updated", request: { ...ASKED, read: true } });
    });
    expect(bubbles(root).map((b) => b.querySelector(".permit-section .md")?.textContent)).toEqual([
      "aws s3api put-bucket-policy が止められた",
      "later",
    ]);
    expect(store.getState().permitRequests.map((r) => [r.id, r.read])).toEqual([
      [ASKED.id, true],
      [later.id, false],
    ]);
  });
});
