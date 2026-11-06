// 吹き出しの足元の行 (BubbleFooter、DR-0049 §8): どの吹き出しも同じ並び
// (時刻 → 翻訳タブ → 付随ボタン) で、タブとボタンは 1 つの hover ツールバーに
// 入り、時刻は常に見える。ts を省略すると時刻を出さない。右寄せの吹き出しは
// 時刻を右端に置ける。訳文のタブは選ばれている間だけ色が変わる class を持つ。
import { afterEach, describe, expect, test } from "bun:test";
import { type ComponentChild, h, render } from "preact";
import { act } from "preact/test-utils";
import { BubbleFooter } from "../src/client/components/timeline/BubbleFooter.tsx";
import type { TranslationAvailability } from "../src/client/components/timeline/translation.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

const WITH_PLAMO: TranslationAvailability = {
  host: false,
  browser: false,
  hostRequest: async () => ({ ok: false, error: { code: "unavailable", msg: "test" } }),
  plamoUrl: "https://translate.example.test",
};
const NO_ROUTE: TranslationAvailability = { ...WITH_PLAMO, plamoUrl: undefined };
const TS = "2026-11-06T10:15:42.000Z";

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

async function mount(node: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  container = root;
  await act(() => render(node, root));
  return root;
}

/** 足元の行の並びを、何が置かれているかの名前で返す (ツールバーの中は
 * その中の並びに展開する)。 */
function slots(root: HTMLElement): string[] {
  const footer = defined(root.querySelector(".tl-bubble-footer"), "the footer row");
  return [...footer.children].flatMap((el) => {
    if (el.classList.contains("tl-bubble-time")) return ["time"];
    return [...el.children].map((inner) =>
      inner.getAttribute("aria-label") === "本文の言語" ? "tabs" : "actions",
    );
  });
}

describe("BubbleFooter", () => {
  test("lays out the time, then the language tabs, then the bubble's own buttons", async () => {
    const root = await mount(
      h(
        BubbleFooter,
        {
          translation: { availability: WITH_PLAMO, tab: "original", onSelect: () => {} },
          ts: TS,
          now: Date.parse(TS) + 60_000,
        },
        h("button", { type: "button", class: "extra" }, "md"),
      ),
    );
    expect(slots(root)).toEqual(["time", "tabs", "actions"]);
    // タブとボタンは hover で出るツールバー、時刻はツールバーの外。
    const footer = defined(root.querySelector(".tl-bubble-footer"), "the footer row");
    expect(footer.querySelectorAll(":scope > .tl-msg-toolbar").length).toBe(1);
    expect(footer.querySelector(".tl-msg-toolbar .tl-bubble-time")).toBeNull();
    expect(footer.querySelector(".tl-msg-toolbar button.extra")?.textContent).toBe("md");
    expect(
      [...footer.querySelectorAll('[aria-label="本文の言語"] .tl-thinking-tab')].map(
        (el) => el.textContent,
      ),
    ).toEqual(["original", "ja(plamo)"]);
  });

  test("without ts there is no time", async () => {
    const root = await mount(
      h(BubbleFooter, {
        translation: { availability: WITH_PLAMO, tab: "original", onSelect: () => {} },
      }),
    );
    expect(slots(root)).toEqual(["tabs"]);
    expect(root.querySelector(".tl-bubble-time")).toBeNull();
  });

  test("timeAtEnd puts the time at the row's right end", async () => {
    const root = await mount(
      h(BubbleFooter, {
        translation: { availability: WITH_PLAMO, tab: "original", onSelect: () => {} },
        ts: TS,
        timeAtEnd: true,
      }),
    );
    expect(slots(root)).toEqual(["tabs", "time"]);
  });

  // 本文が訳文か原文かをタブの色で見分ける (DR-0049 §8): ja(*) のタブだけが
  // 訳文の class を持ち、選ばれるとその class のまま active になる。
  test("only the ja(*) tabs carry the translated-tab class", async () => {
    const root = await mount(
      h(BubbleFooter, {
        translation: {
          availability: { ...WITH_PLAMO, browser: true, host: true },
          tab: "ja-plamo",
          onSelect: () => {},
        },
        ts: TS,
      }),
    );
    const tabs = [...root.querySelectorAll(".tl-thinking-tab")];
    expect(tabs.map((el) => [el.textContent, el.classList.contains("tl-translated-tab")])).toEqual([
      ["original", false],
      ["ja(plamo)", true],
      ["ja(browser)", true],
      ["ja(host)", true],
    ]);
    expect(root.querySelector(".tl-thinking-tab.active")?.textContent).toBe("ja(plamo)");
    expect(
      root.querySelector(".tl-thinking-tab.active")?.classList.contains("tl-translated-tab"),
    ).toBe(true);
  });

  test("with no translation route the tabs are left out and the time stays", async () => {
    const root = await mount(
      h(BubbleFooter, {
        translation: { availability: NO_ROUTE, tab: "original", onSelect: () => {} },
        ts: TS,
      }),
    );
    expect(slots(root)).toEqual(["time"]);
  });

  test("selecting a tab reports it and does not reach the bubble's own click", async () => {
    const selected: string[] = [];
    let bubbleClicks = 0;
    const root = await mount(
      h(
        "div",
        { onClick: () => (bubbleClicks += 1) },
        h(BubbleFooter, {
          translation: {
            availability: WITH_PLAMO,
            tab: "original",
            onSelect: (tab) => selected.push(tab),
          },
          ts: TS,
        }),
      ),
    );
    const plamo = defined(
      [...root.querySelectorAll<HTMLButtonElement>(".tl-thinking-tab")].find(
        (el) => el.textContent === "ja(plamo)",
      ),
      "the ja(plamo) tab",
    );
    await act(() => plamo.click());
    expect(selected).toEqual(["ja-plamo"]);
    expect(bubbleClicks).toBe(0);
  });

  test("open keeps the toolbar shown", async () => {
    const root = await mount(
      h(
        BubbleFooter,
        {
          translation: { availability: WITH_PLAMO, tab: "original", onSelect: () => {} },
          ts: TS,
          open: true,
        },
        h("button", { type: "button" }, "☰"),
      ),
    );
    const toolbars = [...root.querySelectorAll(".tl-msg-toolbar")];
    expect(toolbars.length).toBe(1);
    expect(toolbars.every((el) => el.classList.contains("tl-msg-toolbar-open"))).toBe(true);
  });
});
