// The Status tab's identity table, mounted: NAME is an input from the start
// and the place to rename the session (DR-0047 §4) — Enter sends the name with
// `session_rename`, Escape puts the shown name back, and the outcome shows only
// in the input's look (pulsing while the answer is out, the danger colour on an
// error until the value changes). Each copy button sits before the value it
// copies, CONTEXT shows the usage alone (its fill also as a meter), the
// tables come in the order of what matters (the gauges of what it runs as,
// what the session is, its identifiers), and there is no input to a subagent here
// (the composer's destination select is where that is chosen).
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  PeerInfo,
  ReplyOf,
  RequestOverrideResponse,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000005";
const SINCE = "2026-11-09T01:00:00.000Z";

const SNAPSHOT: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  // A running subagent: its input is the composer's, not this tab's.
  subagents: [{ id: "a1", type: "Explore", description: "調査" }],
  context: {
    tokens: 56_000,
    window: 200_000,
    model: "claude-fable-5-1",
    effort: "low",
    timestamp: SINCE,
  },
};

/** The session's agents row. `turn` present = a hooks module speaks for it. */
function agentRow(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    pid: 4242,
    cwd: "/w/repo",
    kind: "interactive",
    startedAt: Date.now(),
    entrypoint: "claude-desktop",
    sessionId: SID,
    config_dir: "/c",
    name: "最初の名前",
    hyoui_session_id: "hy-7",
    turn: { state: "idle", since: SINCE },
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

interface Mounted {
  root: HTMLElement;
  store: Store;
  /** Every `session_rename` the panel sent, as `[sid, title]`. */
  renames: Array<[string, string]>;
}

/** Mount the Status tab with `agent` as the session's agents row (none when
 * undefined). `reply` is what the daemon answers each `session_rename` with. */
async function mountStatus(
  agent: AgentInfo | undefined,
  reply: (title: string) => Promise<ReplyOf<"session_rename">> = (title) =>
    Promise.resolve({ ok: true, title, outcome: "renamed" }),
  env: Record<string, string> = {},
): Promise<Mounted> {
  const store = createStore(initialState());
  if (agent) store.dispatch({ type: "agents/loaded", agents: [agent] });
  const renames: Array<[string, string]> = [];
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionRename: (sid: string, title: string): Promise<ReplyOf<"session_rename">> => {
      renames.push([sid, title]);
      return reply(title);
    },
  };
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, terminated: true });
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  function Host() {
    const restart = useSessionRestart(SID, onRestart);
    return h(StatusPanel, {
      shown: true,
      snapshot: SNAPSHOT,
      sid: SID,
      onKill,
      restart,
      onLoadEnv,
      onOverride,
    });
  }
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, h(Host, null)), root));
  return { root, store, renames };
}

/** The `<dd>` the identity table puts under `term`. */
function metaCell(root: HTMLElement, term: string): HTMLElement {
  const dt = [...root.querySelectorAll(".status-meta dt")].find((d) => d.textContent === term);
  return instanceOf(dt?.nextElementSibling, HTMLElement, `the ${term} value`);
}

function titleInput(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    metaCell(root, "NAME").querySelector("input"),
    HTMLInputElement,
    "the NAME input",
  );
}

