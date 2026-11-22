// ```svg code blocks in a real browser (DR-0010 §12): the block is drawn as
// an `<img>` of its text (the browser really decodes it as an SVG image), the
// figure stays inside the markdown's box, the tab switches to the code and
// back, and a block that is not a readable SVG falls back to the code once the
// img's load fails.
//
// The page is the component catalog's markdown sample (`/catalog`), which
// renders the markdown in each of its faces with no session behind it. Its
// first ```svg block is a viewBox-only `<svg>` without `xmlns` (the namespace
// is added for the img), its second is broken XML.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

let webui: Webui;
beforeAll(async () => {
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await webui.stop();
});

for (const engine of BROWSERS) {
  describe(`svg code blocks in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(new URL("catalog", webui.url).href);
      await page.locator(".md-svg").first().waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    const blocks = (): Locator => page.locator(".md-svg");
    const tab = (block: Locator, label: string): Locator =>
      block.locator(`[role=tab]:has(.md-svg-tab-label[data-label="${label}"])`);

    test(
      "the block is decoded as an image that fits the markdown box",
      async () => {
        const img = blocks().nth(0).locator("img.md-svg-figure");
        await img.waitFor();
        const facts = await img.evaluate(async (el) => {
          if (!(el instanceof HTMLImageElement)) throw new Error("not an img");
          await el.decode();
          const md = el.closest(".md");
          if (md === null) throw new Error("no .md around the figure");
          return {
            naturalWidth: el.naturalWidth,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
            mdWidth: md.getBoundingClientRect().width,
            alt: el.alt,
          };
        });
        expect(facts.naturalWidth).toBeGreaterThan(0);
        expect(facts.alt).toBe("svg のブロックは図になる");
        expect(facts.width).toBeLessThanOrEqual(facts.mdWidth);
        // viewBox 240×80: the default width keeps the figure's own ratio.
        expect(facts.height).toBeGreaterThan(0);
        expect(Math.abs(facts.width / facts.height - 3)).toBeLessThan(0.05);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "the code tab shows the block's text, the figure tab the image again",
      async () => {
        const block = blocks().nth(0);
        await tab(block, "コード").click();
        const code = block.locator("pre.md-code");
        await code.waitFor();
        expect(await code.textContent()).toContain("<title>svg のブロックは図になる</title>");
        expect(await block.locator("img").count()).toBe(0);
        await tab(block, "図").click();
        await block.locator("img.md-svg-figure").waitFor();
        expect(await block.locator("pre").count()).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a block that is not a readable SVG falls back to the code",
      async () => {
        const block = blocks().nth(1);
        const code = block.locator("pre.md-code");
        await code.waitFor();
        expect(await code.textContent()).toBe(
          '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg',
        );
        expect(await block.locator("img").count()).toBe(0);
        expect(await tab(block, "図").getAttribute("aria-disabled")).toBe("true");
      },
      E2E_TIMEOUT_MS,
    );
  });
}
