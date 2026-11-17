// agent (subagent / workflow の agent / teammate) の TL が、セッション本体の TL と
// 同じく開いている間 live に伸びることを、Timeline をマウントして固定する
// (DR-0025 §4 / §6)。
//
// 経路: agent の TL は開いている間その agent の transcript を transcript_subscribe
// で購読し (transcript_read と同じ agent_id / run_id / teammate で名指す)、daemon
// は module が push した agent の行を合図にその agent の jsonl を読んで、
// `ev:"transcript"` に購読と同じ agent の field を付けて届ける。ws.ts はそれを
// agent 付きの `timeline/tail` にし、store はその agent の TL を出している cache
// にだけ、セッション本体の TL と同じ続きの判定 (届いた行の start が cache の end
// と一致する時だけ足す。ずれていれば `after` で追いつく) で足す。
//
// happy-dom はレイアウトをしないので、scroller (`.timeline-view`) の高さは項目数
// から決まるように差し替える (1 項目 100px、表示領域 200px)。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { AGENT_APPEND_MARK } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { endOf, FakeTranscriptWs, Mounted, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const ITEM_PX = 100;
const VIEWPORT_PX = 200;

const mounted = new Mounted();
let restores: Array<() => void> = [];
let layoutRestores: Array<() => void> = [];

function isScroller(el: HTMLElement): boolean {
  return el.classList.contains("timeline-view");
}

beforeAll(() => {
  const proto = HTMLElement.prototype;
  layoutRestores = [
    stubProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this)
          ? this.querySelectorAll("[data-timeline-uuid]").length * ITEM_PX
          : 0;
      },
    }),
    stubProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? VIEWPORT_PX : 0;
      },
    }),
    stubProperty(proto, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? this.scrollTop;
      },
    }),
  ];
});

afterAll(() => {
  for (const restore of layoutRestores.reverse()) restore();
  layoutRestores = [];
});

beforeEach(() => {
  localStorage.clear();
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

const AGENT_ID = "a0123456789abcdef";
const AGENT: AgentRef = { agentId: AGENT_ID };
const SIDECHAIN = { isSidechain: true, agentId: AGENT_ID };

function TimelineOf({ agent, active }: { agent: AgentRef | null; active: boolean }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent,
    active,
    visible: true,
  });
}

interface View {
  store: Store;
  ws: FakeTranscriptWs;
  root: HTMLElement;
  rerender(props: { active: boolean }): Promise<void>;
}

/** The agent's TL (the locator names the agent, as the URL `/s/<sid>/timeline/agent/…`
 * does), opened and answered with `lines` for its first read. */
async function openAgent(lines: readonly string[]): Promise<View> {
  const store = timelineStore({ agent: AGENT });
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, { agent: AGENT, active: true }));
  await ws.lastRead().answer(page(lines));
  return {
    store,
    ws,
    root,
    rerender: (next) =>
      mounted.rerender(store, ws.handle, h(TimelineOf, { agent: AGENT, ...next })),
  };
}

function loadedEnd(store: Store): number {
  return defined(store.getState().sessionTrees.get(SID), "session tree").timeline.end;
}

/** An `ev:"transcript"` push, as ws.ts turns it into an action: of the agent
 * `agent`, or of the session's own transcript when absent. */
async function tail(
  store: Store,
  lines: readonly string[],
  start: number,
  agent?: AgentRef,
): Promise<void> {
  const end = endOf(lines, start);
  await act(() =>
    store.dispatch({
      type: "timeline/tail",
      sid: SID,
      ...(agent !== undefined ? { agent } : {}),
      lines: [...lines],
      start,
      end,
      size: end,
    }),
  );
}

function scroller(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".timeline-view"), HTMLElement, "scroller");
}

function spawnRow(): string {
  return jsonl(
    userContentRow("調べて報告して", {
      ...SIDECHAIN,
      uuid: "00000000-0000-4000-8000-000000000101",
      parentUuid: null,
    }),
  );
}

function answerRow(text: string, uuid: string): string {
  return jsonl(assistantContentRow([textBlock(text)], { ...SIDECHAIN, uuid }));
}

/** module の `agent.append` が足した、人の文の行 (実 transcript と同じ形)。 */
function personRow(body: string, uuid: string): string {
  return jsonl(
    userContentRow([textBlock(`${AGENT_APPEND_MARK}\n${body}`)], {
      ...SIDECHAIN,
      uuid,
      isMeta: true,
      origin: { kind: "plugin", name: "ccmsg" },
    }),
  );
}

