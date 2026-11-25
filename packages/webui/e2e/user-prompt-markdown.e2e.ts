// A user's prompt drawn as a response's markdown, in a real browser (DR-0010
// §6): its bubble draws the headings, tables and code it holds, and a single
// line break inside a paragraph shows as a new line (the Timeline's text is
// `white-space: pre-wrap`). The input box's md preview of the same text draws
// it the same way, lines included (§15; that the two draw the same markup is
// compose-preview.dom.test.ts's), at a PC's width (1280) and a phone's
// (390).
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
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e70000-0000-4000-8000-000000000001";
const id = (k: number) => `e2e70000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const BODY = [
  "## 見出し",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "1 行目",
  "2 行目",
].join("\n");

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-umd-");
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
      userContentRow(BODY, { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
      assistantContentRow([textBlock("答え")], {
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

/** The paragraph holding "1 行目" in `scope`: its white-space, and the top of
 * each of its two lines' first character on screen. */
async function linesOf(
  scope: Locator,
): Promise<{ whiteSpace: string; tops: [number, number] } | null> {
  return scope.evaluate((root) => {
    const p = [...root.querySelectorAll("p")].find((el) => el.textContent?.includes("1 行目"));
    if (p === undefined) return null;
    const topOf = (word: string): number | null => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!(node instanceof Text)) continue;
        const at = node.data.indexOf(word);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        return range.getBoundingClientRect().top;
      }
      return null;
    };
    const first = topOf("1 行目");
    const second = topOf("2 行目");
    if (first === null || second === null) return null;
    return { whiteSpace: getComputedStyle(p).whiteSpace, tops: [first, second] };
  });
}

for (const engine of BROWSERS) {
  for (const width of [1280, 390] as const) {
    describe.skipIf(skipsEngine(engine))(
      `a user's prompt as markdown, ${String(width)} wide, in ${engine.name()}`,
      () => {
        let browser: Browser;
        let page: Page;
        beforeAll(async () => {
          browser = await engine.launch();
          page = await browser.newPage({ viewport: { width, height: 900 } });
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page.locator(".tl-bubble-right h2").waitFor();
        }, E2E_TIMEOUT_MS);
        afterAll(async () => {
          await browser.close();
        });

        test(
          "the bubble draws its markdown and keeps a single line break, and the preview draws the same",
          async () => {
            const bubble = page.locator(".tl-bubble-right .tl-bubble-body");
            expect(await bubble.locator("table").count()).toBe(1);
            expect(await bubble.locator("pre").textContent()).toContain("const x = 1;");
            const inBubble = await linesOf(bubble);
            expect(inBubble?.whiteSpace).toBe("pre-wrap");
            const [first, second] = inBubble?.tops ?? [0, 0];
            expect(second).toBeGreaterThan(first);

            await page.locator(".session-input-fab").click();
            const box = page.getByRole("dialog", { name: "セッションへの入力" });
            const textarea = box.locator(".session-input-textarea");
            await textarea.fill(BODY);
            await box.getByRole("tab", { name: "md" }).click();
            const preview = box.locator(".compose-preview");
            await preview.locator("h2").waitFor();
            expect(await preview.locator("table").count()).toBe(1);
            const inPreview = await linesOf(preview);
            expect(inPreview?.whiteSpace).toBe("pre-wrap");
            const [pFirst, pSecond] = inPreview?.tops ?? [0, 0];
            expect(pSecond).toBeGreaterThan(pFirst);
            await box.getByRole("tab", { name: "source" }).click();
            await textarea.fill("");
            await box.getByRole("button", { name: "入力欄を閉じる" }).click();
            await box.waitFor({ state: "detached" });
          },
          E2E_TIMEOUT_MS,
        );
      },
    );
  }
}
