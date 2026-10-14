// Timeline が描くものを transcript の行から導く hook をマウントして、契約を
// 固定する。
// - useTranscriptModel: 境界の行 (発話・最終応答) は単独の entry、その間は
//   fold group にまとまる。追記では手を付けていない group をそのまま引き継ぎ
//   (memo された FoldGroup が描き直されない)、older で前に足しても既存の行の
//   offset は変わらない。項目ごとの元 jsonl を offset で引ける
// - useSayBubbles: このセッションの say だけを時刻の位置に差し込み (agent TL
//   には出さない)、既読にできなかった理由を次に成功するまで残す
import { afterEach, describe, expect, test } from "bun:test";
import { h, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import type { SayRecord } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import type { WsHandle } from "../src/client/ws.ts";
import { useSayBubbles } from "../src/client/components/timeline/useSayBubbles.ts";
import { useTranscriptModel } from "../src/client/components/timeline/useTranscriptModel.ts";
import type { TimelineGroup } from "../src/client/transcript-model.ts";
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
    const answerOffset = offsets[1];
    const sources = itemRawLookup.sources.get(answerOffset) ?? [];
    expect(sources).toEqual([answerOffset]);
    expect(itemRawLookup.rows.get(answerOffset)?.text).toBe(lines[1]);
  });
});

describe("useSayBubbles", () => {
  function sayAt(id: string, sid: string, ts: string): SayRecord {
    return { id, sid, text: `said ${id}`, ts, read: false };
  }

  async function mountSays(
    sayRead: WsHandle["sayRead"],
    props: { agentTimeline: boolean; groups: readonly TimelineGroup[] },
  ) {
    const store = timelineStore();
    const fake = new FakeTranscriptWs(store);
    const ws: WsHandle = { ...fake.handle, sayRead };
    store.dispatch({
      type: "says/loaded",
      says: [
        sayAt("i/1", SID, "2026-10-09T01:00:00.000Z"),
        sayAt("i/2", "someone-else", "2026-10-09T01:00:00.000Z"),
        sayAt("i/3", SID, "2027-01-01T00:00:00.000Z"),
      ],
    });
    const wrap = (child: ComponentChild) => h(AppContext.Provider, { value: { store, ws } }, child);
    return track(
      await renderHook((p: typeof props) => useSayBubbles({ sid: SID, ...p }), props, { wrap }),
    );
  }

  const noReply: WsHandle["sayRead"] = () => Promise.reject(new Error("no socket"));

  test("only this session's says, each in the slot before the first newer group", async () => {
    const hook = await mountSays(noReply, { agentTimeline: false, groups: [] });
    expect(hook.current().says.map((r) => r.id)).toEqual(["i/1", "i/3"]);
    // group が無ければ slot は末尾の 1 つだけで、全部そこに入る。
    expect(hook.current().slots.map((slot) => slot.map((r) => r.id))).toEqual([["i/1", "i/3"]]);
  });

  test("an agent Timeline shows none", async () => {
    const hook = await mountSays(noReply, { agentTimeline: true, groups: [] });
    expect(hook.current().says).toEqual([]);
  });

  test("a failed read is reported until a later read succeeds", async () => {
    let reply: Awaited<ReturnType<WsHandle["sayRead"]>> = {
      ok: false,
      error: { code: "not_found", msg: "no such say" },
    };
    const hook = await mountSays(() => Promise.resolve(reply), {
      agentTimeline: false,
      groups: [],
    });
    await act(async () => {
      hook.current().markRead("i/1");
      await Promise.resolve();
    });
    expect(hook.current().readError).toBe("no such say");

    reply = { ok: true, id: "i/1" };
    await act(async () => {
      hook.current().markRead("i/1");
      await Promise.resolve();
    });
    expect(hook.current().readError).toBeNull();
  });

  test("a read that cannot be sent says the connection failed", async () => {
    const hook = await mountSays(noReply, { agentTimeline: false, groups: [] });
    await act(async () => {
      hook.current().markRead("i/1");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.current().readError).toBe("接続エラーのため既読にできませんでした");
  });
});
