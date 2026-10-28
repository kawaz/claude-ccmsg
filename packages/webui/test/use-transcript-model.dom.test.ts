// Timeline が描くものを transcript の行から導く hook をマウントして、契約を
// 固定する。
// - useTranscriptModel: 境界の行 (発話・最終応答) は単独の entry、その間は
//   fold group にまとまる。追記では手を付けていない group をそのまま引き継ぎ
//   (memo された FoldGroup が描き直されない)、older で前に足しても既存の行の
//   offset は変わらない。項目ごとの元 jsonl を offset で引ける
// - useSayRead: このセッションの未読の say だけが既読ボタンを持ち、TL に出て
//   いる未読の最新のボタンがその全部を既読にする (agent TL の say は既読の管理
//   の外)。既読にできなかった理由を次に成功するまで残す
import { afterEach, describe, expect, test } from "bun:test";
import { defined } from "./helpers.ts";
import { h, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import type { UnreadSay } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import type { WsHandle } from "../src/client/ws.ts";
import { useSayRead } from "../src/client/components/timeline/useSayRead.ts";
import { useTranscriptModel } from "../src/client/components/timeline/useTranscriptModel.ts";
import type { BoundaryKind, TimelineGroup } from "../src/client/transcript-model.ts";
import {
  assistantContentRow,
  line as jsonl,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";
import { endOf, exchange, FakeTranscriptWs, SID, timelineStore } from "./timeline-harness.ts";

withDom();

let unmounts: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
});

function track<P, R>(hook: RenderedHook<P, R>): RenderedHook<P, R> {
  unmounts.push(hook.unmount);
  return hook;
}

/** 発話・thinking 2 つ・最終応答の 1 往復。thinking の 2 行が 1 つの fold group になる。 */
function turnWithThinking(n: number): string[] {
  return [
    jsonl(userContentRow(`question ${n}`)),
    jsonl(assistantContentRow([{ type: "thinking", thinking: `hmm ${n}` }])),
    jsonl(assistantContentRow([{ type: "thinking", thinking: `more ${n}` }])),
    jsonl(assistantContentRow([{ type: "text", text: `answer ${n}` }])),
  ];
}

function kinds(groups: readonly TimelineGroup[]): string[] {
  return groups.map((group) => group.kind);
}

describe("useTranscriptModel", () => {
  test("boundary lines stand alone and the lines between them fold into one group", async () => {
    const lines = turnWithThinking(1);
    const hook = track(await renderHook(useTranscriptModel, { lines, start: 0 }));
    const model = hook.current();
    expect(kinds(model.groups)).toEqual(["entry", "fold", "entry"]);
    expect(model.boundaries.map((b) => b?.kind ?? null)).toEqual([
      "user-prompt",
      null,
      "assistant-response",
    ]);
    expect(model.parsed).toHaveLength(4);
    expect(model.offsets[0]).toBe(0);
  });

  test("an append keeps every untouched group and the visible ccmsg key set", async () => {
    const first = turnWithThinking(1);
    const hook = track(await renderHook(useTranscriptModel, { lines: first, start: 0 }));
    const before = hook.current();
    await hook.rerender({ lines: [...first, ...turnWithThinking(2)], start: 0 });
    const after = hook.current();
    expect(kinds(after.groups)).toEqual(["entry", "fold", "entry", "entry", "fold", "entry"]);
    for (let i = 0; i < before.groups.length; i++) {
      expect(after.groups[i]).toBe(before.groups[i]);
    }
    expect(after.visibleCcmsgKeys).toBe(before.visibleCcmsgKeys);
  });

  test("older lines put in front leave the offsets of the loaded lines as they were", async () => {
    const older = exchange(1);
    const newer = exchange(2);
    const start = endOf(older, 0);
    const hook = track(await renderHook(useTranscriptModel, { lines: newer, start }));
    const offsetsBefore = hook.current().offsets;
    await hook.rerender({ lines: [...older, ...newer], start: 0 });
    expect(hook.current().offsets.slice(2)).toEqual([...offsetsBefore]);
    expect(hook.current().offsets[0]).toBe(0);
  });

  test("each item's jsonl rows are found by the item's offset", async () => {
    const lines = exchange(1);
    const hook = track(await renderHook(useTranscriptModel, { lines, start: 0 }));
    const { offsets, itemRawLookup } = hook.current();
    const answerOffset = defined(offsets[1], "the answer's offset");
    const sources = itemRawLookup.sources.get(answerOffset) ?? [];
    expect(sources).toEqual([answerOffset]);
    expect(itemRawLookup.rows.get(answerOffset)?.text).toBe(defined(lines[1], "the answer row"));
  });
});

