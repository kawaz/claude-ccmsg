// Labels that take turns in one place without the place changing size
// (StackedLabels, DR-0058 §3), and its users:
// - every candidate is in the box, laid in the same grid cell, and only the
//   one `data-shown` names is visible (app.css): the box is as large as the
//   largest candidate whichever shows
// - the ☆ / ⭐ (StarMark) and the SESSIONS sort button keep the same box
//   element while their label changes; the sort button names itself with the
//   shown mode
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { PeersSortButton } from "../src/client/components/Sidebar.tsx";
import { StackedLabels } from "../src/client/components/StackedLabels.tsx";
import { StarMark } from "../src/client/components/StarMark.tsx";
import { nextPeerSortKey, PEER_SORT_KEYS, type PeerSortKey } from "../src/client/utils.ts";
import { withDom } from "./dom.ts";

withDom();

let style: HTMLStyleElement | null = null;
beforeAll(async () => {
  style = document.createElement("style");
  // The sheet fed as one line, as the other CSS tests do.
  const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  style.textContent = css.replace(/\s+/g, " ");
  document.head.append(style);
});
afterAll(() => style?.remove());

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

async function mount(vnode: Parameters<typeof render>[0]): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(vnode, root));
  return root;
}

/** Each candidate's text, its grid area and whether it is visible. */
function candidates(box: Element): Array<[string, string, boolean]> {
  return [...box.children].map((child) => {
    const computed = getComputedStyle(child);
    return [child.textContent ?? "", computed.gridArea, computed.visibility !== "hidden"];
  });
}

describe("StackedLabels", () => {
  test("lays every candidate in one cell and shows only the one data-shown names", async () => {
    for (let shown = 0; shown < 4; shown++) {
      const labels = ["a", "bb", "ccc", "dddd"];
      const root = await mount(h(StackedLabels, { labels, shown }));
      const box = root.querySelector(".stacked-labels");
      if (box === null) throw new Error("no box");
      expect(box.getAttribute("data-shown")).toBe(String(shown));
      expect(getComputedStyle(box).display).toBe("inline-grid");
      const shownOnes = candidates(box).filter(([, , visible]) => visible);
      expect(shownOnes.map(([text]) => text)).toEqual(labels.slice(shown, shown + 1));
      expect(new Set(candidates(box).map(([, area]) => area)).size).toBe(1);
    }
  });

  test("StarMark is the two stars, ☆ off and ⭐ on", async () => {
    const root = await mount(h(StarMark, { on: false }));
    const box = root.querySelector(".stacked-labels.star-mark");
    if (box === null) throw new Error("no star");
    expect(candidates(box).map(([text, , visible]) => [text, visible])).toEqual([
      ["☆", true],
      ["⭐", false],
    ]);
  });
});

describe("the SESSIONS sort button", () => {
  test("holds every mode's label and switches the shown one in the same box", async () => {
    let key: PeerSortKey = "prompt";
    const root = document.createElement("div");
    document.body.append(root);
    roots.push(root);
    const draw = () =>
      act(() =>
        render(
          h(PeersSortButton, {
            sortKey: key,
            onCycle: () => {
              key = nextPeerSortKey(key);
            },
          }),
          root,
        ),
      );
    await draw();
    const button = root.querySelector("#peers-sort");
    const box = button?.querySelector(":scope > .stacked-labels");
    if (!(button instanceof HTMLButtonElement) || box === null || box === undefined) {
      throw new Error("no sort button");
    }
    const seen: string[] = [];
    for (let i = 0; i < PEER_SORT_KEYS.length; i++) {
      expect(button.querySelector(":scope > .stacked-labels")).toBe(box);
      expect(candidates(box).map(([text]) => text)).toEqual([
        "prompt",
        "name",
        "created",
        "recent",
      ]);
      const visible = candidates(box)
        .filter(([, , v]) => v)
        .map(([text]) => text);
      expect(visible).toEqual([button.getAttribute("aria-label") ?? ""]);
      seen.push(visible[0] ?? "");
      button.click();
      await draw();
    }
    expect(seen).toEqual(["prompt", "name", "created", "recent"]);
  });
});
