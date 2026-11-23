// A comment on a quote of a response in a real browser (DR-0062 §2, §3, §12,
// P31): choosing text in a response's markdown brings a 💬 out in the band at
// the right of the item, outside the bubble, at the middle of the choice's
// height; pressing it opens the comment form with the text chosen in its
// head; saving keeps a comment whose anchor is the quote (the row's uuid,
// the response's start, the text chosen and the characters around it); and
// the response then shows the quote highlighted, with a 💬 at the top right
// corner of its last line in a layer over the body (no text added to what the
// response draws).
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes (rows of the shape Claude Code writes) in a
// config dir under the daemon's HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import {
  CommentsFileLineSchema,
  msgStartWithOf,
  parseWith,
  type CommentRecord,
} from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000002";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ANSWER_START = "起動手順を終えました";
// Each browser chooses its own words, so the other's comment is not its.
const CHOSEN: Record<string, string> = {
  chromium: "状態ファイルを書き直す",
  webkit: "未決の問いを並べる",
};
const ANSWER = `${ANSWER_START}。\n\n次は${CHOSEN.chromium ?? ""}ことと、裁定待ちの md に${CHOSEN.webkit ?? ""}ことです。`;

let dir: string;
let webui: Webui;
let session: TestClient;
let commentsFile: string;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-cselect-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  commentsFile = path.join(path.dirname(webui.sock), "sessions", `${SID}.comments.jsonl`);
  const head = { sessionId: SID, cwd };
  const rows = [
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock(ANSWER)], {
      ...head,
      uuid: id(2),
      timestamp: "2020-01-01T00:00:02.000Z",
    }),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
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

/** The comments the daemon kept (its comments file, the last line of a cid
 * winning). */
function keptComments(): CommentRecord[] {
  if (!fs.existsSync(commentsFile)) return [];
  const byCid = new Map<string, CommentRecord>();
  for (const text of fs.readFileSync(commentsFile, "utf8").split("\n")) {
    if (text.trim() === "") continue;
    const read = parseWith(CommentsFileLineSchema, text);
    if (read.ok && read.value.kind === "comment") byCid.set(read.value.cid, read.value);
  }
  return [...byCid.values()];
}

/** Chooses `words` in the response's drawn text, as a person's drag does. */
async function choose(page: Page, words: string): Promise<void> {
  await page.evaluate((target) => {
    const scope = document.querySelector(".tl-bubble-assistant [data-comment-text]");
    if (scope === null) throw new Error("no response's text");
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.nodeValue?.indexOf(target) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + target.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`no ${target} in the response`);
  }, words);
}

for (const engine of BROWSERS) {
  const words = CHOSEN[engine.name()] ?? "";
  describe(`a comment on a quote in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.locator(".tl-bubble-assistant .tl-comment-reply").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "choose → 💬 → the form → save: the quote is kept, highlighted, with a 💬 after it",
      async () => {
        await choose(page, words);
        const button = page.getByRole("button", { name: "選んだ箇所にコメントする" });
        await button.waitFor();
        // In the band at the right of the item, outside the bubble, at the
        // middle of the choice's height.
        const place = await page.evaluate(() => {
          const range = document.getSelection()?.getRangeAt(0);
          const chosen = range?.getBoundingClientRect();
          const bubble = document.querySelector(".tl-bubble-assistant")?.getBoundingClientRect();
          const item = document
            .querySelector(".tl-bubble-assistant")
            ?.closest(".tl-item")
            ?.getBoundingClientRect();
          const at = document.querySelector(".tl-comment-choice")?.getBoundingClientRect();
          if (!chosen || !bubble || !item || !at) return null;
          return {
            middle: chosen.top + chosen.height / 2,
            atMiddle: at.top + at.height / 2,
            atLeft: at.left,
            atRight: at.right,
            bubbleRight: bubble.right,
            itemRight: item.right,
          };
        });
        expect(place).not.toBeNull();
        if (place === null) return;
        expect(Math.abs(place.atMiddle - place.middle)).toBeLessThan(2);
        expect(place.atLeft).toBeGreaterThanOrEqual(place.bubbleRight);
        expect(Math.abs(place.atRight - place.itemRight)).toBeLessThan(2);

        await button.click();
        const form = page.getByRole("dialog", { name: "コメントを書く" });
        await form.waitFor();
        expect(await form.locator(".tl-comment-chosen").textContent()).toBe(words);
        await form.getByRole("textbox", { name: "コメントの本文" }).fill("ここは?");
        const sendNow = form.getByRole("checkbox", { name: "今すぐ送る" });
        if (await sendNow.isChecked()) await sendNow.uncheck();
        await form.getByRole("button", { name: "保存" }).click();
        await form.waitFor({ state: "detached" });

        const kept = keptComments().find(
          (record) => record.anchor.kind === "selection" && record.anchor.text === words,
        );
        expect(kept?.anchor).toMatchObject({
          kind: "selection",
          uuid: id(2),
          msg_start_with: msgStartWithOf(ANSWER),
          text: words,
        });

        // The quote highlighted (the CSS Custom Highlight), and a 💬 after it.
        await page.waitForFunction(
          (count) =>
            (CSS.highlights.get("ccmsg-comment")?.size ?? 0) >= count &&
            document.querySelectorAll(".tl-bubble-assistant .tl-comment-quote-mark").length >=
              count,
          engine.name() === "chromium" ? 1 : 2,
        );
        const highlighted = await page.evaluate(() =>
          [...(CSS.highlights.get("ccmsg-comment") ?? [])].map((range) =>
            range instanceof Range ? range.toString() : "",
          ),
        );
        expect(highlighted).toContain(words);
        // The response draws the same text: the 💬 adds none.
        expect(
          await page.locator(".tl-bubble-assistant [data-comment-text]").first().textContent(),
        ).not.toContain("💬");
        // At the top right corner of the quote's last line (in the gap between
        // the lines, hiding no character after it).
        const after = await page.evaluate((target) => {
          const range = [...(CSS.highlights.get("ccmsg-comment") ?? [])].find(
            (r) => r instanceof Range && r.toString() === target,
          );
          const rects = range instanceof Range ? [...range.getClientRects()] : [];
          const last = rects.at(-1);
          const marks = [...document.querySelectorAll(".tl-comment-quote-mark")].map((el) =>
            el.getBoundingClientRect(),
          );
          return last === undefined
            ? null
            : marks.some(
                (m) => Math.abs(m.left + 6 - last.right) < 4 && Math.abs(m.bottom - last.top) < 4,
              );
        }, words);
        expect(after).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