/** The input's outcome classes, in a fixed order. */
function titleState(root: HTMLElement): string[] {
  const list = titleInput(root).classList;
  return ["status-title-input-saving", "status-title-input-failed"].filter((c) => list.contains(c));
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press `key` in the input and let a send it starts settle inside the same
 * `act`. The stubbed `sessionRename` answers with an already-resolved promise
 * by default, so the panel's continuation after it is queued before the one
 * awaited here. */
async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("Status tab NAME input", () => {
  test("starts as an input holding the session's name, writable and unmarked", async () => {
    const { root } = await mountStatus(agentRow());
    const input = titleInput(root);
    expect(input.value).toBe("最初の名前");
    expect(input.readOnly).toBe(false);
    expect(titleState(root)).toEqual([]);
    expect(metaCell(root, "NAME").textContent).not.toContain("名前を変更");
  });

  test("Enter sends the trimmed name for this session", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "  新しい名前 ");
    await press(input, "Enter");
    expect(renames).toEqual([[SID, "新しい名前"]]);
  });

  test("pulses while the answer is out and returns to normal on it", async () => {
    let answer: (reply: ReplyOf<"session_rename">) => void = () => {};
    const { root } = await mountStatus(
      agentRow(),
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const input = titleInput(root);
    await type(input, "後の名前");
    await press(input, "Enter");
    expect(titleState(root)).toEqual(["status-title-input-saving"]);
    await act(async () => {
      answer({ ok: true, title: "後の名前", outcome: "queued" });
      await Promise.resolve();
    });
    expect(titleState(root)).toEqual([]);
    // What was sent stays while the session has yet to take it; the old name
    // does not come back in the meantime.
    expect(input.value).toBe("後の名前");
    // No text beside the input: the cell's only text is the copy button's
    // (hidden) mark.
    expect(metaCell(root, "NAME").textContent).toBe("✓");
  });

  test("an error marks the input, keeps the draft, and clears once the value changes", async () => {
    const { root } = await mountStatus(agentRow(), () =>
      Promise.resolve({
        ok: false,
        error: { code: "rename_failed", msg: "名前を変えられなかった" },
      }),
    );
    const input = titleInput(root);
    await type(input, "通らない名前");
    await press(input, "Enter");
    expect(input.value).toBe("通らない名前");
    expect(titleState(root)).toEqual(["status-title-input-failed"]);
    expect(input.title).toBe("名前を変えられなかった");
    expect(metaCell(root, "NAME").textContent).not.toContain("名前を変えられなかった");
    await type(input, "通らない名前2");
    expect(titleState(root)).toEqual([]);
  });

  test("a session no hooks module speaks for can still send, and shows the error", async () => {
    const { turn: _turn, ...bare } = agentRow();
    const { root, renames } = await mountStatus(bare, () =>
      Promise.resolve({ ok: false, error: { code: "no_module", msg: "no module" } }),
    );
    const input = titleInput(root);
    expect(input.readOnly).toBe(false);
    await type(input, "新しい名前");
    await press(input, "Enter");
    expect(renames).toEqual([[SID, "新しい名前"]]);
    expect(titleState(root)).toEqual(["status-title-input-failed"]);
  });

  test("Escape puts the shown name back without sending", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "やめる名前");
    await press(input, "Escape");
    expect(input.value).toBe("最初の名前");
    expect(renames).toEqual([]);
  });

  test("an empty or unchanged name is not sent", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "   ");
    await press(input, "Enter");
    await type(input, "最初の名前");
    await press(input, "Enter");
    expect(renames).toEqual([]);
    expect(input.value).toBe("最初の名前");
  });

  test("after a send, follows the agents rows' name once it changes", async () => {
    const { root, store } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, " 新しい名前 ");
    await press(input, "Enter");
    expect(input.value).toBe("新しい名前");
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "新しい名前" })] }),
    );
    expect(input.value).toBe("新しい名前");
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "その後の名前" })] }),
    );
    expect(input.value).toBe("その後の名前");
  });

  test("follows the agents rows' name, but not while being edited", async () => {
    const { root, store } = await mountStatus(agentRow());
    const input = titleInput(root);
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "二番目" })] }),
    );
    expect(input.value).toBe("二番目");

    await type(input, "書きかけ");
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "三番目" })] }),
    );
    expect(input.value).toBe("書きかけ");

    await press(input, "Escape");
    expect(input.value).toBe("三番目");
  });
});

describe("Status tab copy buttons", () => {
  test("sit before the value they copy", async () => {
    const { root } = await mountStatus(agentRow());
    for (const term of [
      "NAME",
      "CWD",
      "SESSION_ID",
      "PID",
      "HYOUI_SESSION_ID",
      "KIND",
      "ENTRYPOINT",
      "STARTED",
      "UPTIME",
    ]) {
      const cell = metaCell(root, term);
      const first = cell.firstElementChild;
      expect(first?.tagName).toBe("BUTTON");
      expect(first?.getAttribute("aria-label")).toBe(`${term} をコピー`);
      expect(cell.querySelectorAll("button.status-meta-copy")).toHaveLength(1);
    }
  });
});

