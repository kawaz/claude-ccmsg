// HTML pasted into a message box as markdown, in a real browser (DR-0065): the
// copy (⌘C) and the paste (⌘V) are the browser's own, through the clipboard of
// Playwright's browser (not the OS's). A copy of an assistant's bubble comes
// back as its markdown, and ⌘Z / ⌘⇧Z take the paste back and put it again, as
// for the browser's own paste. HTML with no markdown structure (an editor's
// colouring) goes in as its text/plain, unchanged. The HTML is only read: no
// script or event handler in it runs and no image in it is fetched. In
// Chromium, ⌘⇧V (paste and match style) puts the text/plain.
//
// WebKit's ⌘⇧V is not run here: Playwright sends WebKit no editing command for
// ⇧⌘V, and has no other way to. Its paste event carrying text/plain alone was
// seen with the command sent by a patched Playwright (DR-0065 §1).
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e64000-0000-4000-8000-000000000001";
const FIXTURES = path.join(import.meta.dir, "..", "test", "fixtures", "paste-html");
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** The assistant's answer, in markdown: what the bubble draws. */
const ANSWER = [
  "## 手順",
  "",
  "詳しくは [設計の文書](https://example.com/design) を読む。**太字**と*斜体*と~~消し~~と`コード`。",
  "",
  "- 1 つ目",
  "  - 入れ子",
  "- 2 つ目",
  "",
  "1. 最初",
  "2. 次",
  "",
  "| 名前 | 値 |",
  "|---|---|",
  "| a | 1<br>2 |",
  "",
  "> 引用の文",
  "",
  "```ts",
  "const a = 1;",
  "  indented();",
  "```",
  "",
  "---",
  "",
  "![図](https://example.com/a.png)",
].join("\n");
/** The bubble's copy pasted: the answer, but for how the table's delimiter
 * row is written. The same as the converter's output for the bubble's copy
 * taken before (test/fixtures/paste-html/webui-bubble.md). */
const ANSWER_PASTED = fixture("webui-bubble.md").replace(/\n$/, "");

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-paste-html-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = (uuid: string, minute: number) => ({
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: `2026-11-25T00:0${String(minute)}:00.000Z`,
    sessionId: SID,
    cwd,
  });
  fs.writeFileSync(
    transcript,
    row({
      ...head("e2e64000-0000-4000-8000-000000000001", 1),
      type: "user",
      message: { role: "user", content: "手順をまとめて" },
    }) +
      row({
        ...head("e2e64000-0000-4000-8000-000000000002", 2),
        type: "assistant",
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: ANSWER }],
        },
      }),
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
});

/** A page on the session, the answer drawn (code highlighted), in a context
 * of its own (its own clipboard, undo and drafts). */
async function openSession(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(`${webui.url}s/${SID}/timeline/head`);
  await page.locator(".tl-bubble .md pre.md-code .shiki-tok").first().waitFor();
  return page;
}

/** The answer's bubble's markdown, selected whole. */
async function selectAnswer(page: Page): Promise<void> {
  await page
    .locator(".tl-bubble .md")
    .filter({ hasText: "設計の文書" })
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
}

/** Copy `data` (a type → its content) by the browser's ⌘C: the copy event
 * puts it on the clipboard in place of the selection. */
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
  }, Object.entries(data));
  await selectAnswer(page);
  await page.keyboard.press("Meta+C");
}

/** The FAB's input box, opened and focused, emptied. */
async function openBox(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "このセッションに入力を送る" }).click();
  const box = page
    .getByRole("dialog", { name: "セッションへの入力" })
    .locator(".session-input-textarea");
  await box.focus();
  return box;
}

/** ⌘V into `box`, and its text once the paste is in. */
async function pasteInto(page: Page, box: Locator, before: string): Promise<string> {
  await page.keyboard.press("Meta+V");
  await box.evaluate(
    (el, was) =>
      new Promise<void>((resolve) => {
        if (el instanceof HTMLTextAreaElement && el.value !== was) resolve();
        else el.addEventListener("input", () => resolve(), { once: true });
      }),
    before,
  );
  return box.inputValue();
}

