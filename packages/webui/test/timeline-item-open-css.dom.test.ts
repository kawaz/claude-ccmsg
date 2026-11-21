// Whether a Timeline item counts as open, as app.css decides it (DR-0058 §2,
// kawaz 2026-11-11): an item whose folds are all closed hides its jsonl toggle
// and its ☆ (a finger that touched the right edge to scroll pressed them), and
// with jsonl on, its raw lines; an open item in a fold group gets space under
// it. An item is open when one of its outermost folds is open — a fold open
// inside a closed one is not seen. The selectors look at the [open] of the
// fold they test and at nothing else's (app.css's design rationale: an
// ancestor's [open] in a :has() makes every fold's toggle restyle all of what
// it holds), so these cases pin what they must still answer.
//
// 該当なし: a fold open inside a closed one (the item stays closed). happy-dom
// answers a :has() whose argument holds a :not() with an ancestor in it as if
// the :not() were not there, for the selectors before and after alike, so the
// case cannot be told here. It was checked in Chromium and WebKit on the same
// markup, with both selectors (docs/issue/archive/2026-11-21-has-details-open-rules-restyle-whole-document.md).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

let sheet: HTMLStyleElement | null = null;
beforeAll(async () => {
  sheet = document.createElement("style");
  sheet.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  document.head.append(sheet);
});
afterAll(() => {
  sheet?.remove();
  sheet = null;
});

/** An item (`.tl-item`, ItemRawToggle's shape) holding `body`, in a fold
 * group's body when `inGroup` (`open` or closed). */
function mountItem(body: string, opts: { raw?: boolean; inGroup?: "open" | "closed" } = {}) {
  const item = `<div class="tl-item${opts.raw === true ? " tl-item-raw-on" : ""}">
    <button class="tl-item-raw-toggle">jsonl</button>
    ${body}
    ${opts.raw === true ? '<div class="tl-raw-view">raw</div>' : ""}
    <button class="tl-item-star" aria-pressed="false">☆</button>
  </div>`;
  const root = document.createElement("div");
  root.innerHTML =
    opts.inGroup === undefined
      ? item
      : `<details class="tl-fold-group"${opts.inGroup === "open" ? " open" : ""}><summary>2 items</summary>
          <div class="tl-fold-group-body"><div class="tl-guided-content">${item}<div class="tl-item"><p>next</p></div></div></div>
        </details>`;
  document.body.append(root);
  const el = instanceOf(root.querySelector(".tl-item"), HTMLElement, "the item");
  const shown = (selector: string): boolean => {
    const target = instanceOf(el.querySelector(`:scope > ${selector}`), HTMLElement, selector);
    return getComputedStyle(target).display !== "none";
  };
  return { el, shown, remove: () => root.remove() };
}

const fold = (open: boolean, inner = "") =>
  `<details class="tl-fold"${open ? " open" : ""}><summary>fold</summary><div>${inner}</div></details>`;

describe("whether a Timeline item counts as open", () => {
  test("an item with its fold closed hides the jsonl toggle and the ☆", () => {
    const item = mountItem(fold(false));
    expect(item.shown(".tl-item-raw-toggle")).toBe(false);
    expect(item.shown(".tl-item-star")).toBe(false);
    item.remove();
  });

  test("an item with its fold open shows both", () => {
    const item = mountItem(fold(true));
    expect(item.shown(".tl-item-raw-toggle")).toBe(true);
    expect(item.shown(".tl-item-star")).toBe(true);
    item.remove();
  });

  test("an open fold holding a closed one is open", () => {
    const item = mountItem(fold(true, fold(false)));
    expect(item.shown(".tl-item-raw-toggle")).toBe(true);
    item.remove();
  });

  test("one open fold among closed ones is enough", () => {
    const item = mountItem(fold(false) + fold(true));
    expect(item.shown(".tl-item-raw-toggle")).toBe(true);
    item.remove();
  });

  test("an item with no fold always shows its controls", () => {
    const item = mountItem("<p>say</p>");
    expect(item.shown(".tl-item-raw-toggle")).toBe(true);
    expect(item.shown(".tl-item-star")).toBe(true);
    item.remove();
  });

  test("with jsonl on, closing the item's fold hides its raw lines too", () => {
    const closed = mountItem(fold(false), { raw: true });
    expect(closed.shown(".tl-raw-view")).toBe(false);
    closed.remove();
    const open = mountItem(fold(true), { raw: true });
    expect(open.shown(".tl-raw-view")).toBe(true);
    open.remove();
  });

  test("in an open fold group, an open item has space under it and a closed one none", () => {
    const open = mountItem(fold(true), { inGroup: "open" });
    const closed = mountItem(fold(false), { inGroup: "open" });
    expect(getComputedStyle(open.el).marginBottom).not.toBe(
      getComputedStyle(closed.el).marginBottom,
    );
    // The group's own [open] is not what decides it.
    const inClosedGroup = mountItem(fold(true), { inGroup: "closed" });
    expect(getComputedStyle(inClosedGroup.el).marginBottom).toBe(
      getComputedStyle(open.el).marginBottom,
    );
    open.remove();
    closed.remove();
    inClosedGroup.remove();
  });
});
