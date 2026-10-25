// Timeline をマウントして、transcript の行の種類ごとに読み手に見えるものを
// 固定する。fold group の中身まで描かせるため、auto open をすべて開いた状態で
// 開く (外側の fold も thinking / agent / ccmsg / Edit も開く)。
// - ファイル / Bash の tool、agent の起動と送信、thinking が fold の中に出る
// - ccmsg のメッセージは、ユーザ発はバブル、peer 発は fold の中に出る
// - system 発の行 (task-notification) と API エラーは、それと分かる形で出る
// - 項目ごとの jsonl トグルで元の JSONL 行を出し、pretty で整形できる
// - fork 地点の区切り線と、選択中の項目に対する fork / dump の操作が出る
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { ForkOrigin } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineAutoOpenStorageKey } from "../src/client/timeline-auto-open.ts";
import { useStoreState } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  assistantRow,
  line as jsonl,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore, uuidOf } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    timelineAutoOpenStorageKey(SID, undefined),
    JSON.stringify({ thinking: true, ccmsg: true, agent: true, edit: true, items: true }),
  );
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

async function openWith(
  lines: readonly string[],
  options: {
    origin?: ForkOrigin;
    position?: string;
    launchAvailable?: boolean;
    /** The session's own peers row, for what a fork reads off it. */
    cwd?: string;
  } = {},
): Promise<HTMLElement> {
  const store = timelineStore(options.position === undefined ? {} : { position: options.position });
  if (options.launchAvailable) store.dispatch({ type: "launch/availability", available: true });
  if (options.cwd !== undefined) {
    store.dispatch({
      type: "peers/loaded",
      peers: [{ sid: SID, repo: "app", ws: "main", cwd: options.cwd }],
    });
  }
  const ws = new FakeTranscriptWs(store);
  ws.origin = options.origin ?? null;
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, null));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page(lines));
  return root;
}

function teammateMessage(from: string, mid: number, msg: string): string {
  const event = { type: "msg", mid, from, r: "r1", ts: "2026-10-09T01:02:03.456Z", msg };
  return `Another Claude session sent a message:\n<teammate-message teammate_id="${from}">\n${JSON.stringify(event)}\n</teammate-message>`;
}

/** 発話、tool / agent / thinking を挟んで最終応答、の 1 往復。 */
function busyExchange(): string[] {
  return [
    jsonl(userContentRow("please look", { uuid: uuidOf("u", 1) })),
    jsonl(
      assistantContentRow([
        { type: "thinking", thinking: "considering the files" },
        toolUseBlock("Read", { file_path: "src/a.ts" }, "tu_read"),
      ]),
    ),
    jsonl(
      userContentRow([toolResultBlock("1\talpha", { tool_use_id: "tu_read" })], {
        toolUseResult: { type: "text", file: { filePath: "src/a.ts", content: "alpha\n" } },
      }),
    ),
    jsonl(
      assistantContentRow([
        toolUseBlock("Bash", { command: "printf ok", description: "Print result" }, "tu_bash"),
      ]),
    ),
    jsonl(userContentRow([toolResultBlock("ok", { tool_use_id: "tu_bash" })])),
    jsonl(
      assistantContentRow([
        toolUseBlock(
          "Agent",
          {
            name: "audit",
            subagent_type: "Explore",
            description: "構造調査",
            prompt: "対象を読んで報告",
          },
          "tu_agent",
        ),
      ]),
    ),
    jsonl(
      assistantContentRow([
        toolUseBlock(
          "SendMessage",
          { to: "reviewer", summary: "確認依頼", message: "見てください" },
          "tu_send",
        ),
      ]),
    ),
    jsonl(userContentRow(teammateMessage("a7", 5, "peer says hello"))),
    jsonl(assistantContentRow([textBlock("all done")], { uuid: uuidOf("a", 1) })),
  ];
}

