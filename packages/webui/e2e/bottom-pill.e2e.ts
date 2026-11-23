// The 「↓先頭に移動↓」 floating at the bottom of the Timeline in a real browser
// (DR-0054 §11): opened on a long Timeline it is at the bottom and the pill is
// not shown; scrolled up, the end is out of the view and the pill is shown at
// the middle of the view's bottom, clear of the FAB; a click goes to the
// bottom and the pill goes. At the width of a phone and of a desktop.
//
// The visibility is the browser's IntersectionObserver on the real layout,
// which happy-dom does not have. The session is the test's own: a hello on the
// daemon's socket, with a transcript the test wrote in a config dir under the
// daemon's HOME. Nothing reaches a Claude Code session. With `TL_PILL_SHOTS`
// set to a directory, the states are also photographed into it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const LATEST_UUID = "e2ec0000-0000-4000-8000-000000000003";
const LATEST_TEXT = "いちばん新しい質問";
/** How long to wait for the page to settle on a state (the tail's arrival,
 * a smooth scroll's end). */
const SETTLE_MS = 10_000;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

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

const PILL = "↓先頭に移動↓";
const SHOTS = process.env.TL_PILL_SHOTS;

for (const engine of BROWSERS) {
  for (const width of [390, 1280]) {
    describe(`the way to the bottom in ${engine.name()} at ${String(width)}px`, () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await page.getByText("次の答えの段落 60。").waitFor();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      const pill = () => page.getByRole("button", { name: PILL });

      const distanceFromBottom = () =>
        page.evaluate(() => {
          const scroller = document.querySelector(".timeline-view");
          return scroller === null
            ? Infinity
            : scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        });

      async function scrollWithWheel(deltaY: number): Promise<void> {
        const box = await page.locator(".tl-lines").boundingBox();
        await page.mouse.move((box?.x ?? 0) + 60, 500);
        await page.mouse.wheel(0, deltaY);
        await page.waitForTimeout(300);
      }

      async function shot(name: string): Promise<void> {
        if (SHOTS === undefined) return;
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({
          path: path.join(SHOTS, `${engine.name()}-${String(width)}-${name}.png`),
        });
      }

      test(
        "not shown at the bottom; shown at the middle of the view's bottom clear of the FAB when scrolled up; a click goes to the bottom and it goes",
        async () => {
          await page.waitForFunction(
            () => {
              const scroller = document.querySelector(".timeline-view");
              return (
                scroller !== null &&
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
              );
            },
            undefined,
            { timeout: SETTLE_MS },
          );
          await shot("at-bottom");
          expect(await pill().isVisible()).toBe(false);

          // The reader's own wheel: a scrollTop written from the page is held
          // at the bottom by the follow of the tail.
          await scrollWithWheel(-100_000);
          await pill().waitFor({ state: "visible", timeout: SETTLE_MS });
          await shot("scrolled-up");

          const placed = await page.evaluate(() => {
            const scroller = document.querySelector(".timeline-view");
            const pillEl = document.querySelector(".tl-bottom-pill");
            if (scroller === null || pillEl === null) return null;
            const view = scroller.getBoundingClientRect();
            const box = pillEl.getBoundingClientRect();
            const fab = document.querySelector(".session-input-fab");
            const fabBox = fab === null ? null : fab.getBoundingClientRect();
            const overlapsFab =
              fabBox !== null &&
              fabBox.width > 0 &&
              box.left < fabBox.right &&
              box.right > fabBox.left &&
              box.top < fabBox.bottom &&
              box.bottom > fabBox.top;
            return {
              centerGap: box.left + box.width / 2 - (view.left + view.width / 2),
              inside: box.bottom <= view.bottom && box.top >= view.top,
              fromBottom: view.bottom - box.bottom,
              overlapsFab,
            };
          });
          expect(placed?.inside).toBe(true);
          expect(Math.abs(placed?.centerGap ?? Infinity)).toBeLessThanOrEqual(2);
          expect(placed?.fromBottom ?? Infinity).toBeLessThan(40);
          expect(placed?.overlapsFab).toBe(false);

          // The pill stays where it is while the Timeline scrolls.
          await scrollWithWheel(300);
          const moved = await page.evaluate(() => {
            const pillEl = document.querySelector(".tl-bottom-pill");
            return pillEl === null ? null : pillEl.getBoundingClientRect().bottom;
          });
          const before = await page.evaluate(() => {
            const scroller = document.querySelector(".timeline-view");
            return scroller === null ? null : scroller.getBoundingClientRect().bottom;
          });
          expect(Math.abs((before ?? 0) - (moved ?? 0))).toBeLessThan(40);

          // WebKit's click on any button in the Timeline stops at "<html>
          // intercepts pointer events" (as latest-prompt.e2e.ts's does, cause
          // not found): there the click event is sent to the button itself.
          if (engine.name() === "webkit") await pill().dispatchEvent("click");
          else await pill().click();
          await pill().waitFor({ state: "hidden", timeout: SETTLE_MS });
          await page.waitForFunction(
            () => {
              const scroller = document.querySelector(".timeline-view");
              return (
                scroller !== null &&
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
              );
            },
            undefined,
            { timeout: SETTLE_MS },
          );
          expect(await distanceFromBottom()).toBeLessThanOrEqual(1);
        },
        E2E_TIMEOUT_MS,
      );
    });
  }
}