const LINK_HTML = '<meta charset="utf-8"><p>see <a href="https://example.com/doc">the doc</a></p>';

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`HTML pasted as markdown in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a copy of an assistant's bubble pasted into the FAB's box is its markdown; ⌘Z takes the paste back, ⌘⇧Z puts it again",
      async () => {
        const page = await openSession(browser);
        await selectAnswer(page);
        await page.keyboard.press("Meta+C");
        const box = await openBox(page);
        expect(await pasteInto(page, box, "")).toBe(ANSWER_PASTED);
        await page.keyboard.press("Meta+Z");
        expect(await box.inputValue()).toBe("");
        await page.keyboard.press("Shift+Meta+Z");
        expect(await box.inputValue()).toBe(ANSWER_PASTED);
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a paste takes the place of the selection",
      async () => {
        const page = await openSession(browser);
        await copyData(page, { "text/plain": "see the doc", "text/html": LINK_HTML });
        const box = await openBox(page);
        await box.fill("前 XX 後");
        await box.evaluate((el) => {
          if (el instanceof HTMLTextAreaElement) el.setSelectionRange(2, 4);
        });
        expect(await pasteInto(page, box, "前 XX 後")).toBe(
          "前 see [the doc](https://example.com/doc) 後",
        );
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    // An editor's (Monaco's) copy: colouring spans and a div a line. A
    // terminal's, as Chrome on macOS turns its RTF into HTML: a <p> a line,
    // bold as <b>.
    for (const [source, html, plain] of [
      [
        "an editor's",
        `monaco.${engine.name() === "webkit" ? "webkit" : "chromium"}.html`,
        "monaco.txt",
      ],
      ["a terminal's", "terminal-cocoa.html", "terminal-cocoa.txt"],
    ] as const) {
      test(
        `${source} copy (no markdown structure) goes in as its text/plain, every space and tab kept`,
        async () => {
          const page = await openSession(browser);
          const text = fixture(plain);
          await copyData(page, { "text/plain": text, "text/html": fixture(html) });
          const box = await openBox(page);
          expect(await pasteInto(page, box, "")).toBe(text);
          await page.close();
        },
        E2E_TIMEOUT_MS,
      );
    }

    test(
      "the HTML is read, not run: no script or event handler in it runs, no image in it is fetched",
      async () => {
        const page = await openSession(browser);
        const fetched: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes("never-fetched")) fetched.push(request.url());
        });
        const imageUrl = new URL("never-fetched.png", webui.url).href;
        await copyData(page, {
          "text/plain": "x",
          "text/html":
            `<p><a href="https://example.com/ok">ok</a></p>` +
            `<img src="${imageUrl}" alt="pic" onerror="window.__ran = 'onerror'">` +
            `<script>window.__ran = 'script'</script>` +
            `<iframe src="javascript:parent.__ran = 'iframe'"></iframe>` +
            `<p onclick="window.__ran = 'onclick'">end</p>`,
        });
        const box = await openBox(page);
        expect(await pasteInto(page, box, "")).toBe(
          `[ok](https://example.com/ok)\n\n![pic](${imageUrl})\n\nend`,
        );
        expect(await page.evaluate(() => typeof Reflect.get(window, "__ran"))).toBe("undefined");
        expect(fetched).toEqual([]);
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    if (engine.name() === "chromium") {
      test(
        "⌘⇧V (paste and match style) puts the text/plain",
        async () => {
          const page = await openSession(browser);
          await copyData(page, { "text/plain": "see the doc", "text/html": LINK_HTML });
          const box = await openBox(page);
          // Playwright sends no editing command for ⇧⌘V; send the one Chrome's
          // Edit menu (⇧⌘V) runs, as a key event of ⇧⌘V.
          const cdp = await page.context().newCDPSession(page);
          const key = { modifiers: 4 | 8, key: "V", code: "KeyV", windowsVirtualKeyCode: 86 };
          await cdp.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            ...key,
            commands: ["pasteAndMatchStyle"],
          });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
          expect(await box.inputValue()).toBe("see the doc");
          await page.close();
        },
        E2E_TIMEOUT_MS,
      );
    }
  });
}
