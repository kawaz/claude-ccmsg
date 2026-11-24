// The shared 描画 / ソース and colour choices of ```mermaid diagrams in a real
// browser (DR-0010 §12, §13), on a Timeline whose answer has three tall
// diagrams and a short one at the end, with paragraphs between them:
//
// - the colour switch shows one of the two drawings (light / dark) and the
//   panel under it follows; システム follows the OS's colour scheme
// - a switch pressed (pointer or key) stays where it was on screen while every
//   diagram above it changes size, also at the end of the scroll range, where
//   a spacer holds it and then shrinks away
// - diagrams drawn after the page opened keep the reading position: at the
//   end while the Timeline follows its end, and on a paragraph read below
//   them otherwise
//
// mermaid's entry is held back (Playwright's routing) until the test lets it
// through, so the diagrams draw at a moment the test picks. The session is the
// test's own (a hello on the daemon's socket, a transcript under the daemon's
// HOME); nothing reaches a Claude Code session.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page, Route } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { MERMAID_ENTRY_PATH } from "../src/client/mermaid-asset.ts";
import { MERMAID_THEME_KEY, MERMAID_VIEW_KEY } from "../src/client/mermaid-prefs.ts";
import { defined } from "../test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ed0000-0000-4000-8000-00000000a001";
/** How long a first draw may take: the entry and the chunks come from the
 * daemon, which gzips each the first time it is asked. */
const DRAWN_WITHIN_MS = 30_000;
/** A position kept within this many px counts as kept (WebKit scrolls by
 * whole pixels, so a fractional position comes back rounded). */
const KEPT_PX = 1;

/** A tall diagram (a chain of `n` boxes, top to bottom). */
function diagram(name: string, n: number): string {
  const nodes = Array.from(
    { length: n },
    (_, i) => `${name}${String(i)}[${name} の箱 ${String(i)}]`,
  );
  return "```mermaid\ngraph TD\n  " + nodes.join(" --> ") + "\n```";
}

function paragraphs(label: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${label}の段落 ${String(i + 1)}。`).join("\n\n");
}

const ANSWER = [
  paragraphs("前", 6),
  diagram("A", 10),
  paragraphs("A後", 12),
  diagram("B", 10),
  paragraphs("B後", 12),
  diagram("C", 10),
  paragraphs("C後", 30),
  diagram("D", 3),
  paragraphs("D後", 2),
].join("\n\n");

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-mermaid-prefs-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = (n: number) => ({
    uuid: `e2ed0000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    parentUuid: null,
    isSidechain: false,
    timestamp: `2026-11-22T01:0${String(n)}:00.000Z`,
    sessionId: SID,
    cwd,
  });
  fs.writeFileSync(
    transcript,
    row({ ...head(1), type: "user", message: { role: "user", content: "図で説明して" } }) +
      row({
        ...head(2),
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

/** Open the Timeline with mermaid's entry held back; `release` lets it
 * through. `prefs` are put into localStorage before the page's script runs. */
async function openHeld(
  browser: Browser,
  prefs: Record<string, string> = {},
): Promise<{ page: Page; release: () => Promise<void> }> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, prefs);
  const held: Route[] = [];
  let released = false;
  await page.route(`**${MERMAID_ENTRY_PATH}`, async (route) => {
    if (released) await route.continue();
    else held.push(route);
  });
  await page.goto(`${webui.url}s/${SID}/timeline/head`);
  await page.getByText("D後の段落 2。").waitFor();
  return {
    page,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

/** Wait until the four diagrams are drawn (both drawings of each decoded). */
async function drawn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll("img.md-mermaid-img"));
      return imgs.length === 8 && imgs.every((i) => i instanceof HTMLImageElement && i.complete);
    },
    undefined,
    { timeout: DRAWN_WITHIN_MS },
  );
}

/** Wait until the Timeline's scroller is still: no spacer left, and the same
 * scrollTop over 5 frames. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const scroller = document.querySelector(".timeline-view");
    if (scroller === null) throw new Error("no Timeline");
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let last = -1;
    for (let still = 0; still < 5;) {
      await frame();
      const moving =
        scroller.scrollTop !== last || document.querySelector(".keep-scroll-spacer") !== null;
      still = moving ? 0 : still + 1;
      last = scroller.scrollTop;
    }
  });
}

const figure = (page: Page, i: number): Locator => page.locator(".md-figure").nth(i);
const tabOf = (fig: Locator, label: string): Locator =>
  fig.locator(`[role=tab]:has([data-label="${label}"])`);

/** The top of figure `i`'s row of switches, in the viewport. */
function barTop(page: Page, i: number): Promise<number> {
  return figure(page, i)
    .locator(".md-figure-bar")
    .evaluate((el) => el.getBoundingClientRect().top);
}