describe("Status tab ENTRYPOINT row", () => {
  // What started the session's process, as Claude Code's record spells it:
  // a value ccmsg has not seen is shown as it is.
  test("shows the record's entrypoint as written, with a copy of it", async () => {
    for (const entrypoint of ["cli", "claude-desktop", "claude-vscode", "some-future-launcher"]) {
      const { root } = await mountStatus(agentRow({ entrypoint }));
      const cell = metaCell(root, "ENTRYPOINT");
      expect(cell.querySelector(".status-scroll")?.textContent).toBe(entrypoint);
      expect(cell.querySelector("button.status-meta-copy")?.getAttribute("aria-label")).toBe(
        "ENTRYPOINT をコピー",
      );
    }
  });

  test("is — with no copy when the record names none", async () => {
    const { entrypoint: _none, ...withoutEntrypoint } = agentRow();
    const { root } = await mountStatus(withoutEntrypoint);
    const cell = metaCell(root, "ENTRYPOINT");
    expect(cell.textContent).toBe("—");
    expect(cell.querySelector("button")).toBeNull();
  });
});

describe("Status tab REPOSITORY row", () => {
  /** The session's peers row, with `repo_url` as the daemon derived it. */
  function peerRow(repoUrl?: string): PeerInfo {
    return {
      sid: SID,
      repo: "team/demo",
      ws: "main",
      cwd: "/w/repo",
      ...(repoUrl !== undefined ? { repo_url: repoUrl } : {}),
    };
  }

  test("shows the repository's URL as written, linked to it, with a copy of it", async () => {
    const { root, store } = await mountStatus(agentRow());
    await act(() =>
      store.dispatch({
        type: "peers/loaded",
        peers: [peerRow("https://gitlab.com/team/demo")],
      }),
    );
    const cell = metaCell(root, "REPOSITORY");
    const link = instanceOf(cell.querySelector("a"), HTMLAnchorElement, "the link");
    expect(link.textContent).toBe("https://gitlab.com/team/demo");
    expect(link.getAttribute("href")).toBe("https://gitlab.com/team/demo");
    expect(link.target).toBe("_blank");
    expect(cell.querySelector("button.status-meta-copy")?.getAttribute("aria-label")).toBe(
      "REPOSITORY をコピー",
    );
  });

  test("is — with no copy when the daemon knows no repository", async () => {
    const { root, store } = await mountStatus(agentRow());
    await act(() => store.dispatch({ type: "peers/loaded", peers: [peerRow()] }));
    const cell = metaCell(root, "REPOSITORY");
    expect(cell.textContent).toBe("—");
    expect(cell.querySelector("a")).toBeNull();
    expect(cell.querySelector("button")).toBeNull();
  });
});

describe("Status tab CONTEXT gauge", () => {
  // The model and the effort are the MODEL / EFFORT gauges right below: the
  // CONTEXT gauge does not say them again beside its meter.
  test("is labelled CONTEXT and shows the fill and a meter of it, and nothing after the meter", async () => {
    const { root } = await mountStatus(agentRow());
    const labels = [...root.querySelectorAll(".status-meta dt")].map((d) => d.textContent);
    expect(labels).toContain("CONTEXT");
    expect(labels).not.toContain("CTX");
    const cell = metaCell(root, "CONTEXT");
    expect([...cell.children].map((c) => c.className)).toEqual([
      "status-context-fill",
      "status-context-meter",
    ]);
    expect(cell.textContent).toBe("28%");
    expect(cell.querySelector(".status-context-fill")?.textContent).toBe("28%");
    const meter = instanceOf(cell.querySelector("meter"), HTMLMeterElement, "the meter");
    expect([meter.min, meter.max, meter.value]).toEqual([0, 1, 0.28]);
    expect(cell.title).toContain("56,000 tokens");
    expect(root.textContent).not.toContain("上限は推定");
  });
});

