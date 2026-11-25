// A comment on a quote in a file in a real browser (DR-0062 §2, §3, §12, §13,
// P9, P20): choosing text in the Files tab's source brings a 💬 out over the
// right end of the view's text at the middle of the choice's height; pressing
// it opens the comment form (over the Files tab) with the file, its line and
// the text chosen in its head; saving keeps a comment whose anchor is the
// quote in the file (its path relative to the cwd, the view, the text and
// what is around it, the line and column, the line as it read). The source
// then shows the quote highlighted with a 💬 after it; the 💬 goes to the 💬
// filter with the comment there, and its 「コメントした場所へ」 comes back to
// the file with the quote brought into view.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes in a config dir under the daemon's HOME and a
// file in its cwd. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { CommentsFileLineSchema, parseWith, type CommentRecord } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000003";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const FILE = "docs/QUESTIONS.md";
// Long enough that the file scrolls, the quote far down it.
const CONTENT = [
  "# 問い",
  "",
  ...Array.from({ length: 60 }, (_, i) => `- Q${String(i + 1)}: 済み`),
  "",
  "## 裁定待ち",
  "",
  "- chromium の問い: 起動の順を決める",
  "- webkit の問い: 片付けの時機を決める",
  "",
  "## 確認待ち",
  "",
].join("\n");
const CHOSEN: Record<string, string> = {
  chromium: "起動の順を決める",
  webkit: "片付けの時機を決める",
};

let dir: string;
let webui: Webui;
let session: TestClient;
let commentsFile: string;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-cfiles-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, FILE), CONTENT);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  commentsFile = path.join(path.dirname(webui.sock), "sessions", `${SID}.comments.jsonl`);
  const head = { sessionId: SID, cwd };
  const rows = [
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock("答え 1")], {
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

/** Chooses `words` in the source's text, as a person's drag does. */
async function choose(page: Page, words: string): Promise<void> {
  await page.evaluate((target) => {
    for (const text of document.querySelectorAll(".viewer-body .viewer-text")) {
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.nodeValue?.indexOf(target) ?? -1;
        if (at < 0) continue;
        node.parentElement?.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + target.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
    }
    throw new Error(`no ${target} in the file`);
  }, words);
}

/** The texts the comments' highlight paints. */
async function highlighted(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(CSS.highlights.get("ccmsg-comment") ?? [])].map((range) =>
      range instanceof Range ? range.toString() : "",
    ),
  );
}

for (const engine of BROWSERS) {
  const words = CHOSEN[engine.name()] ?? "";
  const lineNo = CONTENT.split("\n").findIndex((text) => text.includes(words)) + 1;
  describe.skipIf(skipsEngine(engine))(`a comment on a quote in a file in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/files?path=${encodeURIComponent(FILE)}`);
      // Once the source is colored: the coloring draws the lines anew, which
      // would take a choice made before it away.
      await page.locator(".viewer-body .shiki-tok").first().waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "choose → 💬 → save: kept with its lines, highlighted; 💬 → the filter → back to the place",
      async () => {
        await choose(page, words);
        const button = page.getByRole("button", { name: "選んだ箇所にコメントする" });
        await button.waitFor();
        // Over the right end of the view's text, at the middle of the
        // choice's height.
        const place = await page.evaluate(() => {
          const chosen = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
          const body = document.querySelector(".viewer-body");
          const at = document.querySelector(".tl-comment-choice-bar")?.getBoundingClientRect();
          if (!chosen || !body || !at) return null;
          const box = body.getBoundingClientRect();
          return {
            middle: chosen.top + chosen.height / 2,
            atMiddle: at.top + at.height / 2,
            atRight: at.right,
            textRight: box.left + body.clientLeft + body.clientWidth,
          };
        });
        expect(place).not.toBeNull();
        if (place === null) return;
        expect(Math.abs(place.atMiddle - place.middle)).toBeLessThan(2);
        expect(Math.abs(place.atRight - place.textRight)).toBeLessThan(2);

        await button.click();
        const form = page.getByRole("dialog", { name: "コメントを書く" });
        await form.waitFor();
        expect(await form.locator(".tl-comment-chosen").textContent()).toBe(words);
        expect(await form.locator(".tl-comment-kind").textContent()).toBe(
          `${FILE}:${String(lineNo)}`,
        );
        // The engines share the daemon, and the one before leaves its comment
        // kept: each asks its own.
        const asked = `${engine.name()}: ここは?`;
        await form.getByRole("textbox", { name: "コメントの本文" }).fill(asked);
        // 後で: kept unsent. The split button starts on 送る; pressing 後で
        // chooses it, pressing it chosen keeps the comment.
        await form.getByRole("button", { name: "後で に切り替える" }).click();
        await form.getByRole("button", { name: "後で 溜める" }).click();
        await form.waitFor({ state: "detached" });

        const kept = keptComments().find(
          (record) => record.anchor.kind === "file" && record.anchor.text === words,
        );
        const lineText = CONTENT.split("\n")[lineNo - 1] ?? "";
        expect(kept?.anchor).toMatchObject({
          kind: "file",
          path: FILE,
          view: "source",
          text: words,
          line: lineNo,
          col: lineText.indexOf(words) + 1,
          line_text: lineText,
        });
        expect(Object.keys(kept?.anchor ?? {}).toSorted()).toEqual([
          "after",
          "before",
          "col",
          "kind",
          "line",
          "line_text",
          "path",
          "text",
          "view",
        ]);

        // The quote highlighted, and a 💬 after it in the source.
        await page.waitForFunction(
          () =>
            (CSS.highlights.get("ccmsg-comment")?.size ?? 0) >= 1 &&
            document.querySelectorAll(".viewer-body .tl-comment-quote-mark").length >= 1,
        );
        expect(await highlighted(page)).toContain(words);
        expect(await page.locator(".viewer-body .viewer-text").allTextContents()).not.toContain(
          "💬",
        );

        // Its 💬 → the 💬 filter, with the comment there and chosen.
        await page.evaluate(() => document.getSelection()?.removeAllRanges());
        await page
          .locator(".viewer-body")
          .getByRole("link", { name: new RegExp(`^コメント ${kept?.cid ?? "-"} `) })
          .click();
        await page.waitForURL(/\/timeline\/.*filter=comment/);
        const bubble = page.locator(".tl-bubble-comment", { hasText: asked });
        await bubble.waitFor();
        expect(await bubble.getAttribute("data-comment-selected")).not.toBeNull();
        // Back to the place: the file, the quote in view.
        await bubble.getByRole("link", { name: "コメントした場所へ" }).click();
        await page.waitForURL(/\/files\?/);
        await page.waitForFunction((target) => {
          const range = [...(CSS.highlights.get("ccmsg-comment") ?? [])].find(
            (r) => r instanceof Range && r.toString() === target,
          );
          if (!(range instanceof Range)) return false;
          const box = range.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= window.innerHeight && box.height > 0;
        }, words);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
