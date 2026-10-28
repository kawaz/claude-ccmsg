// say バブル (transcript の `say` の tool_use、DR-0045 §7) と既読ボタン
// (useSayRead + SayCallBubble) を Timeline にマウントして、読み手に見える文言と
// 押した時に既読になるものを固定する。
// - say の行は境界の 🔔 バブルになり、本文は書かれた原文のまま
// - 未読 (ev:"say_unread" に居る tool_use id) は 🔔 と既読ボタン、それ以外は
//   🔕 と「既読」。既読になってもバブルの見た目 (class) は同じ
// - 未読が複数ある時、最新の未読のボタンだけ「N 件すべて既読」。古いものを
//   押すとその 1 件だけ、最新を押すと TL に出ている未読の全部が既読になる
// - 未読が 1 件だけなら「既読」
// - 別タブでの既読 (ev:"say_unread" の更新) でも 🔕 になる
// - subagent の TL の say は 🔕 で、既読の欄を持たない
// daemon の代わりに、say_read で受けた id を未読から抜いた全件を
// ev:"say_unread" と同じ経路 (say-unread/loaded) で store に戻す。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { CCMSG_TOOLS, type UnreadSay } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { useStoreState } from "../src/client/useStore.ts";
import type { Store } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { assistantContentRow, line as jsonl } from "../../protocol/test/transcript-rows.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore, uuidOf } from "./timeline-harness.ts";

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

function TimelineOf({ agent }: { agent: AgentRef | null }) {
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
    active: true,
    visible: true,
  });
}

/** n 番目の say の tool_use id。 */
function toolUseId(n: number): string {
  return `toolu_${n}`;
}

/** `say` を呼んだ assistant の行。本文は既定で `said <n>`。 */
function sayRow(n: number, text = `said ${n}`): string {
  return jsonl(
    assistantContentRow(
      [{ type: "tool_use", id: toolUseId(n), name: CCMSG_TOOLS.say, input: { text } }],
      { uuid: uuidOf("a", n), timestamp: `2026-10-25T00:00:0${n}.000Z` },
    ),
  );
}

function unreadOf(n: number, sid = SID): UnreadSay {
  return { session_id: sid, tool_use_id: toolUseId(n), ts: `2026-10-25T00:00:0${n}.000Z` };
}

/** Timeline を `rows` の transcript と `unread` の未読で開き、既読の要求を
 * daemon のように store へ返す。 */
async function openWith(
  rows: readonly string[],
  unread: readonly UnreadSay[],
  agent: AgentRef | null = null,
): Promise<{ root: HTMLElement; store: Store; acks: Array<readonly string[]> }> {
  const store = timelineStore(agent === null ? {} : { agent });
  store.dispatch({ type: "say-unread/loaded", says: [...unread] });
  const ws = new FakeTranscriptWs(store);
  const acks: Array<readonly string[]> = [];
  const handle = {
    ...ws.handle,
    sayRead: (ids: readonly string[]) => {
      acks.push(ids);
      const targets = new Set(ids);
      store.dispatch({
        type: "say-unread/loaded",
        says: store.getState().unreadSays.filter((say) => !targets.has(say.tool_use_id)),
      });
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, { agent }));
  await ws.lastRead().answer(page(rows));
  return { root, store, acks };
}

/** 各 say バブルの本文と、既読の欄に見える文言 (ボタンは `[…]` で囲む。欄が
 * 無ければ null)。 */