/** Scroll the Timeline so that `el`'s top is `y` px below the scroller's top. */
async function placeAt(el: Locator, y: number): Promise<void> {
  await el.evaluate((target, at) => {
    const scroller = document.querySelector(".timeline-view");
    if (scroller === null) throw new Error("no Timeline");
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + offset - at, behavior: "instant" });
  }, y);
}

/** Leave the Timeline's follow of its end, as a reader does (a wheel). */
async function leaveTheEnd(page: Page): Promise<void> {
  const box = await page.locator(".timeline-view").boundingBox();
  if (box === null) throw new Error("no Timeline");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -50);
  await settled(page);
}

function distanceToEnd(page: Page): Promise<number> {
  return page
    .locator(".timeline-view")
    .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

for (const engine of BROWSERS) {
  describe(`shared mermaid choices in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "diagrams drawn while the Timeline follows its end leave it at the end",
      async () => {
        const { page, release } = await openHeld(browser);
        await settled(page);
        expect(await distanceToEnd(page)).toBeLessThanOrEqual(KEPT_PX);
        await release();
        await drawn(page);
        await settled(page);
        expect(await distanceToEnd(page)).toBeLessThanOrEqual(KEPT_PX);
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "描画 pressed while the Timeline follows its end lets go of the follow: the pressed switch stays while every diagram is drawn",
      async () => {
        const { page, release } = await openHeld(browser, { [MERMAID_VIEW_KEY]: "source" });
        await release();
        await settled(page);
        expect(await distanceToEnd(page)).toBeLessThanOrEqual(KEPT_PX);
        const before = await barTop(page, 3);
        await tabOf(figure(page, 3), "描画").click();
        await drawn(page);
        await settled(page);
        expect(Math.abs((await barTop(page, 3)) - before)).toBeLessThanOrEqual(KEPT_PX);
        // The last diagram grew below its switch: the view is no longer at the
        // end (following it would have moved the switch up).
        expect(await distanceToEnd(page)).toBeGreaterThan(100);
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "diagrams drawn above the paragraph being read leave the paragraph where it is",
      async () => {
        const { page, release } = await openHeld(browser);
        await settled(page);
        await leaveTheEnd(page);
        const read = page.getByText("B後の段落 6。");
        await placeAt(read, 300);
        await settled(page);
        const before = await read.evaluate((el) => el.getBoundingClientRect().top);
        // Diagrams A and B start above the view.
        expect(await barTop(page, 1)).toBeLessThan(before);
        await release();
        await drawn(page);
        await settled(page);
        const after = await read.evaluate((el) => el.getBoundingClientRect().top);
        expect(Math.abs(after - before)).toBeLessThanOrEqual(KEPT_PX);
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    describe("switches", () => {
      let page: Page;
      beforeAll(async () => {
        const opened = await openHeld(browser);
        page = opened.page;
        await opened.release();
        await drawn(page);
        await settled(page);
        await leaveTheEnd(page);
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await page.close();
      });
      // Each test starts from 描画 (a failed test may leave ソース chosen).
      beforeEach(async () => {
        if ((await page.locator("img.md-mermaid-img").count()) === 0) {
          await tabOf(figure(page, 0), "描画").click();
          await drawn(page);
        }
      }, E2E_TIMEOUT_MS);

      test(
        "ソース and 描画 on the last diagram switch every diagram and keep the pressed switch in place",
        async () => {
          await placeAt(figure(page, 2), 400);
          await settled(page);
          const before = await barTop(page, 2);
          await tabOf(figure(page, 2), "ソース").click();
          await settled(page);
          expect(Math.abs((await barTop(page, 2)) - before)).toBeLessThanOrEqual(KEPT_PX);
          expect(await page.locator("img.md-mermaid-img").count()).toBe(0);
          expect(await page.locator(".md-figure pre.md-code").count()).toBe(4);
          expect(await page.evaluate((key) => localStorage.getItem(key), MERMAID_VIEW_KEY)).toBe(
            "source",
          );

          await tabOf(figure(page, 2), "描画").click();
          await settled(page);
          expect(Math.abs((await barTop(page, 2)) - before)).toBeLessThanOrEqual(KEPT_PX);
          expect(await page.locator("img.md-mermaid-img").count()).toBe(8);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "a switch chosen with the keyboard stays in place too",
        async () => {
          await placeAt(figure(page, 2), 400);
          await settled(page);
          const before = await barTop(page, 2);
          await tabOf(figure(page, 2), "ソース").focus();
          await page.keyboard.press("Enter");
          await settled(page);
          expect(Math.abs((await barTop(page, 2)) - before)).toBeLessThanOrEqual(KEPT_PX);
          expect(await page.locator("img.md-mermaid-img").count()).toBe(0);
          await tabOf(figure(page, 2), "描画").focus();
          await page.keyboard.press("Enter");
          await settled(page);
          expect(Math.abs((await barTop(page, 2)) - before)).toBeLessThanOrEqual(KEPT_PX);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "at the end of the scroll range, a spacer holds the switch, then shrinks away to the end",
        async () => {
          await page
            .locator(".timeline-view")
            .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
          await settled(page);
          const before = await barTop(page, 3);
          // The last (short) diagram's switch is in the view at the end.
          expect(before).toBeGreaterThan(0);
          expect(before).toBeLessThan(900);
          // From the first frame after the press, until the spacer is gone: the
          // switch is corrected in that frame and starts where it was, then
          // moves smoothly (several steps, one way) to where the end of the
          // range leaves it. That frame can come before anything sent after
          // click() returns runs in the page, so the measuring is asked for by
          // a listener of the click itself: it runs after the switch's own
          // handler, so in that frame it runs after the correction the handler
          // asked for.
          const watching = await page.evaluateHandle(() => {
            const path = new Promise<{ tops: number[]; spacerSeen: boolean }>((resolve) => {
              const measure = () => {
                const tops: number[] = [];
                let spacerSeen = false;
                const tick = () => {
                  const bar = document.querySelectorAll(".md-figure-bar")[3];
                  tops.push(bar?.getBoundingClientRect().top ?? Number.NaN);
                  const spacer = document.querySelector(".timeline-view > .keep-scroll-spacer");
                  if (spacer !== null) spacerSeen = true;
                  else if (spacerSeen) return resolve({ tops, spacerSeen });
                  if (tops.length >= 120) return resolve({ tops, spacerSeen });
                  requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              };
              document.addEventListener("click", measure, { once: true });
            });
            return { path };
          });
          await tabOf(figure(page, 3), "ソース").click();
          const path = await watching.evaluate((w) => w.path);
          await watching.dispose();
          expect(path.spacerSeen).toBe(true);
          expect(Math.abs(defined(path.tops[0], "the first top") - before)).toBeLessThanOrEqual(
            KEPT_PX,
          );
          const steps = path.tops
            .slice(1)
            .map((top, i) => top - defined(path.tops[i], "the top before"));
          expect(steps.every((step) => step >= -KEPT_PX)).toBe(true);
          expect(steps.filter((step) => step > KEPT_PX).length).toBeGreaterThanOrEqual(3);
          await settled(page);
          expect(await page.locator(".keep-scroll-spacer").count()).toBe(0);
          expect(await distanceToEnd(page)).toBeLessThanOrEqual(KEPT_PX);
          await tabOf(figure(page, 3), "描画").click();
          await settled(page);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "ダーク shows every diagram's dark drawing on a dark panel, ライト the light one, システム follows the OS",
        async () => {
          await placeAt(figure(page, 2), 400);
          await settled(page);
          const shown = () =>
            page.evaluate(() =>
              Array.from(document.querySelectorAll("img.md-mermaid-img"))
                .filter((img) => img.getClientRects().length > 0)
                .map((img) => (img.classList.contains("md-mermaid-img-dark") ? "dark" : "light")),
            );
          const panel = () =>
            figure(page, 2)
              .locator(".md-figure-view")
              .evaluate((el) => getComputedStyle(el).backgroundColor);
          await page.emulateMedia({ colorScheme: "light" });
          expect(await shown()).toEqual(["light", "light", "light", "light"]);
          expect(await panel()).toBe("rgb(255, 255, 255)");
          const before = await barTop(page, 2);
          await tabOf(figure(page, 2), "ダーク").click();
          await settled(page);
          expect(await shown()).toEqual(["dark", "dark", "dark", "dark"]);
          expect(await panel()).toBe("rgb(22, 24, 29)");
          expect(Math.abs((await barTop(page, 2)) - before)).toBeLessThanOrEqual(KEPT_PX);
          expect(await page.evaluate((key) => localStorage.getItem(key), MERMAID_THEME_KEY)).toBe(
            "dark",
          );
          await tabOf(figure(page, 0), "ライト").click();
          await settled(page);
          expect(await shown()).toEqual(["light", "light", "light", "light"]);
          await tabOf(figure(page, 2), "システム").click();
          await settled(page);
          expect(await shown()).toEqual(["light", "light", "light", "light"]);
          await page.emulateMedia({ colorScheme: "dark" });
          expect(await shown()).toEqual(["dark", "dark", "dark", "dark"]);
          expect(await panel()).toBe("rgb(22, 24, 29)");
          await page.emulateMedia({ colorScheme: "light" });
        },
        E2E_TIMEOUT_MS,
      );
    });
  });
}
