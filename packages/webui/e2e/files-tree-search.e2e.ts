// The Files tree's name search in a real browser (kawaz 2026-11-22): it stays
// in view while the tree is scrolled down to its end, as the SESSIONS quick
// filter does — at the very top of the tree (no row peeks above it) and on
// top (a point at its middle is the box, not a row passing under it). Wide (1280px) and narrow (390px, the tree stacked
// over the viewer).
//
// Sticky positioning against the tree's own scroller is layout, which
// happy-dom does not do. The session is the test's own (a hello on the
// daemon's socket); nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ef0000-0000-4000-8000-000000000001";
const SETTLE_MS = 10_000;
/** Enough rows to scroll the tree at either width. */
const FILES = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-files-search-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(path.join(cwd, "many"), { recursive: true });
  for (const name of FILES) fs.writeFileSync(path.join(cwd, "many", name), "x\n");
  session = await sessionConn({ sock: webui.sock }, SID, { cwd });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const IN_VIEW = ".session-tab-panel:not([hidden])";

/** Whether the search's bar sits at the top edge of the tree's scroller (no
 * row peeks above it), the box inside the scroller, and the box is what a
 * point at its middle hits. */
function searchInView(page: Page): Promise<boolean> {
  return page.evaluate((scope) => {
    const tree = document.querySelector(`${scope} .file-tree`);
    const bar = document.querySelector(`${scope} .tree-search`);
    const input = document.querySelector(`${scope} .tree-search-input`);
    if (tree === null || bar === null || input === null) return false;
    const view = tree.getBoundingClientRect();
    const atTop = Math.abs(bar.getBoundingClientRect().top - view.top) <= 0.5;
    const box = input.getBoundingClientRect();
    const inside = box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5;
    const hit = document.elementFromPoint(box.left + 8, box.top + box.height / 2);
    return atTop && inside && hit === input;
  }, IN_VIEW);
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`the Files tree's name search in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test(
        `at ${viewport.width}px stays in view with the tree scrolled to its end`,
        async () => {
          const page = await browser.newPage({ viewport });
          try {
            await page.goto(`${webui.url}s/${SID}/files?path=many/${FILES[0]}`);
            const last = page.locator(`${IN_VIEW} .file-tree`).getByText(FILES.at(-1) ?? "");
            await last.waitFor({ state: "attached", timeout: SETTLE_MS });
            const scrolls = await page.evaluate((scope) => {
              const tree = document.querySelector(`${scope} .file-tree`);
              return tree !== null && tree.scrollHeight > tree.clientHeight;
            }, IN_VIEW);
            // The tree does scroll, so the check below means something.
            expect(scrolls).toBe(true);
            expect(await searchInView(page)).toBe(true);

            await page.evaluate((scope) => {
              const tree = document.querySelector(`${scope} .file-tree`);
              tree?.scrollTo({ top: tree.scrollHeight });
            }, IN_VIEW);
            expect(await searchInView(page)).toBe(true);
          } finally {
            await page.close();
          }
        },
        E2E_TIMEOUT_MS,
      );
    }
  });
}
