import { describe, expect, test } from "bun:test";
import {
  autoOpenCategoriesForLine,
  defaultTimelineAutoOpen,
  foldGroupShouldAutoOpen,
  parseTimelineAutoOpenSettings,
  segmentAutoOpenCategory,
  timelineAutoOpenStorageKey,
  toggleTimelineAutoOpen,
} from "../src/client/timeline-auto-open.ts";
import { parseTranscriptLine, type TimelineEntry } from "../src/client/transcript-model.ts";
import type { JsonObject } from "@ccmsg/protocol";
import {
  assistantContentRow,
  userContentRow,
  line as jsonl,
} from "../../protocol/test/transcript-rows.ts";

function parsedEntry(offset: number, row: JsonObject): TimelineEntry {
  return { offset, line: parseTranscriptLine(jsonl(row)) };
}

describe("defaultTimelineAutoOpen", () => {
  // 親 TL はユーザ向け思考過程を自動展開するが、agent 通信と外側 items fold は閉じる。
  test("main Timeline defaults to URTE with inner T/E open and outer items closed", () => {
    expect(defaultTimelineAutoOpen(false)).toEqual({
      thinking: true,
      ccmsg: true,
      agent: false,
      edit: true,
      items: false,
    });
  });

  // agent TL は呼び出し元・peer との通信を主情報として自動展開し、その通信を包む
  // 外側 fold も開く。thinking は既定閉で、親 TL と関心対象を反転する。ファイルの
  // 書き換え (E) は親 TL と同じく開く。
  test("agent Timeline defaults to URAE with inner A/E and outer items open", () => {
    expect(defaultTimelineAutoOpen(true)).toEqual({
      thinking: false,
      ccmsg: false,
      agent: true,
      edit: true,
      items: true,
    });
  });

  // T/A の inner 軸と N items の outer 軸は独立。片方の操作が他方を書き換えると、
  // main 既定の T=true/items=false と agent 既定の A=true/items=true を表現できない。
  test("thinking, agent, edit, and items toggles update only their own axis", () => {
    const initial = { thinking: true, ccmsg: true, agent: false, edit: true, items: false };
    expect(toggleTimelineAutoOpen(initial, "agent")).toEqual({
      thinking: true,
      ccmsg: true,
      agent: true,
      edit: true,
      items: false,
    });
    expect(toggleTimelineAutoOpen(initial, "items")).toEqual({
      thinking: true,
      ccmsg: true,
      agent: false,
      edit: true,
      items: true,
    });
    expect(toggleTimelineAutoOpen(initial, "ccmsg")).toEqual({
      thinking: true,
      ccmsg: false,
      agent: false,
      edit: true,
      items: false,
    });
    expect(toggleTimelineAutoOpen(initial, "edit")).toEqual({
      thinking: true,
      ccmsg: true,
      agent: false,
      edit: false,
      items: false,
    });
  });
});

describe("timelineAutoOpenStorageKey", () => {
  // 親 TL は sid のみ、drilldown は sid + agent の複合キーで独立に保存される。
  test("parent Timeline omits the agent segment while a drilldown includes it", () => {
    expect(timelineAutoOpenStorageKey("sess-1", undefined)).toBe("ccmsg.tl.autoOpen.sess-1");
    expect(timelineAutoOpenStorageKey("sess-1", "worker-a")).toBe(
      "ccmsg.tl.autoOpen.sess-1/worker-a",
    );
  });

  // 別 agent は別 key = 独立した保存領域を持つ。
  test("different agents on the same session get different keys", () => {
    expect(timelineAutoOpenStorageKey("sess-1", "worker-a")).not.toBe(
      timelineAutoOpenStorageKey("sess-1", "worker-b"),
    );
  });
});

