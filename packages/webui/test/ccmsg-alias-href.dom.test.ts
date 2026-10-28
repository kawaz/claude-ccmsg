// A link an agent writes in a ccmsg message names the daemon's head name
// (ping's `webui_urls`, DR-0043 §7). Mounted in the TL's ccmsg bubble, the
// link's href moves onto the page's own origin once the daemon has listed the
// names, and its text stays what the agent wrote.
import { afterEach, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { AppContext } from "../src/client/context.ts";
import { CcmsgBubble } from "../src/client/components/timeline/ccmsg.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

let root: HTMLElement | null = null;
afterEach(async () => {
  const el = root;
  root = null;
  if (el === null) return;
  await act(() => render(null, el));
  el.remove();
});

const HEAD = "https://ccmsg.example.ts.net";

test("a markdown link to the head name opens at the current origin, with its text kept", async () => {
  const store = createStore(initialState());
  const ws = createWsClient((action) => store.dispatch(action));
  const el = document.createElement("div");
  document.body.append(el);
  root = el;
  const url = `${HEAD}/s/abc/timeline/head?sb.r=1#m3`;
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(CcmsgBubble, {
          message: { from: "peer", room: "r1", msg: `見て: [TL](${url})`, ts: "" },
          rawText: "",
          now: 0,
          searchKey: "k",
          searchCtx: undefined,
          registerUserTurnRef: () => {},
          onUserTurnClick: () => {},
          selected: false,
          room: undefined,
          peers: [],
        }),
      ),
      el,
    ),
  );
  const link = () => defined(el.querySelector<HTMLAnchorElement>(".tl-ccmsg-msg a"), "the link");

  // Before ping: nothing is known about the names, so the link is off-app.
  expect(link().getAttribute("href")).toBe(url);
  expect(link().target).toBe("_blank");

  await act(() =>
    store.dispatch({
      type: "daemon-info/loaded",
      version: "0.0.0",
      webuiUrls: [HEAD, location.origin],
    }),
  );
  expect(link().getAttribute("href")).toBe(`${location.origin}/s/abc/timeline/head?sb.r=1#m3`);
  // Opens in place like any link to this webui. (Preact clears the property
  // rather than the attribute, so the element may keep an empty `target`.)
  expect(link().target).toBe("");
  expect(link().textContent).toBe("TL");
});
