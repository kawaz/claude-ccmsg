// The paste button (📋) of the boxes a body is written in, in a real browser
// (DR-0065 §8): the FAB's input box and the comment form, at a PC's width
// (1280) and a phone's (390), in Chromium and WebKit.
//
// - 📋 reads the clipboard (navigator.clipboard.read, the permission given to
//   the page's context) and lays the ways over itself, inside the box (the
//   ways' rect within the panel's / the form's), the textarea keeping the
//   focus and its caret.
// - A way chosen goes in at the caret by the browser's insertText: ⌘Z takes
//   it back, ⌘⇧Z puts it again.
// - HTML to make markdown of offers plain / markdown / attachment, a text
//   plain / markdown / quote / block / attachment. attachment and an image
//   become an attachment with its [FILE<N>] at the caret.
// - Esc closes the ways alone (the comment form stays open).
//
// The clipboard is the browser's own (Playwright's), filled by the page's copy
// event or navigator.clipboard.write, not the OS's. The system's paste prompt
// a real iPhone's Safari shows on a read is not seen here.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { attachmentDir } from "../../daemon/src/attachment.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e65000-0000-4000-8000-000000000001";
const id = (k: number) => `e2e65000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const LINK_HTML = '<p>see <a href="https://example.com/doc">the doc</a></p>';

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-paste-btn-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    [
      userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
      assistantContentRow([textBlock("答え 1")], {
        ...head,
        uuid: id(2),
        timestamp: "2020-01-01T00:00:02.000Z",
      }),
    ]
      .map((r) => `${line(r)}\n`)
      .join(""),
  );
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
  // Where POST /attachment put the uploads (the daemon's TMPDIR is the run's).
  fs.rmSync(path.dirname(attachmentDir()), { recursive: true, force: true });
});

/** Put `data` (a type → its content) on the clipboard by the browser's ⌘C:
 * the copy event puts it there in place of a selection of the question. */
async function copyData(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    document.addEventListener(
      "copy",
      (e) => {
        e.preventDefault();
        for (const [type, value] of entries) e.clipboardData?.setData(type, value);
      },
      { once: true },
    );
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const question = document.querySelector(".tl-bubble-right");
    const selection = getSelection();
    if (question === null || selection === null) throw new Error("no question to select");
    const range = document.createRange();
    range.selectNodeContents(question);
    selection.removeAllRanges();
    selection.addRange(range);
  }, Object.entries(data));
  await page.keyboard.press("Meta+C");
}

/** Put a PNG image alone on the clipboard. */
async function copyImage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b === null ? reject(new Error("no image")) : resolve(b)), "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
}

/** `textarea`'s value, whether it has the focus, and its selection. */
async function stateOf(textarea: Locator) {
  return textarea.evaluate((el) =>
    el instanceof HTMLTextAreaElement
      ? {
          value: el.value,
          focused: document.activeElement === el,
          selection: [el.selectionStart, el.selectionEnd],
        }
      : null,
  );
}

/** Press 📋 in `scope` and wait for the ways, their opening run out. */
async function openWays(scope: Locator): Promise<Locator> {
  await scope.getByRole("button", { name: "貼り付け方を選ぶ" }).click();
  const ways = scope.getByRole("group", { name: "貼り付け方" });
  await ways.waitFor();
  await ways.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return ways;
}

async function labelsOf(ways: Locator): Promise<string[]> {
  return ways.getByRole("button").allTextContents();
}

/** Whether `inner`'s rect lies within `outer`'s. */
async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (a === null || b === null) return false;
  return (
    a.x >= b.x - 0.5 &&
    a.y >= b.y - 0.5 &&
    a.x + a.width <= b.x + b.width + 0.5 &&
    a.y + a.height <= b.y + b.height + 0.5
  );
}

/** Wait for `textarea`'s value to be `value` (a RegExp: to match it). An
 * attachment's [FILE<N>] is put in by the box's state, with no input event. */
async function waitForValue(textarea: Locator, value: string | RegExp): Promise<void> {
  const el = await textarea.elementHandle();
  await textarea
    .page()
    .waitForFunction(
      ({ el, text, pattern }) =>
        el instanceof HTMLTextAreaElement &&
        (pattern === null ? el.value === text : new RegExp(pattern).test(el.value)),
      {
        el,
        text: typeof value === "string" ? value : "",
        pattern: typeof value === "string" ? null : value.source,
      },
    );
}

/** Press ⌘Z and return what its first step left in `textarea` (null when it
 * took nothing back): the value at the first `historyUndo` input, the edit
 * made last taken back alone. One ⌘Z in Playwright's WebKit can take back the
 * edits before that one with it, each with its own input, how many varying
 * from launch to launch and within one; Chromium's takes back one edit. The
 * inputs are all out when the press is done. */
async function undoStep(textarea: Locator): Promise<string | null> {
  const recorder = await textarea.evaluateHandle((el) => {
    const values: string[] = [];
    const onInput = (event: Event) => {
      if (!(event instanceof InputEvent) || event.inputType !== "historyUndo") return;
      if (el instanceof HTMLTextAreaElement) values.push(el.value);
    };
    el.addEventListener("input", onInput);
    return { values, stop: () => el.removeEventListener("input", onInput) };
  });
  await textarea.page().keyboard.press("Meta+Z");
  const first = await recorder.evaluate((r) => {
    r.stop();
    return r.values[0] ?? null;
  });
  await recorder.dispose();
  return first;
}

for (const engine of BROWSERS) {
  for (const width of [1280, 390] as const) {
    describe.skipIf(skipsEngine(engine))(
      `the paste button, ${String(width)} wide, in ${engine.name()}`,
      () => {
        let browser: Browser;
        let context: BrowserContext;
        let page: Page;
        beforeAll(async () => {
          browser = await engine.launch();
          context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 900 },
          });
          // WebKit has no clipboard-write to give: its write needs none.
          await context.grantPermissions(
            engine.name() === "chromium"
              ? ["clipboard-read", "clipboard-write"]
              : ["clipboard-read"],
            { origin: new URL(webui.url).origin },
          );
          page = await context.newPage();
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page.locator(".tl-bubble-right").filter({ hasText: "質問 1" }).waitFor();
        }, E2E_TIMEOUT_MS);
        afterAll(async () => {
          await browser.close();
        });

        /** The FAB's box, opened, with its textarea focused. */
        async function fabBox(): Promise<{ box: Locator; textarea: Locator }> {
          const box = page.getByRole("dialog", { name: "セッションへの入力" });
          if ((await box.count()) === 0) await page.locator(".session-input-fab").click();
          const textarea = box.locator(".session-input-textarea");
          await textarea.focus();
          return { box, textarea };
        }

        /** Empty `textarea`, type `typed` into it, and select `selection` (the
         * caret at the end when left out). */
        async function typeInto(
          textarea: Locator,
          typed: string,
          selection?: readonly [number, number],
        ): Promise<void> {
          await textarea.fill("");
          await textarea.focus();
          await page.keyboard.type(typed);
          if (selection === undefined) return;
          await textarea.evaluate((el, [start, end]) => {
            if (el instanceof HTMLTextAreaElement) el.setSelectionRange(start, end);
          }, selection);
        }

        /** What ⌘Z's first step (`undoStep`) leaves after the browser's own
         * paste (⌘V of the clipboard's text alone) into `textarea` typed and
         * selected as `typeInto`: what the paste button's leaves too. */
        async function undoneBrowserPaste(
          textarea: Locator,
          typed: string,
          selection?: readonly [number, number],
        ): Promise<string | null> {
          await typeInto(textarea, typed, selection);
          const before = await textarea.inputValue();
          await page.keyboard.press("Meta+V");
          const el = await textarea.elementHandle();
          await page.waitForFunction(
            ({ el, before }) => el instanceof HTMLTextAreaElement && el.value !== before,
            { el, before },
          );
          return undoStep(textarea);
        }

        test(
          "a text in the FAB's box: five ways over 📋 within the panel, quote goes in at the caret, ⌘Z takes it back as the browser's paste",
          async () => {
            await copyData(page, { "text/plain": "x\ny" });
            const { box, textarea } = await fabBox();
            const undone = await undoneBrowserPaste(textarea, "ab");
            expect(undone).toBe("ab");
            await typeInto(textarea, "ab");
            const ways = await openWays(box);
            expect(await labelsOf(ways)).toEqual([
              "plain",
              "markdown",
              "quote",
              "block",
              "attachment (3)",
            ]);
            expect(await within(ways, box)).toBe(true);
            expect(await stateOf(textarea)).toEqual({
              value: "ab",
              focused: true,
              selection: [2, 2],
            });
            await ways.getByRole("button", { name: "quote" }).click();
            await waitForValue(textarea, "ab\n\n> x\n> y\n\n");
            expect(await ways.count()).toBe(0);
            expect((await stateOf(textarea))?.focused).toBe(true);
            expect(await undoStep(textarea)).toBe(undone);
            await page.keyboard.press("Shift+Meta+Z");
            expect(await textarea.inputValue()).toBe("ab\n\n> x\n> y\n\n");
          },
          E2E_TIMEOUT_MS,
        );

        test(
          "block takes the place of the selection, with the language guessed",
          async () => {
            await copyData(page, { "text/plain": '{"a": 1}' });
            const { box, textarea } = await fabBox();
            const undone = await undoneBrowserPaste(textarea, "a XX b", [2, 4]);
            expect(undone).toBe("a XX b");
            await typeInto(textarea, "a XX b", [2, 4]);
            const ways = await openWays(box);
            await ways.getByRole("button", { name: "block" }).click();
            await waitForValue(textarea, 'a \n```json\n{"a": 1}\n```\n b');
            expect(await undoStep(textarea)).toBe(undone);
          },
          E2E_TIMEOUT_MS,
        );

        test(
          "attachment: the text becomes pasted.txt, its [FILE<N>] at the caret",
          async () => {
            await copyData(page, { "text/plain": "x\ny" });
            const { box, textarea } = await fabBox();
            await typeInto(textarea, "ab");
            const ways = await openWays(box);
            await ways.getByRole("button", { name: "attachment (3)" }).click();
            // The number goes on from the box's earlier attachments.
            await waitForValue(textarea, /^ab\[FILE\d+\]$/);
            await box
              .locator(".composer-attachment-label")
              .filter({ hasText: "pasted.txt" })
              .waitFor();
            await box.locator(".composer-attachment-remove").click();
            expect((await stateOf(textarea))?.value).toBe("ab");
          },
          E2E_TIMEOUT_MS,
        );

        test(
          "an image: no ways, it is attached at once",
          async () => {
            await copyImage(page);
            const { box, textarea } = await fabBox();
            await typeInto(textarea, "ab");
            await box.getByRole("button", { name: "貼り付け方を選ぶ" }).click();
            await waitForValue(textarea, /^ab\[FILE\d+\]$/);
            expect(await box.getByRole("group", { name: "貼り付け方" }).count()).toBe(0);
            await box
              .locator(".composer-attachment-label")
              .filter({ hasText: "pasted.png" })
              .waitFor();
            await box.locator(".composer-attachment-remove").click();
            await box.getByRole("button", { name: "入力欄を閉じる" }).click();
            await box.waitFor({ state: "detached" });
          },
          E2E_TIMEOUT_MS,
        );

        test(
          "HTML in the comment form: three ways within the form, markdown goes in mid-line, ⌘Z takes it back; Esc closes the ways alone",
          async () => {
            await page.locator(".tl-bubble-assistant .tl-comment-reply").click();
            const form = page.getByRole("dialog", { name: "コメントを書く" });
            const textarea = form.locator(".tl-comment-input");
            await copyData(page, { "text/plain": "see the doc" });
            const undone = await undoneBrowserPaste(textarea, "ab");
            expect(undone).toBe("ab");
            await copyData(page, { "text/plain": "see the doc", "text/html": LINK_HTML });
            await typeInto(textarea, "ab");
            let ways = await openWays(form);
            expect(await labelsOf(ways)).toEqual(["plain", "markdown", "attachment (11)"]);
            expect(await within(ways, form)).toBe(true);
            await page.keyboard.press("Escape");
            expect(await ways.count()).toBe(0);
            expect(await form.count()).toBe(1);
            expect(await textarea.inputValue()).toBe("ab");
            ways = await openWays(form);
            await ways.getByRole("button", { name: "markdown" }).click();
            await waitForValue(textarea, "ab\nsee [the doc](https://example.com/doc)\n");
            expect(await undoStep(textarea)).toBe(undone);
            await textarea.fill("");
            await form.getByRole("button", { name: "コメントのフォームを閉じる" }).click();
            await form.waitFor({ state: "detached" });
          },
          E2E_TIMEOUT_MS,
        );
      },
    );
  }
}