describe("parseTimelineAutoOpenSettings", () => {
  const fallback = defaultTimelineAutoOpen(false);

  // 保存値なし (初回訪問) はその Timeline の既定 (= defaultTimelineAutoOpen の結果)。
  test("missing key is the Timeline's default", () => {
    expect(parseTimelineAutoOpenSettings(null, false)).toEqual(fallback);
    expect(parseTimelineAutoOpenSettings(null, true)).toEqual(defaultTimelineAutoOpen(true));
  });

  // 保存済みの妥当な JSON はそのまま復元される。
  test("valid stored JSON is restored as-is", () => {
    const stored = { thinking: false, ccmsg: true, agent: true, edit: false, items: false };
    expect(parseTimelineAutoOpenSettings(JSON.stringify(stored), false)).toEqual(stored);
  });

  // edit を持たない保存値は他のトグルをそのまま保ち、edit だけその Timeline の
  // 既定になる (ユーザが切り替えた T/C/A/items を失わない)。
  test("stored value without edit keeps its toggles and takes the default edit", () => {
    const stored = { thinking: false, ccmsg: true, agent: true, items: false };
    expect(parseTimelineAutoOpenSettings(JSON.stringify(stored), false)).toEqual({
      ...stored,
      edit: defaultTimelineAutoOpen(false).edit,
    });
    expect(parseTimelineAutoOpenSettings(JSON.stringify(stored), true)).toEqual({
      ...stored,
      edit: defaultTimelineAutoOpen(true).edit,
    });
  });

  // 壊れた JSON / 型不一致 / 欠損フィールドは保存値を丸ごと無視して既定に戻る
  // (一部だけ採らない)。
  test("corrupt or malformed stored values are ignored for the Timeline's default", () => {
    expect(parseTimelineAutoOpenSettings("not json", false)).toEqual(fallback);
    expect(parseTimelineAutoOpenSettings("42", false)).toEqual(fallback);
    expect(parseTimelineAutoOpenSettings("null", false)).toEqual(fallback);
    expect(parseTimelineAutoOpenSettings("[]", false)).toEqual(fallback);
    expect(
      parseTimelineAutoOpenSettings(JSON.stringify({ thinking: true, ccmsg: true }), false),
    ).toEqual(fallback);
    expect(
      parseTimelineAutoOpenSettings(
        JSON.stringify({ thinking: "yes", ccmsg: true, agent: true, items: true }),
        true,
      ),
    ).toEqual(defaultTimelineAutoOpen(true));
    expect(
      parseTimelineAutoOpenSettings(
        JSON.stringify({ thinking: false, ccmsg: true, agent: true, edit: "yes", items: true }),
        false,
      ),
    ).toEqual(fallback);
  });
});

describe("segmentAutoOpenCategory", () => {
  // T/A/E の inner-details 制御対象だけを返す。通常 tool はカテゴリ外なので checkbox
  // 操作で勝手に開閉されない。
  test("thinking is T, agent spawn/send are A, Edit/Write are E, others are uncategorized", () => {
    expect(segmentAutoOpenCategory({ kind: "thinking", text: "inspect" })).toBe("T");
    // 本文が無くても fold は thinking と同じ枠なので、T の開閉に追従する。
    expect(segmentAutoOpenCategory({ kind: "thinking-hidden", reason: "redacted" })).toBe("T");
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
    expect(
      segmentAutoOpenCategory({
        kind: "file-edit",
        path: "/repo/a.ts",
        oldString: "a",
        newString: "b",
      }),
    ).toBe("E");
    expect(segmentAutoOpenCategory({ kind: "file-write", path: "/repo/a.ts", content: "a" })).toBe(
      "E",
    );
    expect(
      segmentAutoOpenCategory({
        kind: "file-read",
        toolUseId: "t",
        path: "/repo/a.ts",
        offset: null,
        limit: null,
        result: null,
      }),
    ).toBeNull();
    expect(
      segmentAutoOpenCategory({
        kind: "tool-use",
        toolUseId: "t",
        name: "Read",
        input: {},
        result: null,
      }),
    ).toBeNull();
  });
});

