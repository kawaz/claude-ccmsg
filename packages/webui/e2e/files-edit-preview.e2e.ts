// The preview of a markdown file while it is edited in the Files tab, in a
// real browser (DR-0051 §8): typing in the 編集 area, then プレビュー draws
// what was typed (not saved yet); コード brings the area back with the focus
// in it, the caret and the choice where they were (a backward choice stays
// backward) and its scroll as it was, even after text in the preview was
// chosen; typing goes on at the caret, ⌘Z undoes it, and 保存 writes what the
// area holds.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes and a file in its cwd. Nothing reaches a Claude
// Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000004";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
/** Long enough that the 編集 area scrolls; the line typed at is far down it. */
const CONTENT = [
  "# メモ",
  "",
  ...Array.from({ length: 60 }, (_, i) => `- 項目 ${String(i + 1)}`),
  "",
  "## 書き足す所",
  "",
  "ここに書き足す",
  "",
  ...Array.from({ length: 30 }, (_, i) => `段落 ${String(i + 1)}`),
  "",
].join("\n");
const AT = "ここに書き足す";

let dir: string;
let cwd: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-fedit-");
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

const EDITOR = '[role="textbox"][aria-label="ファイル本文"]';

/** Chooses from `anchor` to `focus` (offsets into the area's text), the area
 * scrolled to show it, as a person's click or drag leaves it. */
async function chooseAt(page: Page, anchor: number, focus: number): Promise<void> {
  await page.evaluate(
    ({ selector, anchor, focus }) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement)) throw new Error("no 編集 area");
      const at = (offset: number): [Node, number] => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let left = offset;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const length = node.nodeValue?.length ?? 0;
          if (left <= length) return [node, left];
          left -= length;
        }
        throw new Error(`no offset ${String(offset)} in the area`);
      };
      const [anchorNode, anchorOffset] = at(anchor);
      const [focusNode, focusOffset] = at(focus);
      el.focus();
      document.getSelection()?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      const range = document.createRange();
      range.setStart(focusNode, focusOffset);
      const box = range.getBoundingClientRect();
      const area = el.getBoundingClientRect();
      el.scrollTop += box.top - area.top - area.height / 2;
    },
    { selector: EDITOR, anchor, focus },
  );
}

interface Place {
  focused: boolean;
  anchor: number;
  focus: number;
  scrollTop: number;
  gutterTop: number;
  text: string;
}

/** Where the 編集 area stands: the focus, the choice as offsets into its text,
 * its scroll and its line numbers' scroll (once the line numbers have
 * followed the scroll, which they do on its scroll event). */
async function placeOf(page: Page): Promise<Place> {
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.scrollTop ===
      document.querySelector(".file-editor-lineno")?.scrollTop,
    EDITOR,
  );
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const gutter = document.querySelector(".file-editor-lineno");
    if (!(el instanceof HTMLElement) || !(gutter instanceof HTMLElement)) {
      throw new Error("no 編集 area");
    }
    const offset = (node: Node | null, at: number): number => {
      if (node === null || !el.contains(node)) return -1;
      const range = document.createRange();
      range.setStart(el, 0);
      range.setEnd(node, at);
      return range.toString().length;
    };
    const selection = document.getSelection();
    return {
      focused: document.activeElement === el,
      anchor: offset(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
      focus: offset(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
      scrollTop: el.scrollTop,
      gutterTop: gutter.scrollTop,
      text: el.textContent ?? "",
    };
  }, EDITOR);
}

/** プレビュー, then a choice of text in the preview and a scroll of it, then
 * コード. */
async function throughPreview(page: Page, typed: string): Promise<void> {
  await page.getByRole("tab", { name: "プレビュー" }).click();
  const preview = page.locator(".file-editor .viewer-preview");
  await preview.getByText(typed, { exact: false }).waitFor();
  expect(await page.locator(EDITOR).isVisible()).toBe(false);
  await page.evaluate(() => {
    const box = document.querySelector(".file-editor .viewer-preview");
    if (!(box instanceof HTMLElement)) throw new Error("no preview");
    const range = document.createRange();
    range.selectNodeContents(box.querySelector("h1") ?? box);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    box.scrollTop = 120;
  });
  await page.getByRole("tab", { name: "コード" }).click();
  await page.locator(EDITOR).waitFor({ state: "visible" });
}

