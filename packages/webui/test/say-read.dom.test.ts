// say バブルの既読ボタン (useSayBubbles + SayRecordBubble) を Timeline に
// マウントして、読み手に見える文言と押した時に既読になるものを固定する。
// - 未読が複数ある時、最新の未読のボタンだけ「N 件すべて既読」
// - 古いものを押すとその 1 件だけ、最新を押すと未読の全部が既読になる
// - 未読が 1 件だけなら従来の「既読」
// daemon の代わりに、say_read で受けた id を既読にした全件を ev:"says" と同じ
// 経路 (says/loaded) で store に戻す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { SayRecord } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { useStoreState } from "../src/client/useStore.ts";
import type { Store } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
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

function sayAt(n: number, sid = SID): SayRecord {
  return { id: `i/${n}`, sid, text: `said ${n}`, ts: `2026-10-25T00:00:0${n}.000Z`, read: false };
}

/** Timeline を `says` 付きで開き、既読の要求を daemon のように store へ返す。 */
async function openWith(says: readonly SayRecord[]): Promise<{
  root: HTMLElement;
  store: Store;
  acks: Array<readonly string[]>;
}> {
  const store = timelineStore();
  store.dispatch({ type: "says/loaded", says: [...says] });
  const ws = new FakeTranscriptWs(store);
  const acks: Array<readonly string[]> = [];
  const handle = {
    ...ws.handle,
    sayRead: (ids: readonly string[]) => {
      acks.push(ids);
      const targets = new Set(ids);
      store.dispatch({
        type: "says/loaded",
        says: store.getState().says.map((r) => (targets.has(r.id) ? { ...r, read: true } : r)),
      });
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, null));
  await ws.lastRead().answer(page([]));
  return { root, store, acks };
}

/** 各 say バブルの本文と、既読の欄に見える文言。 */
function readControls(root: HTMLElement): Array<[string, string]> {
  return [...root.querySelectorAll(".say")].map((bubble) => [
    bubble.querySelector(".say-body")?.textContent ?? "",
    bubble.querySelector(".say-read-btn, .say-read-done")?.textContent ?? "",
  ]);
}

async function press(root: HTMLElement, body: string): Promise<void> {
  const bubble = [...root.querySelectorAll(".say")].find(
    (el) => el.querySelector(".say-body")?.textContent === body,
  );
  const button = instanceOf(
    bubble?.querySelector(".say-read-btn"),
    HTMLButtonElement,
    "read button",
  );
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function readFlags(store: Store): Array<[string, boolean]> {
  return store.getState().says.map((r) => [r.id, r.read]);
}

describe("say read buttons", () => {
  // 別セッションの未読は数に入らない (この TL に出ていない say を既読にしない)。
  test("with three unread, only the newest button acks them all", async () => {
    const { root } = await openWith([sayAt(1), sayAt(2), sayAt(4, "someone-else"), sayAt(3)]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "既読"],
      ["said 3", "3 件すべて既読"],
    ]);
  });

  test("an older button acks its own say only", async () => {
    const { root, store, acks } = await openWith([sayAt(1), sayAt(2), sayAt(3)]);
    await press(root, "said 1");
    expect(acks).toEqual([["i/1"]]);
    expect(readFlags(store)).toEqual([
      ["i/1", true],
      ["i/2", false],
      ["i/3", false],
    ]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "既読"],
      ["said 3", "2 件すべて既読"],
    ]);
  });

  test("the newest button acks every unread say of the session", async () => {
    const { root, store, acks } = await openWith([
      sayAt(1),
      sayAt(2),
      sayAt(4, "someone-else"),
      sayAt(3),
    ]);
    await press(root, "said 3");
    expect(acks).toEqual([["i/1", "i/2", "i/3"]]);
    expect(readFlags(store)).toEqual([
      ["i/1", true],
      ["i/2", true],
      ["i/4", false],
      ["i/3", true],
    ]);
    expect([...root.querySelectorAll(".say-read-btn")]).toEqual([]);
  });

  test("a lone unread say keeps the plain button", async () => {
    const { root, acks } = await openWith([{ ...sayAt(1), read: true }, sayAt(2)]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "既読"],
    ]);
    await press(root, "said 2");
    expect(acks).toEqual([["i/2"]]);
  });
});
