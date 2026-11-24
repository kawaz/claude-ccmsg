// Where an item's 💬N stands in a real browser (DR-0062 P8, kawaz 2026-11-24):
// outside its bubble, not among the item's top right controls (「jsonl ☆」).
// A bubble at the left (an agent's response) has it just right of the bubble,
// its top at the bubble's top; a bubble at the right (a comment sent) has it
// just left of the bubble. At a phone's width, where the band beside the
// bubble may be too narrow, it still keeps off 「jsonl ☆」.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript and a comments file the test writes under the daemon's HOME and
// state dir. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { commentsPromptText, msgStartWithOf, type UserComment } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000003";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ANSWER =
  "起動手順を終えました。次は状態ファイルを書き直すことと、裁定待ちの md に未決の問いを並べることです。";

let dir: string;
let webui: Webui;
let session: TestClient;

/** A comment of the person's, delivered in the row `row`. */
function delivered(
  cid: string,
  anchor: UserComment["anchor"],
  body: string,
  at: string,
  row: string,
): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: SID,
    anchor,
    body,
    btw: false,
    written: { at, after_uuid: id(2) },
    updated_at: at,
    status: "delivered",
    sent: { at, after_uuid: id(2) },
    row_uuid: row,
  };
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-cmark-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  // The response has one comment (c0001), and that comment, sent, one
  // reply (c0002): both bubbles carry 💬1.
  const comments = [
    delivered(
      "c0001",
      { kind: "message", uuid: id(2), msg_start_with: msgStartWithOf(ANSWER) },
      "一つ目のコメント",
      "2020-01-01T00:00:03.000Z",
      id(3),
    ),
    delivered(
      "c0002",
      { kind: "comment", cid: "c0001" },
      "返信のコメント",
      "2020-01-01T00:00:04.000Z",
      id(4),
    ),
  ];
  const rows = [
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock(ANSWER)], {
      ...head,
      uuid: id(2),
      timestamp: "2020-01-01T00:00:02.000Z",
    }),
    userContentRow(
      commentsPromptText([
        {
          comment: "c0001",
          on: { kind: "msg_start_with", value: msgStartWithOf(ANSWER) },
          body: "一つ目のコメント",
        },
      ]),
      { ...head, uuid: id(3), timestamp: "2020-01-01T00:00:03.000Z" },
    ),
    userContentRow(
      commentsPromptText([
        { comment: "c0002", on: { kind: "comment", value: "c0001" }, body: "返信のコメント" },
      ]),
      { ...head, uuid: id(4), timestamp: "2020-01-01T00:00:04.000Z" },
    ),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  const commentsFile = path.join(path.dirname(webui.sock), "sessions", `${SID}.comments.jsonl`);
  fs.mkdirSync(path.dirname(commentsFile), { recursive: true });
  fs.writeFileSync(commentsFile, comments.map((c) => `${JSON.stringify(c)}\n`).join(""));
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface MarkPlace {
  mark: Box;
  bubble: Box;
  corner: Box[];
}

/** The 💬N of the item whose bubble matches `bubble`, the bubble (the body
 * the 返信 row is in), and the item's 「jsonl ☆」. */
async function markOf(page: Page, bubble: string): Promise<MarkPlace | null> {
  return page.evaluate((selector) => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const item = [...document.querySelectorAll(".tl-item:has(> .tl-item-comments)")].find(
      (el) => el.querySelector(selector) !== null,
    );
    const mark = item?.querySelector(":scope > .tl-item-comments");
    const body = item?.querySelector(":has(> .tl-comment-reply-row)");
    if (!item || !mark || !body) return null;
    return {
      mark: box(mark),
      bubble: box(body),
      corner: [...item.querySelectorAll(":scope > :is(.tl-item-raw-toggle, .tl-item-star)")].map(
        box,
      ),
    };
  }, bubble);
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const ANSWER_BUBBLE = ".tl-bubble-assistant";
const SENT_BUBBLE = ".tl-bubble-right";

for (const engine of BROWSERS) {
  describe(`an item's 💬N in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.locator(".tl-item-comments").nth(1).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a response's: just right of its bubble, at its top, off 「jsonl ☆」",
      async () => {
        const at = await markOf(page, ANSWER_BUBBLE);
        expect(at).not.toBeNull();
        if (at === null) return;
        expect(at.mark.left).toBeGreaterThanOrEqual(at.bubble.right);
        expect(at.mark.left - at.bubble.right).toBeLessThan(8);
        expect(Math.abs(at.mark.top - at.bubble.top)).toBeLessThan(1);
        for (const corner of at.corner) expect(overlaps(at.mark, corner)).toBe(false);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a sent comment's: just left of its bubble, at its top",
      async () => {
        const at = await markOf(page, SENT_BUBBLE);
        expect(at).not.toBeNull();
        if (at === null) return;
        expect(at.mark.right).toBeLessThanOrEqual(at.bubble.left);
        expect(at.bubble.left - at.mark.right).toBeLessThan(8);
        expect(Math.abs(at.mark.top - at.bubble.top)).toBeLessThan(1);
        for (const corner of at.corner) expect(overlaps(at.mark, corner)).toBe(false);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "at a phone's width both keep off 「jsonl ☆」 and stay on screen",
      async () => {
        // A page opened at a phone's width (the sidebar folded, as on a phone).
        const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await phone.goto(`${webui.url}s/${SID}/timeline/head`);
        await phone.locator(".tl-item-comments").nth(1).waitFor();
        for (const bubble of [ANSWER_BUBBLE, SENT_BUBBLE]) {
          const at = await markOf(phone, bubble);
          expect(at).not.toBeNull();
          if (at === null) return;
          for (const corner of at.corner) expect(overlaps(at.mark, corner)).toBe(false);
          expect(at.mark.left).toBeGreaterThanOrEqual(0);
          expect(at.mark.right).toBeLessThanOrEqual(390);
        }
        await phone.close();
      },
      E2E_TIMEOUT_MS,
    );
  });
}
