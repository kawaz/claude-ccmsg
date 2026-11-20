// The ⭐ filter's bookmarked items outside the window (DR-0058 §5): a row is
// drawn from the lines the daemon read for it, through the window's parse and
// cross-line passes, so it is the item the window would draw.
// - a request for permission is one with its result among the lines, and no
//   item without it
// - a `! <command>` takes its output from the next line
// - a bookmark taken off, or a row in the window, is not listed
import { describe, expect, test } from "bun:test";
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT } from "@ccmsg/protocol";
import { listedBookmarkOf, listedBookmarks } from "../src/client/listed-bookmarks.ts";
import {
  assistantContentRow,
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
    expect(listedBookmarkOf({ uuid: CALL, lines: [call, result] })?.boundary.kind).toBe("permit");
  });

  test("a request without its result is no item", () => {
    expect(listedBookmarkOf({ uuid: CALL, lines: [call] })).toBeNull();
  });

  test("a `! <command>` takes its output from the next line", () => {
    const input = jsonl(userContentRow("<bash-input>ls</bash-input>", { uuid: CALL }));
    const output = jsonl(
      userContentRow("<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>", {
        uuid: RESULT,
      }),
    );
    const item = listedBookmarkOf({ uuid: CALL, lines: [input, output] });
    expect(item?.boundary.kind).toBe("bash-command");
    if (item?.boundary.kind !== "bash-command") return;
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