describe("Status tab layout", () => {
  /** The terms of each `.status-meta` list, in order. */
  function tables(root: HTMLElement): string[][] {
    return [...root.querySelectorAll(".status-meta")].map((dl) =>
      [...dl.querySelectorAll("dt")].map((d) => d.textContent ?? ""),
    );
  }

  // The tab's sections, each under its heading: the gauges' box has none,
  // then セッション情報 (the facts table with ENV folded under it, both in the
  // one section), セッション操作 and the danger zone.
  test("the gauges' box, then セッション情報 holding the facts and ENV, then シークレット (DR-0052), then the danger zone", async () => {
    const { root } = await mountStatus(agentRow());
    const view = instanceOf(root.querySelector(".status-view"), HTMLElement, "the tab");
    // セッション操作 comes between the two where the daemon can launch
    // (status-restart.dom.test.ts); this mount's daemon cannot.
    expect([...view.children].map((child) => child.className)).toEqual([
      "status-meta status-gauges",
      "status-section status-session-info",
      "status-section status-secrets",
      "status-section status-kill-zone",
    ]);
    expect([...view.querySelectorAll(".status-section-title")].map((h) => h.textContent)).toEqual([
      "セッション情報",
      "シークレット",
      "危険ゾーン",
    ]);
    const info = instanceOf(view.querySelector(".status-session-info"), HTMLElement, "the info");
    expect([...info.children].map((child) => child.tagName)).toEqual(["H3", "DL", "DETAILS"]);
    expect(info.querySelector("details > summary")?.textContent).toBe("ENV");
  });

  // One table under the gauges: two would leave a gap between CWD and the
  // ids where one table ends and the next begins.
  test("the gauges first with CONTEXT below the others, then one table of the session's facts, CWD first", async () => {
    const { root } = await mountStatus(agentRow());
    expect(tables(root)).toEqual([
      ["LIVE", "MODEL", "EFFORT", "CONTEXT"],
      [
        "CWD",
        "REPOSITORY",
        "NAME",
        "HYOUI_SESSION_ID",
        "SESSION_ID",
        "PID",
        "CCMSG",
        "KIND",
        "ENTRYPOINT",
        "STARTED",
        "UPTIME",
      ],
    ]);
  });

  // The one line and the sideways scroll are app.css's `.status-scroll`
  // (nowrap, overflow-x); here, that every value is put in it.
  test("each value sits in the one-line scroller", async () => {
    const { root } = await mountStatus(agentRow({ cwd: "/w/a/rather/long/path/to/the/repo" }));
    for (const term of ["CWD", "SESSION_ID", "PID", "HYOUI_SESSION_ID", "UPTIME"]) {
      const scroll = metaCell(root, term).querySelector(".status-scroll");
      expect(scroll?.textContent).not.toBe("");
    }
    expect(metaCell(root, "CWD").querySelector(".status-scroll")?.textContent).toBe(
      "/w/a/rather/long/path/to/the/repo",
    );
  });

  test("LIVE says the turn's state, its dot in the state's tone", async () => {
    const { root, store } = await mountStatus(agentRow());
    const live = metaCell(root, "LIVE");
    expect(live.textContent).toBe("idle");
    expect(live.querySelector(".status-live-dot-idle")).not.toBeNull();
    await act(() =>
      store.dispatch({
        type: "agents/loaded",
        agents: [agentRow({ turn: { state: "responding", since: SINCE } })],
      }),
    );
    expect(live.textContent).toBe("responding");
    expect(live.querySelector(".status-live-dot-responding")).not.toBeNull();
  });
});

describe("Status tab MODEL / EFFORT rows", () => {
  /** The rows' terms in order. */
  function terms(root: HTMLElement): string[] {
    return [...root.querySelectorAll(".status-meta dt")].map((d) => d.textContent ?? "");
  }

  test("two rows of their own after LIVE, and no OVERRIDE row", async () => {
    const { root } = await mountStatus(agentRow());
    const all = terms(root);
    expect(all).not.toContain("OVERRIDE");
    expect(all.slice(0, 4)).toEqual(["LIVE", "MODEL", "EFFORT", "CONTEXT"]);
    for (const term of ["MODEL", "EFFORT"]) {
      const cell = metaCell(root, term);
      expect(cell.querySelectorAll("button.override-value")).toHaveLength(1);
      expect(cell.querySelector('[aria-label*="上書き"]')).toBeNull();
      expect(cell.textContent).not.toContain("上書き");
    }
  });

  test("show the collapsed face: the value alone without an override", async () => {
    const { root } = await mountStatus(agentRow());
    expect(metaCell(root, "MODEL").textContent).toBe("fable-5-1[200K]");
    expect(metaCell(root, "EFFORT").textContent).toBe("low");
  });

  test("show 📌 where the session override is in force", async () => {
    const { root, store } = await mountStatus(agentRow());
    await act(() =>
      store.dispatch({
        type: "request-overrides/loaded",
        sessions: [
          {
            session_id: SID,
            session: { model: "opus", effort: "high" },
            once: { model: null, effort: null },
          },
        ],
      }),
    );
    expect(metaCell(root, "MODEL").textContent).toBe("📌opus[200K]");
    expect(metaCell(root, "EFFORT").textContent).toBe("📌high");
  });

  test("pressing the value opens that field's select", async () => {
    const { root } = await mountStatus(agentRow());
    const cell = metaCell(root, "EFFORT");
    const text = instanceOf(
      cell.querySelector("button.override-value"),
      HTMLButtonElement,
      "effort",
    );
    await act(() => text.click());
    expect(cell.querySelector("select")?.getAttribute("aria-label")).toBe("effort");
  });
});

