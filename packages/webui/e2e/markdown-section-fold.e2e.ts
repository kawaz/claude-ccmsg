// The folds of a markdown file's sections in the Files tab's preview, in a
// real browser: pressing anywhere on a section's heading (its text, or the
// empty rest of its row, an inline code in it) opens and closes it, as the ▶
// beside it does — one state, so the two undo each other. A link in the heading goes where it
// points and leaves the section as it was; a press that ends a drag choosing
// the heading's text leaves it too. Nothing else comes out of the ▶: no menu
// on hovering or focusing it.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes and a file in its cwd. Nothing reaches a Claude
// Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000006";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
/** Sections `1` (第一節), `1.1` (小節, with a link to the document's title
 * `md-section-1`, which is in no section) and `2` (第二節, with an inline
 * code). */
const CONTENT = [
  "# 文書",
  "",
  "前書き",
  "",
  "## 第一節",
  "",
  "本文 1",
  "",
  "### 小節は [文書の頭](#md-section-1) へ",
  "",
  "本文 2",
  "",
  "## 第二節 `code`",
  "",
  "本文 3",
  "",
].join("\n");

let dir: string;
let cwd: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-mdsec-");
  webui = await startWebui();
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
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

/** Two frames: whatever a press set going (Preact's render of a state the
 * press changed) is on the page by then. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** The box of `text` within the heading of `section`, in the page. */
async function textBox(
  section: Locator,
  text: string,
): Promise<{ left: number; right: number; middle: number }> {
  return section.evaluate((el, text) => {
    const heading = el.querySelector(":scope > .md-sec-head > :is(h2, h3, h4, h5, h6)");
    if (heading === null) throw new Error("no heading");
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.nodeValue?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, middle: box.top + box.height / 2 };
    }
    throw new Error(`no ${text} in the heading`);
  }, text);
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `the sections of a markdown preview in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      const file = `${engine.name()}.md`;
      beforeAll(async () => {
        fs.writeFileSync(path.join(cwd, file), CONTENT);
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${webui.url}s/${SID}/files?path=${encodeURIComponent(file)}`);
        await page.getByRole("tab", { name: "プレビュー" }).click();
        await page.locator('.viewer-preview .md-sec[data-md-section="2"]').waitFor();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      const section = (key: string): Locator =>
        page.locator(`.viewer-preview .md-sec[data-md-section="${key}"]`);
      const heading = (key: string): Locator =>
        section(key).locator(":scope > .md-sec-head > :is(h2, h3, h4, h5, h6)");
      const caret = (key: string): Locator =>
        section(key).locator(":scope > .md-sec-head .md-sec-caret");
      const openOf = (key: string): Promise<string | null> =>
        section(key).getAttribute("data-open");
      const becomes = async (key: string, open: boolean): Promise<void> => {
        await page.waitForFunction(
          ({ key, open }) =>
            document
              .querySelector(`.viewer-preview .md-sec[data-md-section="${key}"]`)
              ?.getAttribute("data-open") === String(open),
          { key, open },
        );
      };

      test(
        "pressing the heading's text or the rest of its row closes and opens the section",
        async () => {
          expect(await openOf("1")).toBe("true");
          await heading("1").getByText("第一節").click();
          await becomes("1", false);
          expect(await section("1").locator(":scope > .md-sec-body").isVisible()).toBe(false);
          // Far right on the heading's row, past its text.
          const box = await heading("1").boundingBox();
          expect(box).not.toBeNull();
          if (box === null) return;
          await heading("1").click({ position: { x: box.width - 4, y: box.height / 2 } });
          await becomes("1", true);
          expect(await section("1").locator(":scope > .md-sec-body").isVisible()).toBe(true);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "the ▶ and the heading turn the same state: one closes, the other opens",
        async () => {
          await caret("2").click();
          await becomes("2", false);
          expect(await caret("2").getAttribute("aria-expanded")).toBe("false");
          await heading("2").getByText("第二節").click();
          await becomes("2", true);
          expect(await caret("2").getAttribute("aria-expanded")).toBe("true");
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "pressing an inline code in the heading closes and opens the section",
        async () => {
          const code = heading("2").locator("code", { hasText: "code" });
          await code.click();
          await becomes("2", false);
          await code.click();
          await becomes("2", true);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "a link in the heading goes where it points and leaves the section as it was",
        async () => {
          expect(await openOf("1.1")).toBe("true");
          await heading("1.1").getByRole("link", { name: "文書の頭" }).click();
          await page.waitForFunction(() => location.hash === "#md-section-1");
          await settled(page);
          expect(await openOf("1.1")).toBe("true");
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "a drag choosing the heading's text leaves the section as it was",
        async () => {
          expect(await openOf("2")).toBe("true");
          const box = await textBox(section("2"), "第二節");
          await page.mouse.move(box.left + 1, box.middle);
          await page.mouse.down();
          await page.mouse.move(box.right - 1, box.middle, { steps: 5 });
          await page.mouse.up();
          await settled(page);
          expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).not.toBe("");
          expect(await openOf("2")).toBe("true");
          await page.evaluate(() => document.getSelection()?.removeAllRanges());
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "hovering or focusing the ▶ brings out no menu",
        async () => {
          await caret("1").hover();
          await caret("1").focus();
          await settled(page);
          expect(await page.getByRole("menu").count()).toBe(0);
          expect(await page.getByRole("menuitem").count()).toBe(0);
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
