// Running the person's userscript as a page starts (DR-0057 §3-§5): whether
// a page runs it is this browser's own switch (localStorage, off unless
// switched on, `?userscript=on|off` writes it), and a page that runs it
// imports the JavaScript the daemon built and awaits `userscript(util)`,
// keeping running whatever the script does.
//
// 何を保証するか:
//   - ブラウザの既定は無効: 記録が無ければ読み込みを頼まない
//   - ?userscript=on / true で有効を記録し、そのページから読み込む。off / false で記録を消し、そのページから読み込まない
//     (大文字小文字を問わない。他の値・無いときは記録を変えない)
//   - 有効なら、最初の接続が「保存されている」と言った後に 1 回だけ読み込んで走らせる (再接続で再度走らない)。
//     保存されていなければ頼まない
//   - 読み込みの失敗 (daemon の断り、接続の失敗)、import の失敗 (トップレベルの例外、関数でない)、
//     実行時の例外のどれでも、run は reject せず失敗として返り、ページの知らせ (store) と console に出る
//   - util.session は最初の peers / agents が来るまで待ち、そのセッションの行の写しを返す
//     (書き換えてもページの state に響かない)。知らない sid は null
//   - blob: URL からの import で export を読み、関数でない userscript を断る (Bun の import で実物を通す)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentInfo, PeerInfo, ReplyOf } from "@ccmsg/protocol";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import {
  createUserscriptUtil,
  importUserscript,
  deviceSwitchFromQuery,
  readDeviceEnabled,
  setDeviceEnabled,
  USERSCRIPT_DEVICE_KEY,
  runUserscript,
  startUserscript,
  type UserscriptFunction,
  type UserscriptUtil,
} from "../src/client/userscript.ts";
import { MemStorage, stubGlobal, stubProperty } from "./helpers.ts";

const SID = "eeeeeeee-5757-4000-8000-000000000001";
const JS = "export async function userscript(util) {}\n";

const PEER: PeerInfo = {
  sid: SID,
  name: "worker",
  repo: "r",
  ws: "w",
  cwd: "/w",
  connected_at: "2026-11-19T00:00:00.000Z",
  last_activity_at: "2026-11-19T00:00:00.000Z",
};
const AGENT: AgentInfo = {
  pid: 1,
  cwd: "/w",
  kind: "interactive",
  startedAt: 1,
  sessionId: SID,
  config_dir: "/c",
};

let restores: (() => void)[] = [];
let storage = new MemStorage();
beforeEach(() => {
  storage = new MemStorage();
  restores.push(stubGlobal("localStorage", storage));
});
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** console.error, recorded instead of printed. */
function recordConsoleErrors(): string[] {
  const lines: string[] = [];
  restores.push(
    stubProperty(console, "error", {
      value: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
      configurable: true,
    }),
  );
  return lines;
}

const nowhere: UserscriptUtil = { session: () => Promise.resolve(null) };

