// How app.css draws a resolved thread's item folded to one line (DR-0062 §12,
// P37, kawaz 2026-11-26).
// 何を保証するか:
//   - 畳んだ項目は 1 行だけの吹き出し (ボタン) だけを見せ、元の吹き出し (描いたまま隠したもの)
//     は display: none で隠れて支援技術からも外れる。右上の組 (jsonl ☆) は残る
//   - 畳んだ吹き出しの行は 1 行で、収まらない分は行末を省略の印にして切る (nowrap と
//     text-overflow: ellipsis)。全角の括弧は CSS が付け、読み上げの名前に入れない (代替の文字が空)
//   - 解決済みの吹き出しを薄くしない (薄くする見せ方は畳みに替えた)
//   - 伸び縮みの動き (transition と @starting-style) は、interpolate-size の使えるブラウザの、
//     動きを減らす設定でない時 (prefers-reduced-motion: no-preference) だけに書いてあり、それ
//     以外では一瞬で切り替わる。高さを補間するのは auto との間 (interpolate-size: allow-keywords)
//     で、薄くする (opacity) 動きを持たない
// 該当なし: 伸び縮みの途中の高さは happy-dom に描画が無いので測れない (e2e の resolved-fold)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const CSS_URL = new URL("../src/public/app.css", import.meta.url);
let sheet: HTMLStyleElement | null = null;
beforeAll(async () => {
  sheet = document.createElement("style");
  sheet.textContent = await Bun.file(CSS_URL).text();
  document.head.append(sheet);
});
afterAll(() => {
  sheet?.remove();
  sheet = null;
});

/** A Timeline's list of one item of a resolved thread, folded or not. */
function mount(folded: boolean) {
  const root = document.createElement("div");
  root.innerHTML = `<div class="tl-lines">
    <div class="tl-item"${folded ? " data-folded" : ""} tabindex="-1">
      <button type="button" class="tl-item-raw-toggle">jsonl</button>
      ${
        folded
          ? `<button type="button" class="tl-item-fold tl-bubble tl-bubble-right tl-bubble-comment" aria-expanded="false"><span class="tl-bubble-body tl-item-fold-line"><span class="tl-item-fold-text">✅ 解決済み: 済んだ話</span></span></button>`
          : ""
      }
      <div class="tl-bubble tl-bubble-right tl-bubble-comment" data-comment-kind="comment" data-resolved=""><div class="tl-bubble-body"><p>済んだ話</p></div></div>
      <button type="button" class="tl-item-star">☆</button>
    </div>
  </div>`;
  document.body.append(root);
  const item = instanceOf(root.querySelector(".tl-item"), HTMLElement, "the item");
  const bubble = instanceOf(
    item.querySelector(":scope > .tl-bubble[data-resolved]"),
    HTMLElement,
    "the bubble",
  );
  return { item, bubble, remove: () => root.remove() };
}

describe("a resolved thread's item, folded", () => {
  test("shows its one-line bubble and the corner's pair; its bubble drawn before is hidden", () => {
    const { item, bubble, remove } = mount(true);
    expect(getComputedStyle(bubble).display).toBe("none");
    const fold = instanceOf(item.querySelector(".tl-item-fold"), HTMLElement, "the fold");
    expect(getComputedStyle(fold).display).not.toBe("none");
    for (const pair of item.querySelectorAll(".tl-item-raw-toggle, .tl-item-star")) {
      expect(getComputedStyle(pair).display).not.toBe("none");
    }
    remove();
  });

  test("its line is one line, cut at its end", () => {
    const { item, remove } = mount(true);
    const text = instanceOf(item.querySelector(".tl-item-fold-text"), HTMLElement, "the text");
    expect(getComputedStyle(text).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(text).overflow).toBe("hidden");
    remove();
  });

  test("opened (not folded), its bubble shows, not dimmed", () => {
    const { bubble, remove } = mount(false);
    expect(getComputedStyle(bubble).display).not.toBe("none");
    // No rule gives it an opacity: happy-dom says so with "" (not the
    // initial "1" a browser computes).
    expect(["", "1"]).toContain(getComputedStyle(bubble).opacity);
    remove();
  });
});

/** Each rule of `css`: its prelude and the preludes of the blocks around it. */
function rules(css: string): { prelude: string; within: string[]; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { prelude: string; within: string[]; body: string }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      stack.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (c === "}") {
      const prelude = stack.pop() ?? "";
      const body = text.slice(start, i);
      if (!body.includes("{")) out.push({ prelude, within: [...stack], body });
      start = i + 1;
    }
  }
  return out;
}

describe("the brackets and the motion", () => {
  test("the full-width brackets are CSS's, with no words for the name", async () => {
    const found = rules(await Bun.file(CSS_URL).text()).filter((rule) =>
      /\.tl-item-fold-line::(before|after)/.test(rule.prelude),
    );
    const contents = found.map((rule) => /content:\s*([^;]+);/.exec(rule.body)?.[1]?.trim());
    expect(new Set(contents)).toEqual(new Set(['"（" / ""', '"）" / ""']));
  });

  test("every transition and starting style of the fold is under interpolate-size and no-preference", async () => {
    const found = rules(await Bun.file(CSS_URL).text()).filter(
      (rule) =>
        /data-fold-motion/.test(rule.prelude) && /transition|height|animation/.test(rule.body),
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const rule of found) {
      expect(rule.within.slice(0, 2)).toEqual([
        "@supports (interpolate-size: allow-keywords)",
        "@media (prefers-reduced-motion: no-preference)",
      ]);
      // The frame does not fade: only its height moves (P37).
      expect(rule.body).not.toMatch(/opacity/);
    }
    expect(found.some((rule) => /interpolate-size:\s*allow-keywords/.test(rule.body))).toBe(true);
  });
});