function readControls(root: HTMLElement): Array<[string, string | null]> {
  return [...root.querySelectorAll(".say")].map((bubble) => {
    const body = bubble.querySelector(".say-body")?.textContent ?? "";
    const button = bubble.querySelector(".say-read-btn");
    if (button !== null) return [body, `[${button.textContent ?? ""}]`];
    return [body, bubble.querySelector(".say-read-done")?.textContent ?? null];
  });
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

function unreadIds(store: Store): string[] {
  return store.getState().unreadSays.map((say) => say.tool_use_id);
}

/** 各 say バブルの本文とアイコン。 */
function icons(root: HTMLElement): Array<[string, string]> {
  return [...root.querySelectorAll(".say")].map((bubble) => [
    bubble.querySelector(".say-body")?.textContent ?? "",
    bubble.querySelector(".say-icon")?.textContent ?? "",
  ]);
}

describe("say bubbles", () => {
  // 読み上げの辞書は daemon の発声にだけ当たる。TL は書かれたままを見せ、
  // markdown らしい文字も整形しない。
  test("a say call is a boundary bubble with its text as written", async () => {
    const { root } = await openWith([sayRow(1, "**ビルド** 終わった <ok>")], [unreadOf(1)]);
    expect(icons(root)).toEqual([["**ビルド** 終わった <ok>", "🔔"]]);
    expect(root.querySelector(".say .say-from")?.textContent).toBe("say");
    expect(root.querySelector(".say .say-time")?.textContent).not.toBe("");
  });

  test("show a bell while unread and a muted bell once read, in the same bubble", async () => {
    const { root } = await openWith([sayRow(1), sayRow(2)], [unreadOf(1), unreadOf(2)]);
    expect(icons(root)).toEqual([
      ["said 1", "🔔"],
      ["said 2", "🔔"],
    ]);
    const before = [...root.querySelectorAll(".say")].map((el) => el.className);
    await press(root, "said 1");
    expect(icons(root)).toEqual([
      ["said 1", "🔕"],
      ["said 2", "🔔"],
    ]);
    expect([...root.querySelectorAll(".say")].map((el) => el.className)).toEqual(before);
  });

  // 別セッションの未読は数に入らない (この TL に出ていない say を既読にしない)。
  // 未読に居ない say は既読。
  test("with three unread, only the newest button acks them all", async () => {
    const { root } = await openWith(
      [sayRow(1), sayRow(2), sayRow(3), sayRow(4)],
      [unreadOf(1), unreadOf(2), unreadOf(5, "someone-else"), unreadOf(4)],
    );
    expect(readControls(root)).toEqual([
      ["said 1", "[既読]"],
      ["said 2", "[既読]"],
      ["said 3", "既読"],
      ["said 4", "[3 件すべて既読]"],
    ]);
    expect(icons(root).map(([, icon]) => icon)).toEqual(["🔔", "🔔", "🔕", "🔔"]);
  });

  test("an older button acks its own say only, by its tool_use id", async () => {
    const { root, store, acks } = await openWith(
      [sayRow(1), sayRow(2), sayRow(3)],
      [unreadOf(1), unreadOf(2), unreadOf(3)],
    );
    await press(root, "said 1");
    expect(acks).toEqual([["toolu_1"]]);
    expect(unreadIds(store)).toEqual(["toolu_2", "toolu_3"]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "[既読]"],
      ["said 3", "[2 件すべて既読]"],
    ]);
  });

  test("the newest button acks every unread say the Timeline shows", async () => {
    const { root, store, acks } = await openWith(
      [sayRow(1), sayRow(2), sayRow(3)],
      [unreadOf(1), unreadOf(2), unreadOf(5, "someone-else"), unreadOf(3)],
    );
    await press(root, "said 3");
    expect(acks).toEqual([["toolu_1", "toolu_2", "toolu_3"]]);
    expect(unreadIds(store)).toEqual(["toolu_5"]);
    expect([...root.querySelectorAll(".say-read-btn")]).toEqual([]);
  });

  // 読み込み済みの行に無い未読 (toolu_9) は、押した時に TL に出ていないので
  // 「すべて既読」に入らず未読のまま残る。
  test("an unread say outside the loaded rows stays unread", async () => {
    const { root, store, acks } = await openWith(
      [sayRow(1), sayRow(2)],
      [unreadOf(9), unreadOf(1), unreadOf(2)],
    );
    expect(readControls(root)).toEqual([
      ["said 1", "[既読]"],
      ["said 2", "[2 件すべて既読]"],
    ]);
    await press(root, "said 2");
    expect(acks).toEqual([["toolu_1", "toolu_2"]]);
    expect(unreadIds(store)).toEqual(["toolu_9"]);
  });

  test("a lone unread say keeps the plain button", async () => {
    const { root, acks } = await openWith([sayRow(1), sayRow(2)], [unreadOf(2)]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "[既読]"],
    ]);
    await press(root, "said 2");
    expect(acks).toEqual([["toolu_2"]]);
  });

  // 別タブで既読にされた: このタブは押していないが、daemon の全件の更新で
  // その say が未読から抜け、🔕 になってボタンが消える。
  test("a say read in another tab turns muted here on the say_unread update", async () => {
    const { root, store, acks } = await openWith(
      [sayRow(1), sayRow(2)],
      [unreadOf(1), unreadOf(2)],
    );
    await act(() => {
      store.dispatch({ type: "say-unread/loaded", says: [unreadOf(2)] });
    });
    expect(acks).toEqual([]);
    expect(icons(root)).toEqual([
      ["said 1", "🔕"],
      ["said 2", "🔔"],
    ]);
    expect(readControls(root)).toEqual([
      ["said 1", "既読"],
      ["said 2", "[既読]"],
    ]);
  });

  // subagent の say は未読に入らない (DR-0045 §7)。同じ id が未読に居ても、
  // agent TL では既読の管理の外として 🔕 で出し、既読の欄を持たない。
  test("a subagent's say is muted with no read control", async () => {
    const { root, acks } = await openWith([sayRow(1)], [unreadOf(1)], { agentId: "ag" });
    expect(icons(root)).toEqual([["said 1", "🔕"]]);
    expect(readControls(root)).toEqual([["said 1", null]]);
    expect(acks).toEqual([]);
  });
});
