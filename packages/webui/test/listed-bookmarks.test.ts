// The ⭐ filter's bookmarked items outside the window (DR-0058 §5): a row is
// drawn from the lines the daemon read for it, through the window's parse and
// cross-line passes, so it is the item the window would draw.
// - a request for permission is one with its result among the lines; without
//   it, the call is a fold's row
// - a `! <command>` takes its output from the next line
// - a bookmark taken off, or a row in the window, is not listed
// - the prompts among rows (landedPromptsOf, DR-0035 §5) are the rows the
//   Timeline draws as the person's prompt, each with its text as written (a
//   list's text blocks, one per line) and its time; other rows, and a prompt
//   without a time, are not among them
import { describe, expect, test } from "bun:test";
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT } from "@ccmsg/protocol";
import {
  landedPromptsOf,
  listedBookmarkOf,
  listedBookmarks,
} from "../src/client/listed-bookmarks.ts";
import {
  assistantContentRow,
  imageBlock,
  line as jsonl,
  textBlock,
  toolResultBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";

const CALL = "a0000000-0000-4000-8000-000000000001";
const RESULT = "a0000000-0000-4000-8000-000000000002";

const call = jsonl(
  assistantContentRow(
    [
      {
        type: "tool_use",
        id: "toolu_p",
        name: CCMSG_TOOLS.permit,
        input: { blocked: "b", intents: ["y"] },
      },
    ],
    { uuid: CALL },
  ),
);
const result = jsonl(
  userContentRow([toolResultBlock(PERMIT_REQUESTED_TEXT, { tool_use_id: "toolu_p" })], {
    uuid: RESULT,
  }),
);

describe("listedBookmarkOf", () => {
  test("a request for permission with its result is the request's item", () => {
    expect(listedBookmarkOf({ uuid: CALL, lines: [call, result] })?.boundary?.kind).toBe("permit");
  });

  // Without the result that makes it a request, the call is a fold's row
  // (DR-0058 §2: a fold's rows are positions too), drawn as the window draws it.
  test("a request without its result is the call's fold row", () => {
    const item = listedBookmarkOf({ uuid: CALL, lines: [call] });
    expect(item?.uuid).toBe(CALL);
    expect(item?.boundary).toBeNull();
  });

  test("a `! <command>` takes its output from the next line", () => {
    const input = jsonl(userContentRow("<bash-input>ls</bash-input>", { uuid: CALL }));
    const output = jsonl(
      userContentRow("<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>", {
        uuid: RESULT,
      }),
    );
    const item = listedBookmarkOf({ uuid: CALL, lines: [input, output] });
    expect(item?.boundary?.kind).toBe("bash-command");
    if (item?.boundary?.kind !== "bash-command") return;
    expect(item.boundary.segment.command).toBe("ls");
    expect(item.boundary.segment.output?.stdout).toBe("a.txt");
  });
});

describe("listedBookmarks", () => {
  test("lists the rows bookmarked still and not in the window", () => {
    const answer = jsonl(assistantContentRow([textBlock("old")], { uuid: RESULT }));
    const rows = [
      { uuid: CALL, lines: [call, result] },
      { uuid: RESULT, lines: [answer] },
    ];
    expect(listedBookmarks(rows, new Set([CALL, RESULT]), new Set()).map((i) => i.uuid)).toEqual([
      CALL,
      RESULT,
    ]);
    expect(listedBookmarks(rows, new Set([RESULT]), new Set()).map((i) => i.uuid)).toEqual([
      RESULT,
    ]);
    expect(
      listedBookmarks(rows, new Set([CALL, RESULT]), new Set([CALL])).map((i) => i.uuid),
    ).toEqual([RESULT]);
  });
});

describe("landedPromptsOf", () => {
  const AT = "2026-11-22T01:00:30.000Z";
  const rowOf = (uuid: string, content: Parameters<typeof userContentRow>[0], fields = {}) => ({
    uuid,
    lines: [jsonl(userContentRow(content, { uuid, timestamp: AT, ...fields }))],
  });

  test("the prompts with their text as written and their time", () => {
    expect(
      landedPromptsOf([
        rowOf(CALL, "go on\n\n  indented"),
        rowOf(RESULT, [textBlock("look"), imageBlock(), textBlock("here")]),
      ]),
    ).toEqual([
      { text: "go on\n\n  indented", at: AT },
      { text: "look\nhere", at: AT },
    ]);
  });

  test("rows the Timeline does not draw as a prompt, and a prompt without a time, are left out", () => {
    const { timestamp: _dropped, ...noTime } = userContentRow("no time", { uuid: CALL });
    expect(
      landedPromptsOf([
        rowOf(CALL, "<bash-input>ls</bash-input>"),
        { uuid: CALL, lines: [jsonl(noTime)] },
        rowOf(RESULT, [toolResultBlock("x", { tool_use_id: "toolu_x" })]),
      ]),
    ).toEqual([]);
  });
});
