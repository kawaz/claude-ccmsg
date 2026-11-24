// The Session Search panel as mounted (DR-0021 §2.1 / §2.3): the form opens
// case-sensitive with since / until / timeout, the timeout is searched with
// as clamped and the field shows it so, and the line under the results says
// how far the search read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf, SessionSearchRequest } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionSearchPanel } from "../src/client/components/SessionSearchPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";

withDom();

let roots: HTMLElement[] = [];
let restores: Array<() => void> = [];

beforeEach(() => {
  // Running a search writes its words to the address (replaceNavigation).
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restores.reverse()) restore();
});

type Params = Omit<SessionSearchRequest, "op" | "request_id">;

/** The panel over a ws whose every search is answered `reply`. */
async function mountPanel(
  reply: ReplyOf<"session_search">,
): Promise<{ root: HTMLElement; asked: Params[] }> {
  const store = createStore(initialState());
  const asked: Params[] = [];
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionSearch: (params) => {
      asked.push(params);
      return Promise.resolve(reply);
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(SessionSearchPanel, { onClose: () => {}, query: null }),
      ),
      root,
    ),
  );
  return { root, asked };
}

/** The text input labelled `name` (since / until / timeout (ms)). */
function field(root: HTMLElement, name: string): HTMLInputElement {
  const label = [...root.querySelectorAll(".session-search-mtime")].find((el) =>
    el.textContent?.trim().startsWith(name),
  );
  return instanceOf(label?.querySelector("input"), HTMLInputElement, name);
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(root: HTMLElement): Promise<void> {
  const form = instanceOf(root.querySelector("form"), HTMLFormElement, "form");
  await act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
}

const answered: ReplyOf<"session_search"> = {
  ok: true,
  hits: [],
  files_total: 182,
  files_searched: 84,
  oldest_searched_mtime: new Date(Date.now() - 13 * 86_400_000 - 60_000).toISOString(),
  ended_by: "timeout",
};

describe("Session Search panel", () => {
  test("the form opens case-sensitive, since 5d, until 0, timeout 3000", async () => {
    const { root, asked } = await mountPanel(answered);
    const caseToggle = instanceOf(
      root.querySelector('[title="Case sensitive"]'),
      HTMLButtonElement,
      "Aa",
    );
    expect(caseToggle.getAttribute("aria-pressed")).toBe("true");
    expect(field(root, "since").value).toBe("5d");
    expect(field(root, "until").value).toBe("0");
    expect(field(root, "timeout").value).toBe("3000");

    await submit(root);
    expect(asked).toEqual([{ case_sensitive: true }]);
  });

  test("until and an out-of-range timeout are sent, the timeout clamped and shown so", async () => {
    const { root, asked } = await mountPanel(answered);
    await type(field(root, "until"), "13d");
    await type(field(root, "timeout"), "60000");
    await submit(root);

    expect(asked).toEqual([{ case_sensitive: true, mtime_until: "13d", timeout_ms: 15000 }]);
    expect(field(root, "timeout").value).toBe("15000");

    await type(field(root, "timeout"), "soon");
    await submit(root);
    expect(asked[1]).toEqual({ case_sensitive: true, mtime_until: "13d" });
    expect(field(root, "timeout").value).toBe("3000");
  });

  test("the line under the results says how far the search read", async () => {
    const { root } = await mountPanel(answered);
    await submit(root);
    expect(root.querySelector(".session-search-reach")?.textContent).toBe(
      "候補 182 ファイルのうち 84 ファイル、13 日前まで探した結果",
    );
    expect(root.textContent).not.toContain("打ち切");
  });

  // kawaz 2026-11-24: a row's time is its newest match's, the start of the
  // session is not shown, and the rows stay in the daemon's order (newest
  // match first).
  test("each row shows how long ago its newest match was, in the order answered", async () => {
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const hit = (sid: string, latestMatchAgoMs: number) => ({
      sid,
      config_dir: "/home/u/.claude",
      file: `/home/u/.claude/projects/p/${sid}.jsonl`,
      cwd: `/repos/${sid}`,
      repo: null,
      ws: null,
      latest_match_at: ago(latestMatchAgoMs),
      updated_at: ago(60_000),
      size: 2048,
      matches: [],
      title: null,
    });
    const { root } = await mountPanel({
      ...answered,
      hits: [
        hit("aaaaaaaa-0000-4000-8000-000000000001", 2 * 3_600_000 + 60_000),
        hit("aaaaaaaa-0000-4000-8000-000000000002", 3 * 86_400_000 + 60_000),
      ],
    });
    await submit(root);
    const metas = [...root.querySelectorAll(".session-search-hit-meta")].map((el) =>
      el.textContent?.trim(),
    );
    expect(metas).toEqual(["最新の当たり 2h · 2.0 KB", "最新の当たり 3d · 2.0 KB"]);
    expect(root.textContent).not.toContain("作成");
  });
});
