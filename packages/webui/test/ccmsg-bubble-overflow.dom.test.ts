// A code block in a ccmsg message from another session (the daemon's notice
// of a settings diff, a peer's message) scrolls inside its bubble and never
// widens the TL. The peer bubble sits in a fold beside the fold's guide, a row
// flex, so it is held by the rule every guided content shares (`.tl-guided > *`
// in app.css), not by a rule of its own. happy-dom does no layout, so this pins
// the computed styles the layout depends on; the widths themselves were
// measured in a 390px browser.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { CcmsgBubble } from "../src/client/components/timeline/ccmsg.tsx";
import { AppContext } from "../src/client/context.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

beforeAll(async () => {
  const style = document.createElement("style");
  style.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  document.head.append(style);
});

/** A zero length as happy-dom computes it ("0" or "0px"); unset is "auto". */
const ZERO = /^0(px)?$/;

let root: HTMLElement | null = null;
afterEach(async () => {
  const el = root;
  root = null;
  if (el === null) return;
  await act(() => render(null, el));
  el.remove();
});

const NOTICE = [
  "人が許可依頼の「許可する」で `.claude/settings.local.json` の permissions.allow を書き換えた。すぐ効く (再起動は要らない)。",
  "",
  "```diff",
  "--- .claude/settings.local.json",
  "+++ .claude/settings.local.json",
  "@@ -1,3 +1,3 @@",
  " {",
  '-  "permissions": { "allow": ["Edit(~/.config/a-very-long-file-name-that-does-not-fit-a-phone.toml)"] }',
  '+  "permissions": { "allow": ["Edit(/Users/someone/.config/a-very-long-file-name-that-does-not-fit-a-phone.toml)"] }',
  " }",
  "```",
].join("\n");

async function mountPeerNotice(): Promise<HTMLElement> {
  const store = createStore(initialState());
  const ws = createWsClient((action) => store.dispatch(action));
  const el = document.createElement("div");
  el.className = "tl-lines";
  document.body.append(el);
  root = el;
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(CcmsgBubble, {
          message: { from: "daemon", room: "r1", msg: NOTICE, ts: "" },
          rawText: "",
          now: 0,
          searchKey: "k",
          searchCtx: undefined,
          room: undefined,
          peers: [],
        }),
      ),
      el,
    ),
  );
  return el;
}

// 何を保証するか: ccmsg の peer バブルの code ブロックは他のバブルと同じ部品
// (`.md` の中の `pre.md-code`、overflow-x: auto) で、ガイドの隣の中身は共通の
// 規則で min-width: 0 になる (行 flex の子が pre の最長行まで広がらない)。
// 吹き出しは親の幅を超えない (max-width: 100% / 85%)。
test("the peer bubble's code block scrolls inside the bubble by the rules every bubble shares", async () => {
  const el = await mountPeerNotice();
  const guided = defined(
    el.querySelector<HTMLElement>(".tl-ccmsg-fold > .tl-guided"),
    "the guide row",
  );
  const content = defined(
    guided.querySelector<HTMLElement>(":scope > :not(.tl-fold-guide)"),
    "the content beside the guide",
  );
  expect(getComputedStyle(guided).display).toBe("flex");
  expect(getComputedStyle(content).minWidth).toMatch(ZERO);

  const bubble = defined(content.querySelector<HTMLElement>(".tl-bubble"), "the bubble");
  const body = defined(bubble.querySelector<HTMLElement>(".tl-bubble-body"), "the bubble body");
  expect(getComputedStyle(bubble).minWidth).toMatch(ZERO);
  expect(getComputedStyle(bubble).maxWidth).toBe("85%");
  expect(getComputedStyle(body).maxWidth).toBe("100%");

  const pre = defined(body.querySelector<HTMLElement>(".md pre.md-code"), "the code block");
  expect(getComputedStyle(pre).overflowX).toBe("auto");
  expect(pre.textContent).toContain("+++ .claude/settings.local.json");
});

// 何を保証するか: 送り手の行 (`daemon · <mid>` の長い id) と地の文の切れ目の
// ない長いトークンは、吹き出しの中で折り返す (送り手の行は wrap し子は 0 まで
// 縮む、地の文は overflow-wrap: break-word)。
test("the sender's row and long tokens in the prose wrap inside the bubble", async () => {
  const el = await mountPeerNotice();
  const from = defined(el.querySelector<HTMLElement>(".tl-bubble-from"), "the sender's row");
  expect(getComputedStyle(from).flexWrap).toBe("wrap");
  for (const child of from.children) expect(getComputedStyle(child).minWidth).toMatch(ZERO);
  const md = defined(el.querySelector<HTMLElement>(".tl-bubble-body .md"), "the markdown");
  expect(getComputedStyle(md).overflowWrap).toBe("break-word");
});
