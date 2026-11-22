// The 🔔🔐 badges take their room from where they stand (DR-0050 §3, §7), with
// the same NotificationBadges and the place's class: in the Timeline toolbar,
// the way into the filter, each link has room to press and the two stand
// apart; in a Sessions row the links have no room and nothing between them, so
// the pair is as wide as the two emoji written as text. The styles are pinned
// here from app.css; the boxes they make were measured in Chromium and WebKit
// (docs/findings/2026-11-12-count-badge-counter-inside-emoji.md).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { NotificationBadges } from "../src/client/components/NotificationBadges.tsx";
import { NOTIFICATION_KINDS } from "../src/client/notification-badges.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

/** No room as happy-dom computes it: unset (""), or a zero length. */
const NONE = /^(|0(px)?)$/;

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

async function mount(place: "tl-toolbar-badges" | "session-row-badges"): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(NotificationBadges, {
        class: place,
        kinds: NOTIFICATION_KINDS,
        counts: { say: 1, permit: 0 },
        selected: place === "tl-toolbar-badges" ? "say" : null,
        hrefOf: (kind) => `/s/x/timeline/head?filter=${kind}`,
      }),
      root,
    ),
  );
  return defined(root.querySelector<HTMLElement>(".notif-badges"), "the badges");
}

describe("NotificationBadges by place", () => {
  // 何を保証するか: TL のツールバーのバッジは押せる余白 (上下 --space-2、2.4px)
  // を link に持つ正方形で、間を --space-13 (1rem) 空ける (kawaz 2026-11-22:
  // iPhone で詰まっていて押しづらい)。選択中の面は link の外へはみ出す
  // ::before で、link 自身の枠も影も持たない (面の大きさ・色・押せる範囲は
  // happy-dom が擬似要素を計算しないので e2e の tl-panels.e2e.ts で見る)。
  test("in the Timeline toolbar each link is a square with room above and below, the links stand apart, and the selected one carries no frame of its own", async () => {
    const group = await mount("tl-toolbar-badges");
    expect(getComputedStyle(group).gap).toBe("1rem");
    const [bell, lock] = [...group.querySelectorAll<HTMLElement>(".notif-badge")];
    // Room above and below; across, the link is a square as wide as it is
    // tall (kawaz 2026-11-20): no side padding, its width the height's.
    for (const link of [bell, lock]) {
      const computed = getComputedStyle(defined(link, "a badge"));
      expect(computed.padding).toBe("2.4px 0px");
      expect(computed.inlineSize).toBe("calc(1lh + 2 * 0.15rem)");
    }
    expect(bell?.getAttribute("aria-current")).toBe("true");
    for (const link of [bell, lock]) {
      const computed = getComputedStyle(defined(link, "a badge"));
      expect(computed.boxShadow).toBe("");
      expect(computed.position).toBe("relative");
    }
  });

  // 何を保証するか: Sessions の行のバッジは link に余白を持たず、2 つの間も
  // 空けない (2 つの幅が「🔔🔐」を文字で書いた幅と同じ)。
  test("in a Sessions row the links have no room and nothing stands between them", async () => {
    const group = await mount("session-row-badges");
    expect(getComputedStyle(group).gap).toMatch(NONE);
    for (const link of group.querySelectorAll<HTMLElement>(".notif-badge")) {
      expect(getComputedStyle(link).padding).toMatch(NONE);
    }
  });
});