const edit = parsedEntry(
  3,
  assistantContentRow([
    {
      type: "tool_use",
      id: "toolu_edit",
      name: "Edit",
      input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
    },
  ]),
);
const write = parsedEntry(
  4,
  assistantContentRow([
    {
      type: "tool_use",
      id: "toolu_write",
      name: "Write",
      input: { file_path: "/repo/a.ts", content: "a" },
    },
  ]),
);
const read = parsedEntry(
  5,
  assistantContentRow([
    { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/a.ts" } },
  ]),
);

describe("autoOpenCategoriesForLine", () => {
  // U/R は fold されない境界だが、UI のカテゴリ定義を pure 判定として固定する。
  test("human prompt is U and assistant text response is R", () => {
    const user = parseTranscriptLine(jsonl(userContentRow("hello")));
    const response = parseTranscriptLine(
      jsonl(assistantContentRow([{ type: "text", text: "done" }])),
    );
    expect(autoOpenCategoriesForLine(user)).toEqual(new Set(["U"]));
    expect(autoOpenCategoriesForLine(response)).toEqual(new Set(["R"]));
  });

  // 会話本文を持つ peer relay は A。idle_notification は運用ノイズなので、既存の
  // agentCommunicationCount と同じく A には含めず通常 items のままにする。
  test("non-idle peer relay is A while idle notification is uncategorized", () => {
    const peer = parseTranscriptLine(
      jsonl(userContentRow('<agent-message from="worker">done</agent-message>')),
    );
    const idle = parseTranscriptLine(
      jsonl(
        userContentRow(
          '<teammate-message teammate_id="worker">{"type":"idle_notification","from":"worker","idleReason":"available"}</teammate-message>',
        ),
      ),
    );
    expect(autoOpenCategoriesForLine(peer)).toEqual(new Set(["A"]));
    expect(autoOpenCategoriesForLine(idle)).toEqual(new Set());
  });

  // Edit / Write の呼び出しを持つ行は E。Read は書き換えないのでカテゴリ外。
  test("Edit and Write calls are E while Read is uncategorized", () => {
    expect(autoOpenCategoriesForLine(edit.line)).toEqual(new Set(["E"]));
    expect(autoOpenCategoriesForLine(write.line)).toEqual(new Set(["E"]));
    expect(autoOpenCategoriesForLine(read.line)).toEqual(new Set());
  });
});

describe("foldGroupShouldAutoOpen", () => {
  const thinking = parsedEntry(1, assistantContentRow([{ type: "thinking", thinking: "inspect" }]));
  const agent = parsedEntry(
    2,
    assistantContentRow([
      {
        type: "tool_use",
        id: "toolu_0001",
        name: "SendMessage",
        input: { to: "worker", message: "go" },
      },
    ]),
  );

  // N items は T/A を包む FoldGroup を開くためのゲートにすぎず、T/A が
  // 一致しなければ fold は開かない。
  test("N items gates only an outer FoldGroup containing enabled T/A", () => {
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: true,
        ccmsg: true,
        agent: false,
        edit: false,
        items: false,
      }),
    ).toBe(false);
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: true,
        ccmsg: false,
        agent: false,
        edit: false,
        items: true,
      }),
    ).toBe(true);
    expect(
      foldGroupShouldAutoOpen([agent], {
        thinking: false,
        ccmsg: false,
        agent: true,
        edit: false,
        items: true,
      }),
    ).toBe(true);
    expect(
      foldGroupShouldAutoOpen([thinking], {
        thinking: false,
        ccmsg: false,
        agent: true,
        edit: false,
        items: true,
      }),
    ).toBe(false);
    expect(
      foldGroupShouldAutoOpen([thinking, agent], {
        thinking: false,
        ccmsg: false,
        agent: false,
        edit: false,
        items: true,
      }),
    ).toBe(false);
  });

  // E も T/A と同じく N items をゲートにして外側の fold を開く。Read だけの
  // fold は E を持たないので開かない。
  test("an enabled E opens an outer FoldGroup containing Edit or Write", () => {
    const settings = { thinking: false, ccmsg: false, agent: false, edit: true, items: true };
    expect(foldGroupShouldAutoOpen([read, edit], settings)).toBe(true);
    expect(foldGroupShouldAutoOpen([write], settings)).toBe(true);
    expect(foldGroupShouldAutoOpen([read], settings)).toBe(false);
    expect(foldGroupShouldAutoOpen([edit], { ...settings, edit: false })).toBe(false);
    expect(foldGroupShouldAutoOpen([edit], { ...settings, items: false })).toBe(false);
  });
});
