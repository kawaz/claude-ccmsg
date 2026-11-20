// 何を保証するか: 読み込んだ量に比例する仕事を、live tail の push のたびにしない
// (docs/findings/2026-11-19-timeline-push-script-cost.md)。
// - push 1 回で描き直す吹き出しは新しい行のものだけで、既存の吹き出しは前の
//   描画のまま (本文の markdown を作り直さない)
// - 同じ値の peers の push (セッションの活動が動くたびに来る) では、どの吹き出しも
//   作り直さない
// 作り直しは、吹き出しの本文の inline code が作る `code` の vnode の中身と、
// 吹き出しが描かれるたびに 1 つ作る足元 (BubbleFooter) の vnode の数で数える
// (preact の options.vnode は vnode が作られるたびに呼ばれる)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, options, type VNode } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { BubbleFooter } from "../src/client/components/timeline/BubbleFooter.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { stubGlobal, stubProperty, peerLocation } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { endOf, FakeTranscriptWs, Mounted, page, SID, uuidOf } from "./timeline-harness.ts";

withDom();

const PEER: PeerInfo = {
  sid: SID,
  ...peerLocation("owner/repo", "main"),
  cwd: "/work/repo",
  transcript_path: "/work/.claude/projects/repo/session.jsonl",
};

const mounted = new Mounted();
let restores: Array<() => void> = [];
/** The text of every inline `code` vnode made since the last reset. */
const built: string[] = [];
/** How many bubbles were drawn since the last reset. */
let footers = 0;

beforeEach(() => {
  built.length = 0;
  footers = 0;
  const previous = options.vnode?.bind(options);
  restores = [
    stubProperty(options, "vnode", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(vnode: VNode) {
        const children: unknown = vnode.props.children;
        if (vnode.type === "code" && typeof children === "string") built.push(children);
        if (vnode.type === BubbleFooter) footers += 1;
        previous?.(vnode);
      },
    }),
    stubGlobal("navigation", { navigate() {} }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

/** A prompt and an answer whose markdown names `src/f<n>.ts` in inline code. */
function exchange(n: number): string[] {
  return [
    jsonl(userContentRow(`question ${n}`, { uuid: uuidOf("u", n) })),
    jsonl(
      assistantContentRow([textBlock(`answer ${n}: see \`src/f${n}.ts\``)], {
        uuid: uuidOf("a", n),
      }),
    ),
  ];
}

async function openTimeline(count: number): Promise<{ store: Store; end: number }> {
  const store = createStore(initialState());
  store.dispatch({ type: "peers/loaded", peers: [PEER] });
  store.dispatch({ type: "conn/status", status: "connected" });
  const ws = new FakeTranscriptWs(store);
  await mounted.mount(
    store,
    ws.handle,
    h(SessionView, { sid: SID, tab: "timeline", agent: null, active: true }),
  );
  const lines = Array.from({ length: count }, (_, i) => exchange(i + 1)).flat();
  await ws.lastRead().answer(page(lines));
  return { store, end: endOf(lines, 0) };
}

describe("a Timeline with bubbles already drawn", () => {
  test("a live-tail push draws the new bubble and builds no other again", async () => {
    const { store, end } = await openTimeline(3);
    expect(built).toContain("src/f3.ts");
    built.length = 0;
    footers = 0;

    await act(() => {
      const lines = exchange(4);
      const next = endOf(lines, end);
      store.dispatch({ type: "timeline/tail", sid: SID, lines, start: end, end: next, size: next });
    });
    expect(built).toContain("src/f4.ts");
    expect(built.filter((code) => code !== "src/f4.ts")).toEqual([]);
    // The prompt and the answer the push brought; none of the six before.
    expect(footers).toBe(2);
  });

  test("a peers push with the same values builds no bubble again", async () => {
    const { store } = await openTimeline(3);
    built.length = 0;
    footers = 0;

    await act(() => {
      store.dispatch({ type: "peers/loaded", peers: [{ ...PEER }] });
    });
    expect(built).toEqual([]);
    expect(footers).toBe(0);
  });
});
