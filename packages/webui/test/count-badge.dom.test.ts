// CountBadge (DR-0050 §3), mounted: what it holds sits in its box with the
// counter inside that box, after the content (laid over its bottom right by
// CSS); no counter at 0, the number from 1, and `99+` past 99 (§9 U14) so the
// counter keeps its width. Where the counter lands (inside the box's bottom
// right, the box as wide as its content) is layout, which happy-dom does not
// compute: that is measured in a browser.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { CountBadge, countBadgeText } from "../src/client/components/CountBadge.tsx";
import { withDom } from "./dom.ts";

withDom();

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
});
