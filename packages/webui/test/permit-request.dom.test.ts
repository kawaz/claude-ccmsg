// 許可依頼バブル (usePermitBubbles + PermitRequestBubble) を Timeline に
// マウントして、読み手に見えるものと「許可する」が写すものを固定する。
// - そのセッションの依頼だけが出る (別セッションの依頼、agent TL には出ない)
// - 止められた行動・Attachments (読めたものは折り畳み、読めないものは理由)・
//   許可してほしいこと (intent とコマンド) の節を出し、Attachments が無ければ
//   その節を出さない
// - 「許可する」は許可の文をクリップボードに写し、写せたら「コピーしました」
//   を出す。写せなければそう言う
// - 後から届いた依頼 (ev:"permit_request") が同じ TL に足される
// daemon の代わりに、store へ ev:"permit_requests" / ev:"permit_request" と
// 同じ action を流す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { PermitRequestRecord } from "@ccmsg/protocol";
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
  attachments: [
    {
      path: "/w/policy.json",
      read: true,
      content: '{"Statement":[]}\n',
      bytes: 17,
      truncated: false,
    },
    { path: "/w/gone.sh", read: false, reason: "missing" },
  ],
  intents: ["`/w/a.ts` の編集"],
  commands: ["aws s3api put-bucket-policy --bucket b --policy file://policy.json"],
};

async function openWith(
  requests: readonly PermitRequestRecord[],
  agent?: AgentRef,
): Promise<{
  root: HTMLElement;
  store: Store;
}> {
  const store = timelineStore(agent !== undefined ? { agent } : {});
  store.dispatch({ type: "permit-requests/loaded", requests: [...requests] });
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(
    store,
    ws.handle,
    h(TimelineOf, agent !== undefined ? { agent } : {}),
  );
  await ws.lastRead().answer(page([]));
  return { root, store };
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  restores.push(stubProperty(navigator, "clipboard", { value: { writeText }, configurable: true }));
}

function bubbles(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".permit")];
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
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      "Attachments",
      "許可してほしいこと",
    ]);
    expect(shown.querySelector(".permit-section .md")?.textContent).toContain(
      "aws s3api put-bucket-policy が止められた",
    );
    // A file read is folded, closed; one that could not be is a line with why.
    const folded = defined(shown.querySelector("details.permit-attachment"), "details");
    expect(folded.hasAttribute("open")).toBe(false);
    expect(folded.querySelector("summary")?.textContent).toBe("/w/policy.json");
    expect(folded.querySelector("pre")?.textContent).toBe('{"Statement":[]}\n');
    expect(shown.querySelector(".permit-attachment-unreadable")?.textContent).toBe(
      "/w/gone.shファイルが無い",
    );
    const asks = [...shown.querySelectorAll(".permit-asks > li")].map((li) => li.textContent);
    expect(asks).toEqual([
      "/w/a.ts の編集",
      "aws s3api put-bucket-policy --bucket b --policy file://policy.jsonの実行",
    ]);
  });

  // The subagent's Timeline shows that subagent's transcript; the request is
  // the session's, asked by its main thread.
  test("are not shown in a subagent's Timeline", async () => {
    const { root } = await openWith([ASKED], { agentId: "a1" });
    expect(bubbles(root).length).toBe(0);
  });

  test("leave out the Attachments section when there are none", async () => {
    const { root } = await openWith([{ ...ASKED, attachments: [] }]);
    const shown = defined(bubbles(root)[0], "bubble");
    expect([...shown.querySelectorAll(".permit-heading")].map((el) => el.textContent)).toEqual([
      "止められた行動",
      "許可してほしいこと",
    ]);
  });

  test("許可する copies the permission and says it did", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { root } = await openWith([ASKED]);
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
  });

  test("says so when the permission could not be copied", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    const { root } = await openWith([ASKED]);
    const button = grantButton(defined(bubbles(root)[0], "bubble"));
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.classList.contains("copied")).toBe(false);
    expect(root.querySelector(".permit-grant-error")?.textContent).toContain(
      "コピーできませんでした",
    );
  });

  // A request recorded after the tab caught up arrives on its own, and one
  // the catch-up already held is not drawn twice.
  test("a request pushed later joins the Timeline once", async () => {
    const { root, store } = await openWith([ASKED]);
    const later = { ...ASKED, id: "i/3", ts: "2026-10-25T00:00:05.000Z", blocked: "later" };
    await act(() => {
      store.dispatch({ type: "permit-requests/added", request: later });
      store.dispatch({ type: "permit-requests/added", request: ASKED });
    });
    expect(bubbles(root).map((b) => b.querySelector(".permit-section .md")?.textContent)).toEqual([
      "aws s3api put-bucket-policy が止められた",
      "later",
    ]);
  });
});
