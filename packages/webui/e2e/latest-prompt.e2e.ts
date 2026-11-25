// The 「↑最新のプロンプトへ移動↑」 at the end of the Timeline in a real browser
// (DR-0054 §10): opened on a long Timeline and not scrolled up, the newest
// prompt is far above the view, so the button is shown, at the right, last in
// the row list; the Timeline still follows its tail with the button there (a
// row appended to the transcript keeps the view at the bottom); a click moves
// to the prompt, which comes into the view under the toolbar, and the button
// goes. It is shown only while the Timeline's bottom box (its status rows) is
// in the view, and the 「↓先頭に移動↓」 is not shown then: the two are never
// shown together (DR-0054 §10, §11).
//
// The visibility is the browser's IntersectionObserver on the real layout,
// which happy-dom does not have. The session is the test's own: a hello on the
// daemon's socket, with a transcript the test wrote in a config dir under the
// daemon's HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { pushRows, sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const LATEST_UUID = "e2ec0000-0000-4000-8000-000000000003";
const LATEST_TEXT = "いちばん新しい質問";
const BUTTON = "↑最新のプロンプトへ移動↑";
const BOTTOM_PILL = "↓先頭に移動↓";
/** How long to wait for the page to settle on a state (the tail's arrival,
 * a smooth scroll's end). */
const SETTLE_MS = 10_000;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

/** In the page: whether the item of `uuid` is in the Timeline's view below
 * its toolbar. */
function itemInView(uuid: string): boolean {
  const scroller = document.querySelector(".timeline-view");
  const toolbar = document.querySelector(".tl-toolbar");
  const item = document.querySelector(`.tl-lines > [data-timeline-uuid="${uuid}"]`);
  if (scroller === null || toolbar === null || item === null) return false;
  const view = scroller.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  return box.bottom > toolbar.getBoundingClientRect().bottom && box.top < view.bottom;
}

let dir: string;
let webui: Webui;
let session: TestClient;
let transcript: string;
let cwd: string;
let seq = 0;

/** A row of the session's transcript, the n-th written. */
function transcriptRow(kind: "user" | "assistant", text: string, uuid?: string): string {
  seq += 1;
  const id = uuid ?? `e2ec0000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const timestamp = `2026-11-22T00:${String(seq).padStart(2, "0")}:00.000Z`;
  const base = { uuid: id, parentUuid: null, isSidechain: false, timestamp, sessionId: SID, cwd };
  return kind === "user"
    ? row({ ...base, type: "user", message: { role: "user", content: text } })
    : row({
        ...base,
        type: "assistant",
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text }],
        },
      });
}

/** An answer long enough to push the prompt above it far out of the view. */
function longAnswer(label: string): string {
  return Array.from({ length: 60 }, (_, i) => `${label}の段落 ${String(i + 1)}。`).join("\n\n");
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-latest-prompt-");
  webui = await startWebui();
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    transcriptRow("user", "最初の質問") +
      transcriptRow("assistant", longAnswer("最初の答え")) +
      transcriptRow("user", LATEST_TEXT, LATEST_UUID) +
      transcriptRow("assistant", longAnswer("次の答え")),
  );
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: path.join(webui.home, ".claude-e2e"),
  });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `the way back to the newest prompt in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await page.getByText("次の答えの段落 60。").waitFor();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      const button = () => page.getByRole("button", { name: BUTTON });
      const bottomPill = () => page.getByRole("button", { name: BOTTOM_PILL });

      /** Whether the Timeline's scroller is at its bottom, once it is (or what
       * it is when the wait runs out). */
      async function atBottomOnce(): Promise<boolean> {
        const isAtBottom = () =>
          page.evaluate(() => {
            const scroller = document.querySelector(".timeline-view");
            return (
              scroller !== null &&
              scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
            );
          });
        await page
          .waitForFunction(
            () => {
              const scroller = document.querySelector(".timeline-view");
              return (
                scroller !== null &&
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
              );
            },
            undefined,
            { timeout: SETTLE_MS },
          )
          .catch(() => undefined);
        return isAtBottom();
      }

      /** Whether the newest prompt's item is in the view below the toolbar. */
      const latestInView = () => page.evaluate(itemInView, LATEST_UUID);

      test(
        "shown at the bottom of a long Timeline, at the right, last in the rows; the tail is still followed; a click moves to the prompt and the button goes",
        async () => {
          // Not scrolled up: at the bottom, the newest prompt far above the view.
          await button().waitFor({ state: "visible", timeout: SETTLE_MS });
          expect(await latestInView()).toBe(false);
          expect(await atBottomOnce()).toBe(true);
          expect(await bottomPill().isVisible()).toBe(false);
          const placed = await button().evaluate((el) => {
            const lines = el.parentElement;
            const prompt = document.querySelector(".tl-lines > .tl-item-controls-above");
            if (lines === null || prompt === null) return null;
            const drawn = [...lines.children].filter((child) => child.getClientRects().length > 0);
            return {
              last: drawn.at(-1) === el,
              rightGap: prompt.getBoundingClientRect().right - el.getBoundingClientRect().right,
            };
          });
          // The last drawn row, its right edge the prompt bubbles' right edge.
          expect(placed?.last).toBe(true);
          expect(Math.abs(placed?.rightGap ?? Infinity)).toBeLessThanOrEqual(1);

          // A row appended to the transcript and pushed as the session's hooks
          // module does (the daemon reads the jsonl on): the Timeline follows it
          // to the bottom, the button still under it.
          const appended = `${engine.name()} への追記`;
          const appendedUuid = `e2ec0000-0000-4000-8000-1${String(seq).padStart(11, "0")}`;
          fs.appendFileSync(
            transcript,
            transcriptRow("assistant", longAnswer(appended), appendedUuid),
          );
          await pushRows(session, [appendedUuid]);
          await page.getByText(`${appended}の段落 60。`).waitFor({ timeout: SETTLE_MS });
          expect(await atBottomOnce()).toBe(true);
          expect(await button().isVisible()).toBe(true);

          // A click: the prompt comes into the view. The bottom box has left
          // it, so the button goes and the 「↓先頭に移動↓」 comes.
          await button().click();
          await page.waitForFunction(itemInView, LATEST_UUID, { timeout: SETTLE_MS });
          await button().waitFor({ state: "hidden", timeout: SETTLE_MS });
          await bottomPill().waitFor({ state: "visible", timeout: SETTLE_MS });
          expect(page.url()).toContain(`/timeline/${LATEST_UUID}`);
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