const FIRST = [
  spawnRow(),
  answerRow("一つ目の報告", "00000000-0000-4000-8000-000000000102"),
  answerRow("二つ目の報告", "00000000-0000-4000-8000-000000000103"),
];

function occurrences(root: HTMLElement, text: string): number {
  return (root.textContent ?? "").split(text).length - 1;
}

describe("an agent Timeline follows its live tail", () => {
  test("opening it subscribes to that agent's transcript, not the session's", async () => {
    const view = await openAgent(FIRST);
    expect(view.ws.subscribes).toEqual([]);
    expect(view.ws.agentSubscribes).toEqual([{ sid: SID, agent: { agent_id: AGENT_ID } }]);
  });

  // FAB から agent に送った文は、module が足した行が agent の jsonl に書かれて
  // push で届き、開き直しや「更新」なしで吹き出しとして出る。push で届いた行は
  // 初回の読みの行と同じ parse を通るので、印の行は出ず本文だけが出る。末尾に
  // 付いている読み手には、セッション本体の TL と同じく末尾まで追従する。
  test("a pushed line of the agent is appended, and a person's message shows as a bubble at the bottom", async () => {
    const view = await openAgent(FIRST);
    const el = scroller(view.root);
    expect(el.scrollTop).toBe(el.scrollHeight);

    await tail(
      view.store,
      [personRow("その方針で進めて", "00000000-0000-4000-8000-000000000104")],
      loadedEnd(view.store),
      AGENT,
    );
    const bubble = [...view.root.querySelectorAll(".tl-bubble-right .tl-bubble-body")].find(
      (body) => (body.textContent ?? "").includes("その方針で進めて"),
    );
    expect(bubble).toBeDefined();
    expect(view.root.textContent).not.toContain(AGENT_APPEND_MARK);
    expect(el.scrollTop).toBe(el.scrollHeight);
    // 新しい行の分だけ伸びた (読み直しはしていない)。
    expect(view.ws.reads).toHaveLength(1);
  });

  // agent の TL の cache が持つのはその agent の transcript だけ。セッション本体の
  // 行や別の agent の行の push (切り替える前の購読の残りが遅れて届く等) は、
  // byte offset がたまたま続いていても足さない。
  test("pushes of the session's own transcript and of another agent are not appended", async () => {
    const view = await openAgent(FIRST);
    const end = loadedEnd(view.store);
    await tail(view.store, [answerRow("本体の行", "00000000-0000-4000-8000-000000000201")], end);
    await tail(
      view.store,
      [answerRow("別の agent の行", "00000000-0000-4000-8000-000000000202")],
      end,
      { agentId: "a9999999999999999" },
    );
    expect(view.root.textContent).not.toContain("本体の行");
    expect(view.root.textContent).not.toContain("別の agent の行");
    expect(loadedEnd(view.store)).toBe(end);
  });

  // 戻ってきた時の追いつき (`after` の読み) と push が同じ行を運んでも二重に出ない:
  // 先に push が足した行の後ろから続かない読みの答えは足さずに、push の後ろから
  // 読み直す (セッション本体の TL と同じ続きの判定)。
  test("a line brought by both a push and the catch-up read shows once", async () => {
    const view = await openAgent(FIRST);
    const end = loadedEnd(view.store);
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    const catchUp = view.ws.lastRead();
    expect(catchUp.opts).toEqual({ agent_id: AGENT_ID, after: end });

    const line = answerRow("三つ目の報告", "00000000-0000-4000-8000-000000000105");
    await tail(view.store, [line], end, AGENT);
    await catchUp.answer(page([line], end));
    const resync = view.ws.lastRead();
    expect(resync.opts).toEqual({ agent_id: AGENT_ID, after: endOf([line], end) });
    await resync.answer(page([], endOf([line], end)));
    expect(occurrences(view.root, "三つ目の報告")).toBe(1);
  });

  test("leaving the Timeline unsubscribes the agent", async () => {
    const view = await openAgent(FIRST);
    await view.rerender({ active: false });
    await act(() => Promise.resolve());
    expect(view.ws.agentUnsubscribes).toEqual([{ sid: SID, agent: { agent_id: AGENT_ID } }]);
  });
});
