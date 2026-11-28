// How app.css draws an item folded to one line (DR-0062 §12, P37; DR-0068 §5;
// kawaz 2026-11-28).
// 何を保証するか:
//   - 畳んだ項目は元の吹き出しをそのまま見せ (display: none にしない)、枠 (.tl-bubble-body) の
//     高さを 1 行の高さ (--tl-item-fold-height) にする。本文の箱は自分で 1 行に切って行末を
//     省略の印にする (-webkit-line-clamp: 1)。本文の前の頭の行 (.tl-comment-on) と中のボタンの
//     行 (.tl-comment-reply-row) は出さず、枠の下の行 (.tl-bubble-footer) は高さを 0 にして
//     隠す。右上の組 (jsonl ☆) は残る
//   - 枠のラベルは CSS の字 (--tl-item-fold-label) で、代替の文字を空にして選択・コピー・
//     読み上げに入れない。枠を基準に置いて枠の上辺に重ね、枠は畳んでいる間は切らない (ラベルを
//     切らない)。縮む動きの間 (枠が切る間) は出さない
//   - 開くボタン (.tl-item-fold) は見た目を持たない (visually-hidden)
//   - 開いた (畳んでいない) 項目は何も切らず、薄くしない
//   - 伸び縮みの動き (transition) は、interpolate-size の使えるブラウザの、動きを減らす設定で
//     ない時 (prefers-reduced-motion: no-preference) だけに書いてあり、それ以外では一瞬で
//     切り替わる。高さを補間するのは auto との間 (interpolate-size: allow-keywords) で、薄くする
//     (opacity) 動きを持たない
// 該当なし: 1 行に縮んだ見え方・ラベルの位置・伸び縮みの途中の高さは happy-dom に描画が無いので
// 測れない (e2e の read-fold と resolved-fold)。
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
    <div class="tl-item"${folded ? ' data-folded style="--tl-item-fold-label: &quot;✅解決済み&quot;"' : ""} tabindex="-1">
      <button type="button" class="tl-item-raw-toggle">jsonl</button>
      ${folded ? '<button type="button" class="tl-item-fold" aria-expanded="false" aria-label="✅解決済み"></button>' : ""}
      <div class="tl-bubble tl-bubble-right tl-bubble-comment" data-comment-kind="comment" data-resolved="">
        <div class="tl-bubble-body">
          <div class="tl-comment-on"><span class="tl-comment-label">💬 コメント</span></div>
          <div class="tl-comment-body"><div class="md"><p>済んだ話</p><p>二段落目</p></div></div>
          <div class="tl-comment-reply-row"><button type="button" class="tl-comment-resolve">✅解決済み</button></div>
        </div>
        <div class="tl-bubble-footer"><span class="tl-bubble-time">00:00</span></div>
      </div>
      <button type="button" class="tl-item-star">☆</button>
    </div>
  </div>`;
  document.body.append(root);
  const item = instanceOf(root.querySelector(".tl-item"), HTMLElement, "the item");
  const part = (selector: string) =>
    instanceOf(item.querySelector(selector), HTMLElement, selector);
  return { item, part, remove: () => root.remove() };
}

describe("an item, folded", () => {
  test("its bubble is drawn, its frame cut to one line's height", () => {
    const { item, part, remove } = mount(true);
    expect(getComputedStyle(part(".tl-bubble")).display).not.toBe("none");
    const frame = getComputedStyle(part(".tl-bubble-body"));
    expect(frame.display).not.toBe("none");
    // Its height (a calc of its line, which happy-dom does not compute) is
    // read from the rule below; here, that it may be that low, and does not
    // cut (its text box cuts itself; the label on its edge is not cut).
    expect(frame.overflow).toBe("visible");
    expect(frame.position).toBe("relative");
    expect(frame.minHeight).toBe("0");
    for (const pair of item.querySelectorAll(".tl-item-raw-toggle, .tl-item-star")) {
      expect(getComputedStyle(pair).display).not.toBe("none");
    }
    remove();
  });

  test("its text box is cut at its first line; its head and buttons are not shown; the row under it has no height", () => {
    const { part, remove } = mount(true);
    // Its line clamp (which happy-dom does not compute) is read from the rule
    // below; here, that it cuts.
    expect(getComputedStyle(part(".tl-comment-body")).overflow).toBe("clip");
    expect(getComputedStyle(part(".tl-comment-on")).display).toBe("none");
    expect(getComputedStyle(part(".tl-comment-reply-row")).display).toBe("none");
    const footer = getComputedStyle(part(".tl-bubble-footer"));
    expect(footer.height).toBe("0px");
    expect(footer.visibility).toBe("hidden");
    // Its text is as written: nothing put before it.
    expect(part(".tl-comment-body").textContent).toBe("済んだ話二段落目");
    remove();
  });

  test("its open button has no look of its own", () => {
    const { part, remove } = mount(true);
    const button = getComputedStyle(part(".tl-item-fold"));
    expect(button.position).toBe("absolute");
    expect(button.width).toBe("1px");
    expect(button.height).toBe("1px");
    remove();
  });

  test("opened (not folded), nothing is cut, and it is not dimmed", () => {
    const { part, remove } = mount(false);
    const frame = getComputedStyle(part(".tl-bubble-body"));
    expect(frame.height).not.toBe("var(--tl-item-fold-height)");
    expect(getComputedStyle(part(".tl-comment-on")).display).not.toBe("none");
    expect(getComputedStyle(part(".tl-comment-reply-row")).display).not.toBe("none");
    expect(getComputedStyle(part(".tl-bubble-footer")).visibility).not.toBe("hidden");
    // No rule gives it an opacity: happy-dom says so with "" (not the
    // initial "1" a browser computes).
    expect(["", "1"]).toContain(getComputedStyle(part(".tl-bubble")).opacity);
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

describe("the frame, the label and the motion", () => {
  test("the frame's height is one line's, and its text box is cut at its first line with an ellipsis", async () => {
    const found = rules(await Bun.file(CSS_URL).text()).filter((rule) =>
      /\.tl-item\[data-folded\] > \.tl-bubble > \.tl-bubble-body,/.test(rule.prelude),
    );
    expect(found.map((rule) => rule.body).join("")).toMatch(
      /height:\s*var\(--tl-item-fold-height\)/,
    );
    const clamped = rules(await Bun.file(CSS_URL).text()).filter(
      (rule) => /data-folded/.test(rule.prelude) && /\.tl-comment-body/.test(rule.prelude),
    );
    expect(clamped.some((rule) => /-webkit-line-clamp:\s*1;/.test(rule.body))).toBe(true);
  });

  test("the label is CSS's words with no alternative text, put on the frame's top edge; not seen while it shrinks", async () => {
    const all = rules(await Bun.file(CSS_URL).text());
    const found = all.filter(
      (rule) => /data-folded/.test(rule.prelude) && /::before/.test(rule.prelude),
    );
    expect(found.length).toBe(1);
    const body = found[0]?.body ?? "";
    expect(body).toMatch(/content:\s*var\(--tl-item-fold-label\)\s*\/\s*""/);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/translate:\s*0 -50%/);
    // While it shrinks its frame cuts what is in it: the label waits.
    const closing = all.filter(
      (rule) => /data-fold-motion="close"/.test(rule.prelude) && /::before/.test(rule.prelude),
    );
    expect(closing.length).toBe(1);
    expect(closing[0]?.body).toMatch(/visibility:\s*hidden/);
    expect(closing[0]?.within.slice(0, 2)).toEqual([
      "@supports (interpolate-size: allow-keywords)",
      "@media (prefers-reduced-motion: no-preference)",
    ]);
  });

  test("every transition of the fold is under interpolate-size and no-preference", async () => {
    const found = rules(await Bun.file(CSS_URL).text()).filter(
      (rule) =>
        /data-fold-motion/.test(rule.prelude) && /transition|height|animation/.test(rule.body),
    );
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const rule of found) {
      expect(rule.within.slice(0, 2)).toEqual([
        "@supports (interpolate-size: allow-keywords)",
        "@media (prefers-reduced-motion: no-preference)",
      ]);
      // The frame does not fade: only its height moves (P37).
      expect(rule.body).not.toMatch(/opacity/);
    }
    expect(found.some((rule) => /interpolate-size:\s*allow-keywords/.test(rule.body))).toBe(true);
    // No transition is written for the fold outside them.
    const outside = rules(await Bun.file(CSS_URL).text()).filter(
      (rule) =>
        /data-fold(ed|-motion)/.test(rule.prelude) &&
        /transition/.test(rule.body) &&
        !rule.within.includes("@media (prefers-reduced-motion: no-preference)"),
    );
    expect(outside).toEqual([]);
  });
});
