import { describe, expect, test } from "bun:test";
import {
  autoOpenCategoriesForLine,
  defaultTimelineAutoOpen,
  foldGroupShouldAutoOpen,
  segmentAutoOpenCategory,
  toggleTimelineAutoOpen,
} from "../src/client/timeline-auto-open.ts";
import { parseTranscriptLine, type TimelineEntry } from "../src/client/transcript-model.ts";

function parsedEntry(offset: number, raw: Record<string, unknown>): TimelineEntry {
  return { offset, line: parseTranscriptLine(JSON.stringify(raw)) };
}

describe("defaultTimelineAutoOpen", () => {
  // 親 TL はユーザ向け思考過程を自動展開するが、agent 通信と外側 items fold は閉じる。
  test("main Timeline defaults to URT with inner T open and outer items closed", () => {
    expect(defaultTimelineAutoOpen(false)).toEqual({
      thinking: true,
      ccmsg: true,
      agent: false,
      items: false,
    });
  });

  // agent TL は呼び出し元・peer との通信を主情報として自動展開し、その通信を包む
  // 外側 fold も開く。thinking は既定閉で、親 TL と関心対象を反転する。
  test("agent Timeline defaults to URA with inner A and outer items open", () => {
    expect(defaultTimelineAutoOpen(true)).toEqual({
      thinking: false,
      ccmsg: false,
      agent: true,
      items: true,
    });
  });

  // T/A の inner 軸と N items の outer 軸は独立。片方の操作が他方を書き換えると、
  // main 既定の T=true/items=false と agent 既定の A=true/items=true を表現できない。
  test("thinking, agent, and items toggles update only their own axis", () => {
    const initial = { thinking: true, ccmsg: true, agent: false, items: false };
    expect(toggleTimelineAutoOpen(initial, "agent")).toEqual({
      thinking: true,
      ccmsg: true,
      agent: true,
      items: false,
    });
    expect(toggleTimelineAutoOpen(initial, "items")).toEqual({
      thinking: true,
      ccmsg: true,
      agent: false,
      items: true,
    });
    expect(toggleTimelineAutoOpen(initial, "ccmsg")).toEqual({
      thinking: true,
      ccmsg: false,
      agent: false,
      items: false,
    });
  });
});

describe("segmentAutoOpenCategory", () => {
  // T/A の inner-details 制御対象だけを返す。通常 tool はカテゴリ外なので checkbox
  // 操作で勝手に開閉されない。
  test("thinking is T, agent spawn/send are A, ordinary tools are uncategorized", () => {
    expect(segmentAutoOpenCategory({ kind: "thinking", text: "inspect" })).toBe("T");
    expect(
      segmentAutoOpenCategory({
        kind: "agent-send",
        to: "worker",
        summary: null,
        message: "go",
        messageType: "message",
      }),
    ).toBe("A");
    expect(
      segmentAutoOpenCategory({
        kind: "agent-spawn",
        name: "worker",
        agentType: "Explore",
        model: "",
        description: "調査",
        prompt: "inspect",
        background: true,
      }),
    ).toBe("A");
    expect(segmentAutoOpenCategory({ kind: "tool-use", name: "Read", input: {} })).toBeNull();
  });
});

describe("autoOpenCategoriesForLine", () => {
  // U/R は fold されない境界だが、UI のカテゴリ定義を pure 判定として固定する。
  test("human prompt is U and assistant text response is R", () => {
    const user = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    );
    const response = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    expect(autoOpenCategoriesForLine(user)).toEqual(new Set(["U"]));
    expect(autoOpenCategoriesForLine(response)).toEqual(new Set(["R"]));
  });

  // 会話本文を持つ peer relay は A。idle_notification は運用ノイズなので、既存の
  // agentCommunicationCount と同じく A には含めず通常 items のままにする。
  test("non-idle peer relay is A while idle notification is uncategorized", () => {
    const peer = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: { content: '<agent-message from="worker">done</agent-message>' },
      }),
    );
    const idle = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content:
            '<teammate-message teammate_id="worker">{"type":"idle_notification","from":"worker","idleReason":"available"}</teammate-message>',
        },
      }),
    );
    expect(autoOpenCategoriesForLine(peer)).toEqual(new Set(["A"]));
    expect(autoOpenCategoriesForLine(idle)).toEqual(new Set());
  });
});

describe("foldGroupShouldAutoOpen", () => {
  const thinking = parsedEntry(1, {
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "inspect" }] },
  });
  const agent = parsedEntry(2, {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "SendMessage", input: { to: "worker", message: "go" } }],
    },
  });

  // N items は T/A を包む外側 FoldGroup だけを開くためのゲート。内側の
  // ItemsSubFold を一斉展開する設定ではなく、T/A が一致しなければ外側も開かない。
  test("N items gates only an outer FoldGroup containing enabled T/A", () => {
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: true,
        ccmsg: true,
        agent: false,
        items: false,
      }),
    ).toBe(false);
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: true,
        ccmsg: false,
        agent: false,
        items: true,
      }),
    ).toBe(true);
    expect(
      foldGroupShouldAutoOpen([agent], { thinking: false, ccmsg: false, agent: true, items: true }),
    ).toBe(true);
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: false,
        ccmsg: false,
        agent: true,
        items: true,
      }),
    ).toBe(false);
    expect(
      foldGroupShouldAutoOpen([thinking, agent], {
        thinking: false,
        ccmsg: false,
        agent: false,
        items: true,
      }),
    ).toBe(false);
  });
});
