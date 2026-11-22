// TeX math in a real browser (DR-0010 §14): Temml's MathML, put through
// DOMPurify, is drawn in the page in the MathML namespace, with the TeX kept as
// the annotation; equation numbers are written as text; a formula Temml cannot
// draw (or refuses, trust: false) shows its TeX with the reason; Temml's
// stylesheet (with its font inlined) is added once math is drawn.
//
// The page is the component catalog's markdown sample (`/catalog`), drawn in
// each of its faces. Its math: inline `$e^{i\pi} + 1 = 0$`, a paragraph that is
// one `$$…$$`, a ```math block with an equation, and two that cannot be drawn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

let webui: Webui;
beforeAll(async () => {
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await webui.stop();
});

const MATHML = "http://www.w3.org/1998/Math/MathML";

for (const engine of BROWSERS) {
  describe(`TeX math in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(new URL("catalog", webui.url).href);
      await page.locator(".md-math math").first().waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "inline and display math are MathML with the TeX as the annotation",
      async () => {
        const facts = await page.evaluate((ns) => {
          const md = document.querySelector(".md-math")?.closest(".md") ?? null;
          if (md === null) throw new Error("no .md");
          const inline = md.querySelector("p > .md-math:not(.md-math-display) math");
          const block = md.querySelector("div.md-math.md-math-display math");
          const box = inline?.getBoundingClientRect();
          return {
            inlineNs: inline?.namespaceURI,
            inlineTex: inline?.querySelector("annotation")?.textContent,
            inlineDrawn: box !== undefined && box.width > 0 && box.height > 0,
            blockDisplay: block?.getAttribute("display"),
            blockNs: block?.namespaceURI === ns,
            ids: md.querySelectorAll("math [id]").length,
            links: md.querySelectorAll("math a").length,
          };
        }, MATHML);
        expect(facts.inlineNs).toBe(MATHML);
        expect(facts.inlineTex).toBe("e^{i\\pi} + 1 = 0");
        expect(facts.inlineDrawn).toBe(true);
        expect(facts.blockDisplay).toBe("block");
        expect(facts.blockNs).toBe(true);
        expect(facts.ids).toBe(0);
        expect(facts.links).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a ```math block's equation is numbered in text, in the figure box",
      async () => {
        const numbers = await page.evaluate(() => {
          const md = document.querySelector(".md-math")?.closest(".md") ?? null;
          return Array.from(md?.querySelectorAll(".md-figure-view math mtext") ?? [])
            .map((el) => el.textContent ?? "")
            .filter((text) => /^\(\d+\)$/.test(text));
        });
        expect(numbers).toEqual(["(1)"]);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "formulas Temml cannot draw or refuses show their TeX with the reason",
      async () => {
        const errors = await page.evaluate(() => {
          const md = document.querySelector(".md-math")?.closest(".md") ?? null;
          return Array.from(md?.querySelectorAll(".md-math-error") ?? []).map((el) => ({
            tex: el.querySelector("code")?.textContent,
            reason: el.querySelector(".md-math-error-msg")?.textContent ?? "",
          }));
        });
        expect(errors.map((e) => e.tex)).toEqual(["\\frac{1}", "\\href{https://example.com}{x}"]);
        for (const e of errors) expect(e.reason.startsWith("数式を描画できない: ")).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "Temml's stylesheet is added once, with its font inlined",
      async () => {
        const sheets = await page.evaluate(() =>
          document.adoptedStyleSheets.map((sheet) =>
            Array.from(sheet.cssRules)
              .map((rule) => rule.cssText)
              .join("\n"),
          ),
        );
        const temml = sheets.filter((text) => text.includes(".tml-"));
        expect(temml.length).toBe(1);
        expect(temml[0]).toContain("data:font/woff2;base64,");
      },
      E2E_TIMEOUT_MS,
    );
  });
}
