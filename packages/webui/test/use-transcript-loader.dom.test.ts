// transcript を取りに行く Timeline の hook をマウントして、要求と store の
// 契約を固定する。
// - useTranscriptLoader: 初回は接続と active を待って 1 度だけ tail を読む。
//   tail のずれは画面を消さずに読み直し、訪れるたびに読み直す。older は
//   読み込み済みの先頭より前、更新は tail。agent TL はその agent を読み、
//   agent を切り替える前の要求への応答は取り込まない
// - useLiveTailSubscription: active で接続中のセッション TL だけが購読し、
//   購読の応答を待ってから外す。行が DOM に入ったら latency trace を閉じる
// - useForkOrigin: セッションごとに 1 度だけ fork 地点を問い合わせる
import { afterEach, describe, expect, test } from "bun:test";
import { h, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import { AppContext, useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import type { TimelineState } from "../src/client/store.ts";
import { setActiveTraceCollector, type TraceCollector } from "../src/client/trace.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { useForkOrigin } from "../src/client/components/timeline/useForkOrigin.ts";
import { useLiveTailSubscription } from "../src/client/components/timeline/useLiveTailSubscription.ts";
import { useTranscriptLoader } from "../src/client/components/timeline/useTranscriptLoader.ts";
import { defined } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";
import { endOf, exchange, FakeTranscriptWs, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

let unmounts: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
  setActiveTraceCollector(null);
});

function timelineOf(store: Store): TimelineState {
  return defined(store.getState().sessionTrees.get(SID), "session tree").timeline;
}

/** store の sid の TimelineState を読み、hook に渡す。 */
function useTimeline(): TimelineState {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  return defined(tree, "session tree").timeline;
}

async function mountHook<P, R>(
  store: Store,
  ws: FakeTranscriptWs,
  hook: (props: P) => R,
  props: P,
): Promise<RenderedHook<P, R>> {
  const wrap = (child: ComponentChild) =>
    h(AppContext.Provider, { value: { store, ws: ws.handle } }, child);
  const rendered = await renderHook(hook, props, { wrap });
  unmounts.push(rendered.unmount);
  return rendered;
}

interface LoaderProps {
  active: boolean;
}

/** TimelinePanes と同じく、agent は store の今の選択から渡す (agent の切り
 * 替えと TimelineState の作り直しが同じ render で届く)。 */
function useLoader({ active }: LoaderProps) {
  const { store } = useApp();
  const agent = useStoreState(store, (s) => s.currentAgent);
  const timeline = useTimeline();
  return useTranscriptLoader({ sid: SID, agent, active, timeline });
}

async function mountLoader(
  options: { connected?: boolean; agent?: AgentRef; active?: boolean } = {},
): Promise<{
  store: Store;
  ws: FakeTranscriptWs;
  hook: RenderedHook<LoaderProps, ReturnType<typeof useLoader>>;
}> {
  const store = timelineStore({ connected: options.connected, agent: options.agent });
  const ws = new FakeTranscriptWs(store);
  const hook = await mountHook(store, ws, useLoader, { active: options.active ?? true });
  return { store, ws, hook };
}

describe("useTranscriptLoader", () => {
  test("reads the tail once, after both the connection and the Timeline are up", async () => {
    const { store, ws, hook } = await mountLoader({ connected: false, active: false });
    expect(ws.reads).toHaveLength(0);
    await act(() => store.dispatch({ type: "conn/status", status: "connected" }));
    expect(ws.reads).toHaveLength(0);
    await hook.rerender({ active: true });
    expect(ws.reads).toHaveLength(1);
    expect(timelineOf(store).status).toBe("loading");

    await ws.lastRead().answer(page(exchange(1)));
    expect(timelineOf(store).status).toBe("loaded");
    expect(ws.reads).toHaveLength(1);
  });

  test("an agent Timeline passes the agent's fields with every read", async () => {
    const agent = { agentId: "ag", runId: "run" };
    const { ws, hook } = await mountLoader({ agent });
    expect(ws.lastRead().opts).toEqual({ agent_id: "ag", run_id: "run" });
    await ws.lastRead().answer(page(exchange(2), 100));
    await act(() => hook.current().loadOlder());
    expect(ws.lastRead().opts).toEqual({ agent_id: "ag", run_id: "run", before: 100 });
  });

  test("an answer for the agent the Timeline has since switched away from is not taken", async () => {
    const { store, ws } = await mountLoader({ agent: { agentId: "first" } });
    const stale = ws.lastRead();
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, agent: { agentId: "second" } },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    expect(ws.lastRead().opts).toEqual({ agent_id: "second" });
    await stale.answer(page(exchange(1)));
    expect(timelineOf(store).status).toBe("loading");
    await ws.lastRead().answer(page(exchange(2)));
    expect(timelineOf(store).status).toBe("loaded");
  });

  test("a tail push that does not line up re-reads without leaving the loaded state", async () => {
    const { store, ws } = await mountLoader();
    await ws.lastRead().answer(page(exchange(1)));
    const end = timelineOf(store).end;
    await act(() =>
      store.dispatch({
        type: "timeline/tail",
        sid: SID,
        lines: exchange(2),
        start: end + 1,
        end: end + 100,
        size: end + 100,
      }),
    );
    expect(ws.reads).toHaveLength(2);
    expect(timelineOf(store).status).toBe("loaded");
    await ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
    expect(timelineOf(store).needsResync).toBeUndefined();
    expect(timelineOf(store).lines).toHaveLength(4);
  });

  test("arriving again (active again, or a reconnect) re-reads a loaded transcript", async () => {
    const { store, ws, hook } = await mountLoader();
    await ws.lastRead().answer(page(exchange(1)));
    await hook.rerender({ active: false });
    await hook.rerender({ active: true });
    expect(ws.reads).toHaveLength(2);
    await ws.lastRead().answer(page(exchange(1)));

    await act(() => store.dispatch({ type: "conn/status", status: "disconnected" }));
    await act(() => store.dispatch({ type: "conn/status", status: "connected" }));
    expect(ws.reads).toHaveLength(3);
  });

  test("older reads before the loaded start and prepends; nothing once the start is reached", async () => {
    const { store, ws, hook } = await mountLoader();
    const older = exchange(1);
    const olderEnd = endOf(older, 0);
    await ws.lastRead().answer(page(exchange(2), olderEnd));
    await act(() => hook.current().loadOlder());
    expect(ws.lastRead().opts).toEqual({ before: olderEnd });
    await ws.lastRead().answer(page(older, 0));
    expect(timelineOf(store).lines).toHaveLength(4);
    expect(timelineOf(store).atStart).toBe(true);

    await act(() => hook.current().loadOlder());
    expect(ws.reads).toHaveLength(2);
  });

  test("refresh re-reads the tail and settles once the answer is in the store; null while loading", async () => {
    const { store, ws, hook } = await mountLoader();
    expect(hook.current().refresh()).toBeNull();
    await ws.lastRead().answer(page(exchange(1)));

    let settled = false;
    await act(() => {
      void hook
        .current()
        .refresh()
        ?.then(() => {
          settled = true;
        });
    });
    expect(ws.reads).toHaveLength(2);
    expect(ws.lastRead().opts).toBeUndefined();
    expect(settled).toBe(false);
    await ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
    expect(settled).toBe(true);
    expect(timelineOf(store).lines).toHaveLength(4);
  });
});