function enabled(js = JS): () => Promise<ReplyOf<"userscript_load">> {
  return () => Promise.resolve({ ok: true, js });
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("this browser's switch (DR-0057 §3)", () => {
  test("the query: on / true, off / false, in any case, among other parameters", () => {
    expect(deviceSwitchFromQuery("?userscript=on")).toBe(true);
    expect(deviceSwitchFromQuery("?userscript=TRUE")).toBe(true);
    expect(deviceSwitchFromQuery("?filter=say&userscript=off")).toBe(false);
    expect(deviceSwitchFromQuery("?userscript=false")).toBe(false);
    expect(deviceSwitchFromQuery("?userscript")).toBeNull();
    expect(deviceSwitchFromQuery("?userscript=maybe")).toBeNull();
    expect(deviceSwitchFromQuery("")).toBeNull();
  });

  test("off unless switched on; switching writes localStorage and the page's state", () => {
    expect(readDeviceEnabled()).toBe(false);
    const store = createStore(initialState());
    setDeviceEnabled(store, true);
    expect(storage.getItem(USERSCRIPT_DEVICE_KEY)).toBe("on");
    expect(readDeviceEnabled()).toBe(true);
    expect(store.getState().userscript.deviceEnabled).toBe(true);
    setDeviceEnabled(store, false);
    expect(storage.getItem(USERSCRIPT_DEVICE_KEY)).toBeNull();
    expect(store.getState().userscript.deviceEnabled).toBe(false);
  });
});

describe("runUserscript (DR-0057 §4)", () => {
  test("calls the script's userscript with util once", async () => {
    const calls: UserscriptUtil[] = [];
    const fn: UserscriptFunction = (...args) => {
      calls.push(nowhere);
      expect(args).toEqual([nowhere]);
      return Promise.resolve();
    };
    const imported: string[] = [];
    const run = await runUserscript({
      load: enabled(),
      importUserscript: (js) => {
        imported.push(js);
        return Promise.resolve(fn);
      },
      util: nowhere,
    });
    expect(run).toEqual({ kind: "ran" });
    expect(imported).toEqual([JS]);
    expect(calls).toHaveLength(1);
  });

  test("does not import when the daemon hands no JS (none saved)", async () => {
    let imports = 0;
    const run = await runUserscript({
      load: () => Promise.resolve({ ok: true }),
      importUserscript: () => {
        imports++;
        return Promise.reject(new Error("must not import"));
      },
      util: nowhere,
    });
    expect(run).toEqual({ kind: "none" });
    expect(imports).toBe(0);
  });

  test("every failure is an outcome, never a rejection", async () => {
    const never = (): Promise<UserscriptFunction> => Promise.reject(new Error("must not import"));
    expect(
      await runUserscript({
        load: () =>
          Promise.resolve({
            ok: false,
            error: { code: "userscript_invalid", msg: "userscript.ts:1:1: Unexpected" },
          }),
        importUserscript: never,
        util: nowhere,
      }),
    ).toEqual({ kind: "failed", message: "userscript.ts:1:1: Unexpected" });
    expect(
      await runUserscript({
        load: () => Promise.reject(new Error("ws not open")),
        importUserscript: never,
        util: nowhere,
      }),
    ).toEqual({ kind: "failed", message: "Error: ws not open" });
    expect(
      await runUserscript({
        load: enabled(),
        importUserscript: () => Promise.reject(new SyntaxError("Unexpected token")),
        util: nowhere,
      }),
    ).toEqual({ kind: "failed", message: "SyntaxError: Unexpected token" });
    expect(
      await runUserscript({
        load: enabled(),
        importUserscript: () =>
          Promise.resolve(() => {
            throw new TypeError("document.body is null");
          }),
        util: nowhere,
      }),
    ).toEqual({ kind: "failed", message: "TypeError: document.body is null" });
    expect(
      await runUserscript({
        load: enabled(),
        importUserscript: () => Promise.resolve(() => Promise.reject(new RangeError("late"))),
        util: nowhere,
      }),
    ).toEqual({ kind: "failed", message: "RangeError: late" });
  });
});

describe("importUserscript (a real import from a blob: URL)", () => {
  test("takes the module's userscript, which runs", async () => {
    const fn = await importUserscript(
      "export async function userscript(util) { return util.n + 1; }\n",
    );
    expect(await fn({ n: 41 })).toBe(42);
  });

  test("a module whose userscript is not a function is refused", async () => {
    const refused = await importUserscript("export const userscript = 1;\n").then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(refused)).toBe("Error: `userscript` が関数として export されていない");
  });

  test("a module whose top level throws is refused with that error", async () => {
    const refused = await importUserscript(
      'throw new Error("top level");\nexport async function userscript() {}\n',
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(refused)).toBe("Error: top level");
  });
});