describe("useSayRead", () => {
  function unread(id: string, sid: string): UnreadSay {
    return { session_id: sid, tool_use_id: id, ts: "2026-10-09T01:00:00.000Z" };
  }
  const say = (id: string): BoundaryKind => ({ kind: "say", text: `said ${id}`, toolUseId: id });
  // TL の並び: toolu_1 (未読)、境界でない group、toolu_2 (既読)、toolu_3 (未読)。
  const BOUNDARIES: ReadonlyArray<BoundaryKind | null> = [
    say("toolu_1"),
    null,
    say("toolu_2"),
    say("toolu_3"),
  ];

  async function mountRead(
    sayRead: WsHandle["sayRead"],
    props: { agentTimeline: boolean; boundaries: ReadonlyArray<BoundaryKind | null> },
  ) {
    const store = timelineStore();
    const fake = new FakeTranscriptWs(store);
    const ws: WsHandle = { ...fake.handle, sayRead };
    store.dispatch({
      type: "say-unread/loaded",
      says: [unread("toolu_1", SID), unread("toolu_9", "someone-else"), unread("toolu_3", SID)],
    });
    const wrap = (child: ComponentChild) => h(AppContext.Provider, { value: { store, ws } }, child);
    return track(
      await renderHook((p: typeof props) => useSayRead({ sid: SID, ...p }), props, { wrap }),
    );
  }

  const noReply: WsHandle["sayRead"] = () => Promise.reject(new Error("no socket"));

  type SayRead = ReturnType<typeof useSayRead>;

  /** say ごとの既読の状態を、比べられる形 (未読なら既読にする id) にしたもの。 */
  function states(hook: { current: () => SayRead }, ids: string[]) {
    return ids.map((id) => {
      const state = hook.current().readState(id);
      return state.kind === "unread" ? [id, state.ids] : [id, state.kind];
    });
  }

  test("this session's unread says carry their 既読 targets; the rest are read", async () => {
    const hook = await mountRead(noReply, { agentTimeline: false, boundaries: BOUNDARIES });
    expect(states(hook, ["toolu_1", "toolu_2", "toolu_3", "toolu_9"])).toEqual([
      ["toolu_1", ["toolu_1"]],
      ["toolu_2", "read"],
      ["toolu_3", ["toolu_1", "toolu_3"]],
      // 別セッションの未読は、この TL では未読ではない。
      ["toolu_9", "read"],
    ]);
  });

  // 読み込み済みの window に無い未読は「すべて既読」に入れない (押した時に TL
  // に出ているものだけ)。
  test("an unread say outside the loaded window is not among the targets", async () => {
    const hook = await mountRead(noReply, {
      agentTimeline: false,
      boundaries: [say("toolu_3")],
    });
    expect(states(hook, ["toolu_3"])).toEqual([["toolu_3", ["toolu_3"]]]);
  });

  test("an agent Timeline keeps its says out of read tracking", async () => {
    const hook = await mountRead(noReply, { agentTimeline: true, boundaries: BOUNDARIES });
    expect(states(hook, ["toolu_1", "toolu_2", "toolu_3"])).toEqual([
      ["toolu_1", "untracked"],
      ["toolu_2", "untracked"],
      ["toolu_3", "untracked"],
    ]);
  });

  function press(hook: { current: () => SayRead }, id: string): void {
    const state = hook.current().readState(id);
    if (state.kind !== "unread") throw new Error(`${id} is not unread`);
    state.onRead(state.ids);
  }

  test("a failed read is reported until a later read succeeds", async () => {
    let reply: Awaited<ReturnType<WsHandle["sayRead"]>> = {
      ok: false,
      error: { code: "invalid_args", msg: "no such say" },
    };
    const hook = await mountRead(() => Promise.resolve(reply), {
      agentTimeline: false,
      boundaries: BOUNDARIES,
    });
    await act(async () => {
      press(hook, "toolu_1");
      await Promise.resolve();
    });
    expect(hook.current().readError).toBe("no such say");

    reply = { ok: true, ids: ["toolu_1"] };
    await act(async () => {
      press(hook, "toolu_1");
      await Promise.resolve();
    });
    expect(hook.current().readError).toBeNull();
  });

  test("a read that cannot be sent says the connection failed", async () => {
    const hook = await mountRead(noReply, { agentTimeline: false, boundaries: BOUNDARIES });
    await act(async () => {
      press(hook, "toolu_1");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.current().readError).toBe("接続エラーのため既読にできませんでした");
  });
});