interface TailProps {
  active: boolean;
  agentActive: boolean;
}

function useTail({ active, agentActive }: TailProps): void {
  const timeline = useTimeline();
  useLiveTailSubscription({ sid: SID, active, agentActive, timeline });
}

describe("useLiveTailSubscription", () => {
  test("subscribes while active and connected, and unsubscribes after the subscribe answered", async () => {
    const store = timelineStore({ connected: false });
    const ws = new FakeTranscriptWs(store);
    const hook = await mountHook(store, ws, useTail, { active: true, agentActive: false });
    expect(ws.subscribes).toEqual([]);
    await act(() => store.dispatch({ type: "conn/status", status: "connected" }));
    expect(ws.subscribes).toEqual([SID]);

    await act(async () => {
      await hook.rerender({ active: false, agentActive: false });
    });
    expect(ws.unsubscribes).toEqual([SID]);
  });

  test("an agent Timeline does not subscribe", async () => {
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    await mountHook(store, ws, useTail, { active: true, agentActive: true });
    expect(ws.subscribes).toEqual([]);
  });

  test("closes the latency trace when loaded rows reach the document", async () => {
    const commits: Array<{ sid: string; end: number }> = [];
    const collector: TraceCollector = {
      noteWsReceive() {},
      noteStoreDispatch() {},
      noteDomCommit(sid, end) {
        commits.push({ sid, end });
      },
      pendingCount: () => 0,
    };
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    // ws の client は作られる時に自分の collector を据えるので、その後で差し替える。
    setActiveTraceCollector(collector);
    await mountHook(store, ws, useTail, { active: true, agentActive: false });
    await act(() => store.dispatch({ type: "timeline/loading", sid: SID, generation: 1 }));
    expect(commits).toEqual([]);
    await act(() =>
      store.dispatch({
        type: "timeline/loaded",
        sid: SID,
        generation: 1,
        mode: "replace",
        response: { ok: true, sid: SID, lines: exchange(1), start: 0, end: 50, size: 50 },
      }),
    );
    expect(commits).toEqual([{ sid: SID, end: 50 }]);
  });
});

describe("useForkOrigin", () => {
  function useOrigin(props: { active: boolean; agentActive: boolean }) {
    return useForkOrigin({ sid: SID, ...props });
  }

  test("asks once per session and returns the answer", async () => {
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    const hook = await mountHook(store, ws, useOrigin, { active: true, agentActive: false });
    await act(() => Promise.resolve());
    expect(ws.forkOrigins).toEqual([SID]);
    expect(hook.current()).toBeNull();

    await hook.rerender({ active: false, agentActive: false });
    await hook.rerender({ active: true, agentActive: false });
    expect(ws.forkOrigins).toEqual([SID]);
  });

  test("an agent Timeline does not ask", async () => {
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    const hook = await mountHook(store, ws, useOrigin, { active: true, agentActive: true });
    expect(ws.forkOrigins).toEqual([]);
    expect(hook.current()).toBeUndefined();
  });
});
