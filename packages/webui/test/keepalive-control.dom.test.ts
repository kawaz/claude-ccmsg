// The session row's keepalive control (KeepaliveControl): a stop button while
// the gateway plans to extend the session's cache and the daemon can reach
// its pause endpoint, the paused mark once the session's request event says
// so, and nothing for a cold cache. The press reaches llm_keepalive_pause and
// not the row.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { LlmRequestInfo, ReplyOf } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { KeepaliveControl } from "../src/client/components/KeepaliveControl.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const MINUTE = 60_000;

/** The session's latest request, a warm cache with a marker planned. */
function planned(overrides: Partial<LlmRequestInfo> = {}): LlmRequestInfo {
  const ts = Date.now() - 10 * MINUTE;
  return {
    session_id: SID,
    ts,
    model: "claude-fable-5",
    prefix: "p1",
    main: true,
    origin: "main",
    cache_expires_at: ts + 60 * MINUTE,
    cache_since: ts,
    cache_count: 0,
    next_keepalive_at: ts + 55 * MINUTE,
    cache_until: ts + 9 * 60 * MINUTE,
    ...overrides,
  };
}

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

async function mount(
  request: LlmRequestInfo | null,
  options: { available?: boolean; reply?: ReplyOf<"llm_keepalive_pause"> } = {},
): Promise<{ root: HTMLElement; asked: string[]; rowClicks: () => number; store: Store }> {
  const store = createStore(initialState());
  store.dispatch({
    type: "llm-keepalive-pause/availability",
    available: options.available ?? true,
  });
  const asked: string[] = [];
  const reply: ReplyOf<"llm_keepalive_pause"> = options.reply ?? { ok: true };
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    llmKeepalivePause: (sid) => {
      asked.push(sid);
      return Promise.resolve(reply);
    },
  };
  let clicks = 0;
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h("div", { onClick: () => (clicks += 1) }, h(KeepaliveControl, { sid: SID, request })),
      ),
      root,
    ),
  );
  return { root, asked, rowClicks: () => clicks, store };
}

describe("KeepaliveControl", () => {
  test("a press stops the session's keepalive and does not select the row", async () => {
    const { root, asked, rowClicks } = await mount(planned());
    const button = instanceOf(
      root.querySelector("button.session-keepalive"),
      HTMLButtonElement,
      "stop",
    );
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(asked).toEqual([SID]);
    expect(rowClicks()).toBe(0);
  });

  // A failure stays on the button (no timer clears it) and the next press
  // tries again.
  test("a failed stop says why on the button", async () => {
    const { root } = await mount(planned(), {
      reply: { ok: false, error: { code: "llm_keepalive_pause_unavailable", msg: "HTTP 502" } },
    });
    const button = instanceOf(
      root.querySelector("button.session-keepalive"),
      HTMLButtonElement,
      "stop",
    );
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    const after = instanceOf(
      root.querySelector("button.session-keepalive"),
      HTMLButtonElement,
      "stop",
    );
    expect(after.classList.contains("session-keepalive-failed")).toBe(true);
    expect(after.title).toContain("HTTP 502");
  });

  test("a paused session shows the paused mark instead of the button", async () => {
    const { root } = await mount(planned({ cache_paused: true }));
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector(".session-keepalive-paused")?.getAttribute("title")).toContain(
      "keepalive 停止中",
    );
  });

  test("nothing is offered without the capability, for a cold cache, or with no request", async () => {
    expect((await mount(planned(), { available: false })).root.querySelector("button")).toBeNull();
    const cold = planned({
      ts: Date.now() - 3 * 60 * MINUTE,
      cache_expires_at: Date.now() - MINUTE,
    });
    expect((await mount(cold)).root.textContent).toBe("");
    expect((await mount(null)).root.textContent).toBe("");
  });
});
