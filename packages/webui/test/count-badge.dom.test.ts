// CountBadge (DR-0050 §3), mounted: what it holds sits in its box with the
// counter inside that box, after the content (laid over its bottom right by
// CSS); no counter at 0, the number from 1, and `99+` past 99 (§9 U14) so the
// counter keeps its width. The styles the counter's place depends on are
// pinned here from app.css; where the counter lands against the emoji's drawn
// picture (inside its bottom right, in Chromium and WebKit) is layout, which
// happy-dom does not compute: that is measured in a browser
// (docs/findings/2026-11-12-count-badge-counter-inside-emoji.md).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { CountBadge, countBadgeText } from "../src/client/components/CountBadge.tsx";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

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

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

async function mount(count: number): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(CountBadge, { count, children: "🔔" }), root));
  return root;
}

describe("CountBadge", () => {
  test("the counter is inside the content's box, after the content", async () => {
    const root = await mount(3);
    const box = root.firstElementChild;
    expect(box?.className).toBe("count-badge");
    expect([...(box?.childNodes ?? [])].map((node) => node.textContent)).toEqual(["🔔", "3"]);
    expect(box?.lastElementChild?.className).toBe("count-badge-counter");
    expect(box?.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  test("no counter at 0, the box holding the content alone", async () => {
    const root = await mount(0);
    expect(root.querySelector(".count-badge-counter")).toBeNull();
    expect(root.querySelector(".count-badge")?.textContent).toBe("🔔");
  });

  test("the counter is the number from 1, and 99+ past 99", async () => {
    expect((await mount(1)).textContent).toBe("🔔1");
    expect((await mount(99)).textContent).toBe("🔔99");
    expect((await mount(100)).textContent).toBe("🔔99+");
    expect(countBadgeText(0)).toBeNull();
    expect(countBadgeText(-1)).toBeNull();
  });

  // 何を保証するか: 箱は inline-block (幅は中身を文字で書いた時と同じ字の
  // 送り) で、カウンターは absolute なので箱の大きさにも周りの位置にも
  // 効かない。カウンターは箱の右端から 4px・下端から 1px 内へ寄せる: 絵文字の
  // 字の送りは描かれた絵より右に広く (16px の Apple Color Emoji で Chromium
  // 4px、WebKit 1〜2px)、その最大の分だけ寄せればどちらでも枠が絵の右端を
  // 越えない (findings 2026-11-12)。
  test("the counter sits over the box by absolute position, set in by the emoji's spare advance", async () => {
    const root = await mount(1);
    const box = defined(root.querySelector<HTMLElement>(".count-badge"), "the box");
    const counter = defined(root.querySelector<HTMLElement>(".count-badge-counter"), "the counter");
    expect(getComputedStyle(box).display).toBe("inline-block");
    expect(getComputedStyle(box).position).toBe("relative");
    expect(getComputedStyle(counter).position).toBe("absolute");
    expect(getComputedStyle(counter).right).toBe("4px");
    expect(getComputedStyle(counter).bottom).toBe("1px");
  });
});
