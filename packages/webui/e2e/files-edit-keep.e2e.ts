// The unsaved 編集 of a file in the Files tab kept across another file, in a
// real browser (DR-0051 §9): typing in the 編集 area, then going to another
// file (a link in the 編集's preview, a file in the tree) and back opens the
// file still being edited, on what was typed, the caret where it was; typing
// goes on there and 保存 writes it.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes and files in its cwd. Nothing reaches a Claude
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

const SID = "e2ec0000-0000-4000-8000-000000000005";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const AT = "ここに書き足す";
const other = (engine: string) => `${engine}-other.md`;
const content = (engine: string) =>
  ["# メモ", "", `[別のファイル](${other(engine)})`, "", AT, ""].join("\n");

let dir: string;
let cwd: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-fkeep-");
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
const IN_VIEW = ".session-tab-panel:not([hidden])";

/** Puts the caret at `offset` of the 編集 area's text. */
async function caretAt(page: Page, offset: number): Promise<void> {
  await page.evaluate(
    ({ selector, offset }) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement)) throw new Error("no 編集 area");
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let left = offset;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = node.nodeValue?.length ?? 0;
        if (left <= length) {
          el.focus();
          document.getSelection()?.setBaseAndExtent(node, left, node, left);
          return;
        }
        left -= length;
      }
      throw new Error(`no offset ${String(offset)} in the area`);
    },
    { selector: EDITOR, offset },
  );
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `an unsaved 編集 kept across another file in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      const file = `${engine.name()}.md`;
      const text = content(engine.name());
      beforeAll(async () => {
        fs.writeFileSync(path.join(cwd, other(engine.name())), "# 別のファイル\n");
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      /** The file opened in its 編集, "XYZ" typed after AT. */
      async function editAndType(): Promise<void> {
        fs.writeFileSync(path.join(cwd, file), text);
        await page.goto(`${webui.url}s/${SID}/files?path=${encodeURIComponent(file)}`);
        await page.locator(`${IN_VIEW} .viewer-body`).waitFor();
        await page.getByRole("button", { name: "ファイルを編集" }).click();
        await page.locator(EDITOR).waitFor();
        await caretAt(page, text.indexOf(AT) + AT.length);
        await page.keyboard.type("XYZ");
      }

      /** Back on the file: still being edited, on what was typed, typing going
       * on at the caret; then 保存. */
      async function goesOnAndSaves(): Promise<void> {
        const area = page.locator(EDITOR);
        await area.waitFor();
        expect(await area.textContent()).toBe(`${text.replace(AT, `${AT}XYZ`)}\n`);
        await page.keyboard.type("!");
        expect(await area.textContent()).toBe(`${text.replace(AT, `${AT}XYZ!`)}\n`);
        await page.getByRole("button", { name: "保存" }).click();
        await page.locator(".file-editor").waitFor({ state: "detached" });
        expect(fs.readFileSync(path.join(cwd, file), "utf8")).toBe(text.replace(AT, `${AT}XYZ!`));
      }

      test(
        "a link in the 編集's preview to another file, then back: the 編集 goes on, on プレビュー",
        async () => {
          await editAndType();
          await page.locator(".file-editor").getByRole("tab", { name: "プレビュー" }).click();
          await page.locator(".file-editor .viewer-preview").getByText("別のファイル").click();
          await page.locator(`${IN_VIEW} .viewer-body`).getByText("# 別のファイル").waitFor();
          expect(await page.locator(EDITOR).count()).toBe(0);

          await page.goBack();
          const tabs = page.locator(".file-editor .viewer-mode-toggle");
          await tabs.waitFor();
          expect(
            await tabs.getByRole("tab", { name: "プレビュー" }).getAttribute("aria-selected"),
          ).toBe("true");
          await page
            .locator(".file-editor .viewer-preview")
            .getByText(`${AT}XYZ`, { exact: false })
            .waitFor();
          await tabs.getByRole("tab", { name: "コード" }).click();
          await goesOnAndSaves();
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "another file in the tree, then back: the 編集 goes on",
        async () => {
          await editAndType();
          const tree = page.locator(`${IN_VIEW} .file-tree`);
          await tree.getByText(other(engine.name()), { exact: true }).click();
          await page.locator(`${IN_VIEW} .viewer-body`).getByText("# 別のファイル").waitFor();
          expect(await page.locator(EDITOR).count()).toBe(0);

          await tree.getByText(file, { exact: true }).click();
          await goesOnAndSaves();
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