describe("Status tab ENV", () => {
  test("each name and value is a one-line scroller; the colon split puts each part on its own line", async () => {
    const { root } = await mountStatus(agentRow(), undefined, {
      PATH: "/opt/bin:/usr/bin",
      GH_TOKEN: "secret",
    });
    const summary = [...root.querySelectorAll("summary")].find((s) => s.textContent === "ENV");
    const fold = instanceOf(summary?.parentElement, HTMLDetailsElement, "the ENV fold");
    await act(async () => {
      const toggled = new Promise((resolve) =>
        fold.addEventListener("toggle", resolve, { once: true }),
      );
      fold.open = true;
      await toggled;
    });
    for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    const row = (name: string) =>
      [...fold.querySelectorAll(".status-env-row")].find(
        (tr) => tr.querySelector(".status-env-name")?.textContent === name,
      );
    const path = row("PATH");
    expect(path?.querySelector(".status-env-name > .status-scroll")?.textContent).toBe("PATH");
    // No heading row: the names and the values say what they are. Every row
    // is the name's cell and the value's, the copy button inside the value's.
    expect(fold.querySelector('[role="columnheader"]')).toBeNull();
    expect(fold.querySelector(".status-env-head")).toBeNull();
    expect([...(path?.children ?? [])].map((cell) => cell.className)).toEqual([
      "status-env-name",
      "status-env-value",
    ]);
    // Each row has a copy button before the value, copying the real value
    // (also for a masked one).
    for (const [name, real] of [
      ["PATH", "/opt/bin:/usr/bin"],
      ["GH_TOKEN", "secret"],
    ] as const) {
      const cell = row(name)?.querySelector(".status-env-value");
      const first = cell?.firstElementChild;
      expect(first?.tagName).toBe("BUTTON");
      expect(first?.getAttribute("aria-label")).toBe(`${name} をコピー`);
      const written: string[] = [];
      const clipboard = {
        writeText: (v: string): Promise<void> => {
          written.push(v);
          return Promise.resolve();
        },
      };
      Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
      await act(() => instanceOf(first, HTMLButtonElement, "copy").click());
      expect(written).toEqual([real]);
    }
    const value = path?.querySelector(".status-env-value > .status-scroll");
    expect(value?.textContent).toBe("/opt/bin:/usr/bin");
    expect(value?.children).toHaveLength(0);
    // Sensitive values stay masked inside the same scroller.
    expect(
      row("GH_TOKEN")?.querySelector(".status-env-value > .status-scroll button")?.textContent,
    ).toBe("••••••••");
    const split = instanceOf(
      fold.querySelector('.status-env-split input[type="checkbox"]'),
      HTMLInputElement,
      "the colon split",
    );
    await act(() => {
      split.checked = true;
      split.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      [...(path?.querySelectorAll(".status-env-value > .status-scroll > div") ?? [])].map(
        (part) => part.textContent,
      ),
    ).toEqual(["/opt/bin", "/usr/bin"]);
    // The count shows only while the search narrows the list — how many of
    // all are left — and never the pid (the table's PID row has it).
    expect(fold.querySelector(".status-env-count")).toBeNull();
    const search = instanceOf(
      fold.querySelector(".status-env-search"),
      HTMLInputElement,
      "the ENV search",
    );
    await act(() => {
      search.value = "path";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fold.querySelector(".status-env-count")?.textContent).toBe("2 件中 1 件");
    await act(() => {
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fold.querySelector(".status-env-count")).toBeNull();
    expect(fold.textContent).not.toContain("pid");
  });
});

describe("Status tab without a subagent input", () => {
  test("a running subagent gets no input of its own here", async () => {
    const { root } = await mountStatus(agentRow());
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector('input[type="radio"]')).toBeNull();
    expect(root.textContent).not.toContain("Subagent への入力");
  });
});
