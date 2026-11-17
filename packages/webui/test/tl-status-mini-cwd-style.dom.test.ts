// The cwd line of the Timeline's mini panel (app.css): the sidebar's
// `.session-cwd` look (the left side cut short, one line, the last directory
// kept) in the ctx line's font and colour, with no value of its own. happy-dom
// does no layout, so this pins the computed styles the layout depends on; the
// boxes were checked in Chromium and WebKit at 390px and 1280px.
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
