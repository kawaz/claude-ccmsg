// The boxes a body is written in, in a real browser (DR-0010 §15): the input
// box (the FAB's panel) and the comment form, at a PC's width (1280) and a
// phone's (390). md lays the text, drawn as markdown, over the textarea in a
// box of the textarea's own place and size (the textarea hidden, not gone),
// which scrolls when the text is longer; source shows the same textarea again,
// focused, with its selection. The tabs sit on the line of the send.
//
// The session is the test's own: a hello on the daemon's socket with a
// transcript the test wrote. Nothing is sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
/** Long enough to scroll in either box at either width. */
const BODY = [
  "## 見出し",
  "",
  "- 項目 **太字**",
  "- 項目 `code`",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  ...Array.from({ length: 12 }, (_, i) => `段落 ${String(i + 1)}`),
].join("\n");

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-cprev-");
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
});

/** md | source of the box `scope`, whose textarea is `textarea`. */
async function checkToggle(scope: Locator, textarea: Locator): Promise<void> {
  await textarea.fill(BODY);
  await textarea.evaluate((el) => {
    if (!(el instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
    el.setSelectionRange(3, 6);
  });
  await scope.getByRole("tab", { name: "md" }).click();
  const preview = scope.locator(".compose-preview");
  await preview.waitFor();
  expect(await preview.locator("h2").textContent()).toContain("見出し");
  expect(await preview.locator("table").count()).toBe(1);
  expect(await preview.locator("pre").count()).toBe(1);
  // The textarea is hidden, not gone, and the preview takes its place and size.
  expect(await textarea.evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
  const [box, over] = await Promise.all([textarea.boundingBox(), preview.boundingBox()]);
  expect(over).toEqual(box);
  // Longer than the box: it scrolls inside.
  expect(
    await preview.evaluate(
      (el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight > el.clientHeight,
    ),
  ).toBe(true);

  await scope.getByRole("tab", { name: "source" }).click();
  expect(await preview.count()).toBe(0);
  expect(await textarea.evaluate((el) => getComputedStyle(el).visibility)).toBe("visible");
  expect(
    await textarea.evaluate((el) =>
      el instanceof HTMLTextAreaElement
        ? {
            focused: document.activeElement === el,
            value: el.value,
            selection: [el.selectionStart, el.selectionEnd],
          }
        : null,
    ),
  ).toEqual({ focused: true, value: BODY, selection: [3, 6] });
  await textarea.fill("");
}

for (const engine of BROWSERS) {
  for (const width of [1280, 390] as const) {
    const phone = width === 390;
    describe(`the boxes a body is written in, ${String(width)} wide, in ${engine.name()}`, () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width, height: phone ? 844 : 900 } });
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await page.locator(".tl-bubble-right").filter({ hasText: "質問 1" }).waitFor();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      test(
        "the input box's md | source",
        async () => {
          await page.locator(".session-input-fab").click();
          const box = page.getByRole("dialog", { name: "セッションへの入力" });
          const textarea = box.locator(".session-input-textarea");
          await textarea.waitFor();
          // The tabs at the row's left, on the same line as the send.
          const tabs = box.getByRole("tablist", { name: "本文の表示形式" });
          const send = box.getByRole("group", { name: "送信の形" });
          const [t, s] = await Promise.all([tabs.boundingBox(), send.boundingBox()]);
          if (t === null || s === null) throw new Error("no tabs or no send");
          expect(t.y + t.height).toBeGreaterThan(s.y);
          expect(t.y).toBeLessThan(s.y + s.height);
          await checkToggle(box, textarea);
          await box.getByRole("button", { name: "入力欄を閉じる" }).click();
          await box.waitFor({ state: "detached" });
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "the comment form's md | source",
        async () => {
          await page.locator(".tl-bubble-assistant .tl-comment-reply").click();
          const form = page.getByRole("dialog", { name: "コメントを書く" });
          const textarea = form.locator(".tl-comment-input");
          await textarea.waitFor();
          await checkToggle(form, textarea);
          await form.getByRole("button", { name: "コメントのフォームを閉じる" }).click();
          await form.waitFor({ state: "detached" });
        },
        E2E_TIMEOUT_MS,
      );
    });
  }
}