describe("startUserscript (DR-0057 §3-§4)", () => {
  function counted(reply: ReplyOf<"userscript_load"> = { ok: true, js: JS }) {
    const counts = { loads: 0, runs: 0 };
    const deps = {
      load: () => {
        counts.loads++;
        return Promise.resolve(reply);
      },
      importUserscript: (): Promise<UserscriptFunction> =>
        Promise.resolve(() => {
          counts.runs++;
          return Promise.resolve();
        }),
    };
    return { counts, deps };
  }

  test("a browser that never switched it on does not ask for the script", async () => {
    const store = createStore(initialState());
    const { counts, deps } = counted();
    startUserscript(store, deps, "");
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 0, runs: 0 });
    expect(store.getState().userscript.deviceEnabled).toBe(false);
  });

  test("switched on: runs once after the first connection says one is saved, not again on a reconnect", async () => {
    storage.setItem(USERSCRIPT_DEVICE_KEY, "on");
    const store = createStore(initialState());
    const { counts, deps } = counted();
    startUserscript(store, deps, "");
    expect(store.getState().userscript.deviceEnabled).toBe(true);
    await settled();
    expect(counts).toEqual({ loads: 0, runs: 0 });
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 1, runs: 1 });
    // A reconnect reads it again; the page's run was its one.
    store.dispatch({ type: "userscript/saved", saved: false });
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 1, runs: 1 });
  });

  test("switched on but nothing saved: does not ask for the script", async () => {
    storage.setItem(USERSCRIPT_DEVICE_KEY, "on");
    const store = createStore(initialState());
    const { counts, deps } = counted();
    startUserscript(store, deps, "");
    store.dispatch({ type: "userscript/saved", saved: false });
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 0, runs: 0 });
  });

  test("?userscript=on switches the browser on and runs on that very page", async () => {
    const store = createStore(initialState());
    const { counts, deps } = counted();
    startUserscript(store, deps, "?userscript=on");
    expect(storage.getItem(USERSCRIPT_DEVICE_KEY)).toBe("on");
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 1, runs: 1 });
  });

  test("?userscript=off switches the browser off from that page on", async () => {
    storage.setItem(USERSCRIPT_DEVICE_KEY, "on");
    const store = createStore(initialState());
    const { counts, deps } = counted();
    startUserscript(store, deps, "?userscript=off");
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(counts).toEqual({ loads: 0, runs: 0 });
    expect(storage.getItem(USERSCRIPT_DEVICE_KEY)).toBeNull();
    expect(store.getState().userscript.deviceEnabled).toBe(false);
    // The next page, opened without the query, stays off.
    const next = createStore(initialState());
    const again = counted();
    startUserscript(next, again.deps, "");
    next.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(again.counts).toEqual({ loads: 0, runs: 0 });
  });

  test("a script that throws: the page's notice and the console say so, and the store works on", async () => {
    storage.setItem(USERSCRIPT_DEVICE_KEY, "on");
    const errors = recordConsoleErrors();
    const store = createStore(initialState());
    startUserscript(
      store,
      {
        load: enabled(),
        importUserscript: () =>
          Promise.resolve(() => {
            throw new Error("broken script");
          }),
      },
      "",
    );
    store.dispatch({ type: "userscript/saved", saved: true });
    await settled();
    expect(store.getState().userscript.failure).toBe("Error: broken script");
    expect(errors).toEqual(["ccmsg userscript: Error: broken script"]);
    store.dispatch({ type: "peers/loaded", peers: [PEER] });
    expect(store.getState().peers).toEqual([PEER]);
    store.dispatch({ type: "userscript/failure", message: null });
    expect(store.getState().userscript.failure).toBeNull();
  });
});

describe("util.session (DR-0057 §5)", () => {
  test("waits for the first peers and agents, then answers the session's rows", async () => {
    const store = createStore(initialState());
    const util = createUserscriptUtil(store);
    let answered = false;
    const asked = util.session(SID).then((row) => {
      answered = true;
      return row;
    });
    store.dispatch({ type: "peers/loaded", peers: [PEER] });
    await settled();
    expect(answered).toBe(false);
    store.dispatch({ type: "agents/loaded", agents: [AGENT] });
    expect(await asked).toEqual({ sid: SID, peer: PEER, agent: AGENT });
  });

  test("a session the page does not know is null; one known only as a process has no peer", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "peers/loaded", peers: [] });
    store.dispatch({ type: "agents/loaded", agents: [AGENT] });
    const util = createUserscriptUtil(store);
    expect(await util.session("nope")).toBeNull();
    expect(await util.session(SID)).toEqual({ sid: SID, peer: null, agent: AGENT });
  });

  test("answers a copy: what the script changes does not reach the page's state", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "peers/loaded", peers: [PEER] });
    store.dispatch({ type: "agents/loaded", agents: [AGENT] });
    const row = await createUserscriptUtil(store).session(SID);
    if (row === null || row.peer === null) throw new Error("expected the session's peer row");
    Object.assign(row.peer, { cwd: "/changed" });
    expect(store.getState().peers[0]?.cwd).toBe("/w");
  });
});
