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
  // 何を保証するか: TL のツールバーのバッジは押せる余白 (上下 --space-2・左右
  // --space-3、2.4px 3.2px) を link に持ち、2 つの間を --space-8 (0.5rem) 空ける。選択中は accent の
  // 面と内側の 1px の枠。
  test("in the Timeline toolbar each link has room to press, the two stand apart, and the selected one is framed inside", async () => {
    const group = await mount("tl-toolbar-badges");
    expect(getComputedStyle(group).gap).toBe("0.5rem");
    const [bell, lock] = [...group.querySelectorAll<HTMLElement>(".notif-badge")];
    for (const link of [bell, lock]) {
      expect(getComputedStyle(defined(link, "a badge")).padding).toBe("2.4px 3.2px");
    }
    expect(bell?.getAttribute("aria-current")).toBe("true");
    expect(getComputedStyle(defined(bell, "the bell")).boxShadow).toStartWith("inset 0 0 0 1px ");
    expect(getComputedStyle(defined(lock, "the lock")).boxShadow).toBe("");
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