/** Press ⌘Z until the 編集 area's text is `last`, at most `presses` times,
 * and return the area's text at each step taken back (each `historyUndo`
 * input), in order. One ⌘Z in Playwright's WebKit can take back the edits
 * before the last one with it, each with its own input, how many varying;
 * Chromium's takes back one edit. The inputs are all out when the press is
 * done. */
async function undoSteps(page: Page, last: string, presses: number): Promise<string[]> {
  const recorder = await page.evaluateHandle((selector) => {
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) throw new Error("no 編集 area");
    const texts: string[] = [];
    const onInput = (event: Event) => {
      if (event instanceof InputEvent && event.inputType === "historyUndo") {
        texts.push(el.textContent ?? "");
      }
    };
    el.addEventListener("input", onInput);
    return { texts, stop: () => el.removeEventListener("input", onInput) };
  }, EDITOR);
  for (let pressed = 0; pressed < presses; pressed += 1) {
    await page.keyboard.press("ControlOrMeta+z");
    if (await recorder.evaluate((r, text) => r.texts.at(-1) === text, last)) break;
  }
  const texts = await recorder.evaluate((r) => {
    r.stop();
    return r.texts;
  });
  await recorder.dispose();
  return texts;
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `the preview of a markdown file being edited in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      const file = `${engine.name()}.md`;
      beforeAll(async () => {
        fs.writeFileSync(path.join(cwd, file), CONTENT);
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${webui.url}s/${SID}/files?path=${encodeURIComponent(file)}`);
        await page.locator(".viewer-body").waitFor();
        await page.getByRole("button", { name: "ファイルを編集" }).click();
        await page.locator(EDITOR).waitFor();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      test(
        "type → プレビュー → コード: the caret, the choice and the scroll as they were; typing, ⌘Z and 保存 go on",
        async () => {
          // The tabs start on コード.
          expect(
            await page.getByRole("tab", { name: "コード" }).getAttribute("aria-selected"),
          ).toBe("true");
          const start = CONTENT.indexOf(AT);
          const end = start + AT.length;

          // A backward choice comes back backward.
          await chooseAt(page, end, start + 2);
          const chosen = await placeOf(page);
          expect(chosen).toMatchObject({ focused: true, anchor: end, focus: start + 2 });
          await throughPreview(page, AT);
          expect(await placeOf(page)).toEqual(chosen);

          await chooseAt(page, end, end);
          await page.keyboard.type("XYZ");
          const before = await placeOf(page);
          expect(before).toMatchObject({ focused: true, anchor: end + 3, focus: end + 3 });
          expect(before.scrollTop).toBeGreaterThan(0);

          // The preview draws what was typed, not what the file has.
          await throughPreview(page, `${AT}XYZ`);
          expect(fs.readFileSync(path.join(cwd, file), "utf8")).toBe(CONTENT);
          const back = await placeOf(page);
          expect(back).toEqual(before);
          expect(back.gutterTop).toBe(back.scrollTop);

          // Typing goes on at the caret.
          await page.keyboard.type("!");
          expect((await placeOf(page)).text).toContain(`${AT}XYZ!\n`);
          // ⌘Z takes the "!" back alone, then the "XYZ" typed before the
          // preview: the area's undo history goes on across the preview.
          const steps = await undoSteps(page, `${CONTENT}\n`, 2);
          expect(steps).toEqual([`${CONTENT.replace(AT, `${AT}XYZ`)}\n`, `${CONTENT}\n`]);
          await page.keyboard.type("?");

          // 保存 from the preview writes what the area holds.
          await page.getByRole("tab", { name: "プレビュー" }).click();
          await page.getByRole("button", { name: "保存" }).click();
          await page.locator(".file-editor").waitFor({ state: "detached" });
          expect(fs.readFileSync(path.join(cwd, file), "utf8")).toBe(CONTENT.replace(AT, `${AT}?`));
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
