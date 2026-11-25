// ```mermaid code blocks in a real browser (DR-0010 §13): the page loads
// mermaid from the daemon (not from the webui's bundle, and from nowhere
// else), draws the block, and shows the result as an `<img>` of the SVG (a
// diagram the browser really decodes, with no `<svg>` put into the page). A
// block mermaid cannot parse stays its source, with mermaid's reason.
//
// The page is the component catalog's markdown sample (`/catalog`): its first
// ```mermaid block is a flowchart, its second has a syntax error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { MERMAID_ASSET_DIR } from "../src/client/mermaid-asset.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

let webui: Webui;
beforeAll(async () => {
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await webui.stop();
});

/** How long a first draw may take: the entry and the chunks of the diagram's
 * kind come from the daemon, which gzips each the first time it is asked. */
const DRAWN_WITHIN_MS = 30_000;

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`mermaid code blocks in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    const requests: string[] = [];
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      page.on("request", (req) => requests.push(req.url()));
      await page.goto(new URL("catalog", webui.url).href);
      await page.locator(".md-figure").first().waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "the flowchart is drawn as an img of an SVG, loaded from the daemon",
      async () => {
        const img = page.locator("img.md-figure-img[alt='mermaid の図']").first();
        await img.waitFor({ timeout: DRAWN_WITHIN_MS });
        const facts = await img.evaluate(async (el) => {
          if (!(el instanceof HTMLImageElement)) throw new Error("not an img");
          await el.decode();
          return {
            naturalWidth: el.naturalWidth,
            src: el.src,
            decoded: decodeURIComponent(el.src.slice(el.src.indexOf(",") + 1)),
          };
        });
        expect(facts.naturalWidth).toBeGreaterThan(0);
        expect(facts.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
        // Labels are SVG text (no foreignObject), so the img draws them.
        expect(facts.decoded).not.toContain("foreignObject");
        expect(facts.decoded).toContain("吹き出し");
        // No live SVG is left in the page's markdown.
        expect(await page.locator(".md svg").count()).toBe(0);
        const origin = new URL(webui.url).origin;
        const mermaidRequests = requests.filter((url) => url.includes("mermaid"));
        expect(mermaidRequests.length).toBeGreaterThan(0);
        for (const url of mermaidRequests) {
          expect(url.startsWith(`${origin}${MERMAID_ASSET_DIR}`)).toBe(true);
        }
        expect(
          requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:")),
        ).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a block mermaid cannot parse stays its source, with the reason",
      async () => {
        const broken = page
          .locator(".md-figure:has(.md-figure-note-error)")
          .filter({ hasText: "a -->" })
          .first();
        await broken.waitFor({ timeout: DRAWN_WITHIN_MS });
        const noteText = await broken.locator(".md-figure-note").textContent();
        expect(noteText?.startsWith("図を描画できない: ")).toBe(true);
        expect(await broken.locator("pre.md-code").textContent()).toBe("graph LR\n  a -->");
      },
      E2E_TIMEOUT_MS,
    );
  });
}
