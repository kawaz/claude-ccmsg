// The cwd line of the Timeline's mini panel (app.css): the sidebar's
// `.session-cwd` look (the left side cut short, one line, the last directory
// kept) in the ctx line's font and colour, with no value of its own. happy-dom
// does no layout, so this pins the computed styles the layout depends on and
// the rule that keeps the panel's lines clear of the composer FAB (one rule on
// the panel, none on a line); the boxes were checked in Chromium and WebKit at
// 390px and 1280px.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { withDom } from "./dom.ts";

withDom();

beforeAll(async () => {
  const style = document.createElement("style");
  style.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  document.head.append(style);
});

let root: HTMLElement | null = null;
afterEach(() => {
  root?.remove();
  root = null;
});

test("the cwd line keeps to one line and is cut short on the left", () => {
  root = document.createElement("div");
  root.innerHTML = `<div class="tl-status-mini">
    <span class="tl-status-mini-line tl-status-mini-context">x</span>
    <span class="tl-status-mini-line session-cwd"><bdi dir="ltr">/a/b</bdi></span>
  </div>`;
  document.body.append(root);
  const ctxEl = root.querySelector(".tl-status-mini-context");
  const cwdEl = root.querySelector(".session-cwd");
  if (ctxEl === null || cwdEl === null) throw new Error("expected both lines");
  const ctx = getComputedStyle(ctxEl);
  const cwd = getComputedStyle(cwdEl);
  expect(cwd.direction).toBe("rtl");
  expect(cwd.whiteSpace).toBe("nowrap");
  expect(cwd.overflow).toBe("hidden");
  expect(cwd.textOverflow).toBe("ellipsis");
  expect(cwd.fontFamily).toBe(ctx.fontFamily);
  expect(cwd.color).toBe(ctx.color);
});

test("the panel keeps the composer FAB's width free on the right, in one rule on the panel", () => {
  const css = Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .map((rule) => rule.cssText);
  const fabRules = css.filter(
    (text) => text.includes("--composer-fab-size") && text.includes(".tl-status-mini"),
  );
  expect(fabRules).toHaveLength(1);
  const [rule] = fabRules;
  expect(rule).toContain(".session-input-fab:not([hidden])");
  expect(rule).toMatch(/\.tl-status-mini\s*\{/);
  expect(rule).toContain(
    "padding-right: calc(var(--composer-fab-size) + var(--composer-fab-offset))",
  );
  // A line carries no width of its own for the FAB.
  const cwdRules = css.filter((text) => /\.tl-status-mini .session-cwd\s*\{/.test(text));
  expect(cwdRules.length).toBeGreaterThan(0);
  for (const text of cwdRules) expect(text).not.toContain("max-width");
});
