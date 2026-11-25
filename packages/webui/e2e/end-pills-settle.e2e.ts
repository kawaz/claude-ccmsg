// The two pills at the end of the Timeline in a real browser (DR-0054 §10,
// §11): the 「↑最新のプロンプトへ移動↑」 floats at the end of the row list, so
// shown or hidden it leaves the row list's height, the scroller's height and
// the status lines' box below the list where they are. After an item near the
// end grows while the reader is a few px up from the bottom of a long
// Timeline, which pill is shown, the row list's height and scrollTop stop
// changing within a few frames, and the two are never shown together.
//
// The growth is an element of 14px put into the last item from the page (an
// answer growing as it does when its view is switched). The visibility is the
// browser's IntersectionObserver on the real layout, which happy-dom does not
// have. The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const LATEST_UUID = "e2ec0000-0000-4000-8000-000000000003";
const BUTTON = "↑最新のプロンプトへ移動↑";
/** How long to wait for the page to settle on a state (the tail's arrival). */
const SETTLE_MS = 10_000;
/** Frames sampled after the growth, and how many at the start of them the
 * page may still take to settle. */
const SAMPLED_FRAMES = 30;
const SETTLING_FRAMES = 5;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;
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
  dir = shortTmpDir("ccmsg-e2e-end-pills-");
  webui = await startWebui();
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    transcriptRow("user", "最初の質問") +
      transcriptRow("assistant", longAnswer("最初の答え")) +
      transcriptRow("user", "いちばん新しい質問", LATEST_UUID) +
      transcriptRow("assistant", longAnswer("次の答え")),
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

interface Frame {
  latest: boolean;
  bottom: boolean;
  linesHeight: number;
  scrollTop: number;
}

/** In the page: one sample per animation frame for `count` frames, of the
 * pills shown, the row list's height and the scroller's scrollTop. */
function sampleFrames(count: number): Promise<Frame[]> {
  return new Promise((resolve) => {
    const frames: Frame[] = [];
    const tick = (): void => {
      const scroller = document.querySelector(".timeline-view");
      const lines = document.querySelector(".tl-lines");
      const latest = document.querySelector(".tl-latest-prompt");
      const bottom = document.querySelector(".tl-bottom-pill");
      frames.push({
        latest: latest instanceof HTMLElement && latest.checkVisibility(),
        bottom: bottom instanceof HTMLElement && bottom.checkVisibility(),
        linesHeight: lines === null ? -1 : lines.getBoundingClientRect().height,
        scrollTop: scroller === null ? -1 : scroller.scrollTop,
      });
      if (frames.length < count) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  });
}

/** In the page: grow the last item of the row list by 14px. */
function growLastItem(): void {
  const items = document.querySelectorAll(".tl-lines > [data-timeline-uuid]");
  const extra = document.createElement("div");
  extra.className = "e2e-growth";
  extra.style.height = "14px";
  items[items.length - 1]?.append(extra);
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `the pills at the end after an item grows in ${engine.name()}`,
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

      /** Back at the bottom, the previous test's growth taken out: the button
       * is shown there, the newest prompt far above the view. */
      async function toBottom(): Promise<void> {
        await page.evaluate(() => {
          for (const extra of document.querySelectorAll(".e2e-growth")) extra.remove();
          const scroller = document.querySelector(".timeline-view");
          scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        });
        await page.getByRole("button", { name: BUTTON }).waitFor({ timeout: SETTLE_MS });
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
      }

      /** The reader's own wheel lets the follow of the tail go; then up by `up`
       * px from the bottom. */
      async function upFromBottom(up: number): Promise<void> {
        const box = await page.locator(".tl-lines").boundingBox();
        await page.mouse.move((box?.x ?? 0) + 60, 500);
        await page.mouse.wheel(0, -1);
        await page.evaluate((by) => {
          const scroller = document.querySelector(".timeline-view");
          scroller?.scrollTo({
            top: scroller.scrollHeight - scroller.clientHeight - by,
            behavior: "instant",
          });
        }, up);
      }

      test(
        "shown or hidden, the button leaves the row list's height and the status lines' box where they are",
        async () => {
          await toBottom();
          const layout = () =>
            page.evaluate(() => {
              const scroller = document.querySelector(".timeline-view");
              const lines = document.querySelector(".tl-lines");
              const box = document.querySelector(".tl-bottom-controls");
              if (scroller === null || lines === null || box === null) return null;
              const top = lines.getBoundingClientRect().top;
              return {
                linesHeight: lines.getBoundingClientRect().height,
                scrollHeight: scroller.scrollHeight,
                boxTop: box.getBoundingClientRect().top - top,
              };
            });
          const shown = await layout();
          // Up the list, the status lines out of sight: the button goes.
          await upFromBottom(600);
          await page.getByRole("button", { name: BUTTON }).waitFor({ state: "hidden" });
          expect(shown).not.toBeNull();
          expect(await layout()).toEqual(shown);
        },
        E2E_TIMEOUT_MS,
      );

      // Up from the bottom by these px, the growth moves the status lines' box
      // out of sight (10, 20) or keeps it out (30).
      for (const up of [10, 20, 30]) {
        test(
          `${String(up)}px up from the bottom: settle within a few frames, never both, the row list's height unmoved`,
          async () => {
            await toBottom();
            await upFromBottom(up);
            await sampleFramesIn(page, 10);
            await page.evaluate(growLastItem);
            const frames = await sampleFramesIn(page, SAMPLED_FRAMES);
            const settled = frames.slice(SETTLING_FRAMES);
            const first = settled[0];
            if (first === undefined) throw new Error("no frame was sampled");
            expect({ up, settled }).toEqual({
              up,
              settled: Array.from({ length: settled.length }, () => first),
            });
            expect(frames.filter((frame) => frame.latest && frame.bottom)).toEqual([]);
            // A pill coming or going in the first frames moves nothing.
            expect(new Set(frames.map((frame) => frame.linesHeight)).size).toBe(1);
          },
          E2E_TIMEOUT_MS,
        );
      }
    },
  );
}

function sampleFramesIn(page: Page, count: number): Promise<Frame[]> {
  return page.evaluate(sampleFrames, count);
}