describe("Timeline renders each kind of row", () => {
  test("tools, agents and thinking show inside the opened fold group", async () => {
    const root = await openWith(busyExchange());
    const text = root.textContent ?? "";
    expect(text).toContain("please look");
    expect(text).toContain("all done");
    expect(text).toContain("considering the files");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("printf ok");
    expect(text).toContain("audit");
    expect(text).toContain("構造調査");
    expect(text).toContain("reviewer");
    expect(text).toContain("見てください");
    expect(text).toContain("peer says hello");
  });

  test("a message from the user over ccmsg is a bubble of its own", async () => {
    const root = await openWith([
      jsonl(userContentRow(teammateMessage("u1", 3, "from the user via ccmsg"))),
      jsonl(assistantContentRow([textBlock("ok")])),
    ]);
    expect(root.textContent).toContain("from the user via ccmsg");
  });

  test("a task notification and a cut-short turn are shown as what they are", async () => {
    const root = await openWith([
      jsonl(userContentRow("start")),
      jsonl(
        userContentRow(
          "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: watch</summary>\n</task-notification>",
          { origin: { kind: "task-notification" } },
        ),
      ),
      jsonl(
        assistantRow({
          isApiErrorMessage: true,
          message: {
            id: "msg_err",
            type: "message",
            role: "assistant",
            model: "<synthetic>",
            content: [textBlock("API Error: overloaded")],
            stop_reason: "stop_sequence",
            stop_sequence: "",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      ),
    ]);
    const text = root.textContent ?? "";
    expect(text).toContain("Monitor event: watch");
    expect(text).toContain("API Error: overloaded");
  });

  test("an item's jsonl toggle shows the line it came from, raw or pretty", async () => {
    const lines = [jsonl(userContentRow("show me raw", { uuid: uuidOf("u", 1) }))];
    const root = await openWith(lines);
    const toggle = instanceOf(root.querySelector(".tl-item-raw-toggle"), HTMLElement, "toggle");
    await act(() => toggle.click());
    expect(root.textContent).toContain('"type":"user"');
    const pretty = [...root.querySelectorAll("button")].find((b) => b.textContent === "pretty");
    await act(() => defined(pretty, "pretty tab").click());
    expect(root.textContent).toContain('"type": "user"');
    // raw / pretty は全 Timeline 共通の設定なので、次のテストのために戻す。
    const raw = [...root.querySelectorAll("button")].find((b) => b.textContent === "raw");
    await act(() => defined(raw, "raw tab").click());
  });

  test("a fork shows where the copied history ends", async () => {
    const lines = [
      jsonl(userContentRow("copied", { uuid: uuidOf("u", 1) })),
      jsonl(assistantContentRow([textBlock("copied answer")], { uuid: uuidOf("a", 1) })),
      jsonl(userContentRow("mine", { uuid: uuidOf("u", 2) })),
      jsonl(assistantContentRow([textBlock("my answer")], { uuid: uuidOf("a", 2) })),
    ];
    const root = await openWith(lines, {
      origin: { sid: "ancestor", boundary_uuid: uuidOf("a", 1), copied: 2 },
    });
    await act(() => Promise.resolve());
    const divider = root.querySelector(".tl-fork-divider");
    expect(divider).not.toBeNull();
    const text = root.textContent ?? "";
    const at = text.indexOf(divider?.textContent ?? "\0");
    expect(text.indexOf("copied answer")).toBeLessThan(at);
    expect(text.indexOf("mine")).toBeGreaterThan(at);
  });

  test("an assistant bubble's menu offers fork and dump for the selected item", async () => {
    // メニューは選択中の項目にだけ開く。URL の書き換えはこのテストでは store に
    // 戻らないので、その項目を選んだ状態で開く。
    const root = await openWith(
      [
        jsonl(userContentRow("q", { uuid: uuidOf("u", 1) })),
        jsonl(assistantContentRow([textBlock("answer")], { uuid: uuidOf("a", 1) })),
      ],
      { position: uuidOf("a", 1), launchAvailable: true },
    );
    const menu = root.querySelector(".tl-msg-menu-toggle");
    await act(() => instanceOf(menu, HTMLElement, "bubble menu").click());
    expect(root.querySelector(".tl-msg-menu")).not.toBeNull();
    const text = root.textContent ?? "";
    expect(text).not.toContain("launcher) が設定されていません");
    expect(text).toContain("fork");
    expect(text).toContain("この項目以降を dump");
  });

  // The link carries everything the form opens with (DR-0018 §3.9's fork
  // prefill), so it opens the same fork when pasted or reopened later.
  test("ここから fork opens the form as a fork of this session at the selected record", async () => {
    const navigated: string[] = [];
    restores.push(stubGlobal("navigation", { navigate: (url: string) => navigated.push(url) }));
    const root = await openWith(
      [
        jsonl(userContentRow("q", { uuid: uuidOf("u", 1) })),
        jsonl(assistantContentRow([textBlock("answer")], { uuid: uuidOf("a", 1) })),
      ],
      { position: uuidOf("a", 1), launchAvailable: true, cwd: "/repos/app/main" },
    );
    const menu = root.querySelector(".tl-msg-menu-toggle");
    await act(() => instanceOf(menu, HTMLElement, "bubble menu").click());
    const keep = [...root.querySelectorAll(".tl-float-action")].find((b) =>
      b.textContent?.includes("まで残して fork"),
    );
    await act(() => instanceOf(keep, HTMLElement, "fork button").click());
    const url = new URL(defined(navigated.at(-1), "navigation"), "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "sb.panel": "new",
      "sb.type": "fork",
      "sb.resume_session_id": SID,
      "sb.resume_at": uuidOf("a", 1),
      "sb.cwd": "/repos/app/main",
    });
  });

  test("without launch_available the menu offers no fork", async () => {
    const root = await openWith(
      [jsonl(assistantContentRow([textBlock("answer")], { uuid: uuidOf("a", 1) }))],
      { position: uuidOf("a", 1) },
    );
    const menu = root.querySelector(".tl-msg-menu-toggle");
    await act(() => instanceOf(menu, HTMLElement, "bubble menu").click());
    expect(root.textContent).toContain("launcher) が設定されていません");
    expect(root.querySelector(".tl-float-fork")).toBeNull();
  });
});
