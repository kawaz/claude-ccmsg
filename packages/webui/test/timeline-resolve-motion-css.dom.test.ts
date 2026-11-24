// How app.css folds away a thread resolved in the 💬 filter (DR-0062 §13,
// kawaz 2026-11-24).
// 何を保証するか:
//   - resolved が切れている間の解決済みのスレッドの項目は、動きの印があってもなくても最後は
//     display: none で隠れ (支援技術からも外れる)、押せない。resolved が入っていれば出る
//   - 縮んで消える・開く動き (transition と @starting-style) は、interpolate-size の使える
//     ブラウザの、動きを減らす設定でない時 (prefers-reduced-motion: no-preference) だけに書いて
//     あり、それ以外では一瞬で切り替わる
// 該当なし: 動きそのもの (高さが縮む途中、下の項目が上がってくること) は happy-dom に描画が
// 無いので測れない。Chromium と WebKit の実物で測った。
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

/** A 💬 filter's list of one item of a resolved thread, marked to move. */
function mount(show: string) {
  const root = document.createElement("div");
  root.innerHTML = `<div class="tl-lines" data-filter="comment" data-comment-show="${show}" data-comment-motion="">
    <div class="tl-item" data-notif="comment" data-thread-order="1" data-thread-motion="">
      <div class="tl-bubble tl-bubble-right tl-bubble-comment" data-comment-kind="comment" data-resolved=""><p>済んだ話</p></div>
    </div>
  </div>`;
  document.body.append(root);
  const item = instanceOf(root.querySelector(".tl-item"), HTMLElement, "the item");
  return { item, remove: () => root.remove() };
}

describe("a resolved thread's item in the 💬 filter", () => {
  test("hidden in the end, and not pressed, while resolved is not checked", () => {
    const { item, remove } = mount("sent comment btw");
    expect(getComputedStyle(item).display).toBe("none");
    expect(getComputedStyle(item).pointerEvents).toBe("none");
    remove();
  });

  test("shown while resolved is checked", () => {
    const { item, remove } = mount("sent comment btw resolved");
    expect(getComputedStyle(item).display).not.toBe("none");
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

describe("the motion is written only where it may run", () => {
  test("every transition and starting style of the fold is under interpolate-size and no-preference", async () => {
    const found = rules(await Bun.file(CSS_URL).text()).filter(
      (rule) =>
        /data-thread-motion|data-comment-motion/.test(rule.prelude) &&
        /transition|height/.test(rule.body),
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const rule of found) {
      expect(rule.within.slice(0, 2)).toEqual([
        "@supports (interpolate-size: allow-keywords)",
        "@media (prefers-reduced-motion: no-preference)",
      ]);
    }
  });
});
