// The repo line of the Timeline's mini panel (app.css): one line cut short at
// the end, in the ctx line's font and colour, whose link takes the pointer. happy-dom
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

test("the repo line keeps to one line, is cut short at the end, in the ctx line's font and colour", () => {
  root = document.createElement("div");
  root.innerHTML = `<div class="tl-status-mini">
    <span class="tl-status-mini-line tl-status-mini-context">x</span>
    <span class="tl-status-mini-line tl-status-mini-repo"><a class="ctx-link" href="https://example.com/">a/b</a> @main</span>
  </div>`;
  document.body.append(root);
  const ctxEl = root.querySelector(".tl-status-mini-context");
  const repoEl = root.querySelector(".tl-status-mini-repo");
  const linkEl = root.querySelector(".tl-status-mini-repo a");
  if (ctxEl === null || repoEl === null || linkEl === null) throw new Error("expected the lines");
  const ctx = getComputedStyle(ctxEl);
  const repo = getComputedStyle(repoEl);
  // The ordinary end cut (not the sidebar's left cut): the name's first
  // characters are what tell repositories apart.
  expect(repo.direction).not.toBe("rtl");
  expect(repo.whiteSpace).toBe("nowrap");
  expect(repo.overflow).toBe("hidden");
  expect(repo.textOverflow).toBe("ellipsis");
  expect(repo.fontFamily).toBe(ctx.fontFamily);
  expect(repo.color).toBe(ctx.color);
  // The panel takes no pointer (the FAB lies under it); only the link does
  // (happy-dom does not inherit pointer-events, so the panel is read itself).
  const panelEl = root.querySelector(".tl-status-mini");
  if (panelEl === null) throw new Error("expected the panel");
  expect(getComputedStyle(panelEl).pointerEvents).toBe("none");
  expect(getComputedStyle(linkEl).pointerEvents).toBe("auto");
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
  const repoRules = css.filter((text) => /\.tl-status-mini-repo\s*\{/.test(text));
  expect(repoRules.length).toBeGreaterThan(0);
  for (const text of repoRules) expect(text).not.toContain("max-width");
});
