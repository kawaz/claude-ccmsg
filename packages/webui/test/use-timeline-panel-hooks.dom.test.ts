// Timeline の側面パネルまわりの hook (auto open 設定・パネルの開閉・fold の
// 開閉) をマウントして、hook ごとの契約を固定する。
// - useAutoOpenSettings: 保存先はセッション (agent TL は agent ごと)、切り替える
//   たびに保存し、開き直すと読み戻す。設定が変わるたびに revision が進む
// - useSidePanel: つまみで開閉し、パネルと項目リストの外のクリックで閉じる。
//   開いている間は TL の列が右にパネル幅を空ける (本文に最低幅を残す)
// - useTimelineFolds: nav が行を囲む fold を開ける。auto open の revision が
//   進むと開け閉めの上書きを捨てる。fold の本文が初めて描かれるたびに
//   mountRevision が進む
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { foldGroupKey } from "../src/client/fold-tree.ts";
import {
  defaultTimelineAutoOpen,
  timelineAutoOpenStorageKey,
} from "../src/client/timeline-auto-open.ts";
import { useAutoOpenSettings } from "../src/client/components/timeline/useAutoOpenSettings.ts";
import { useSidePanel } from "../src/client/components/timeline/useSidePanel.ts";
import { useTimelineFolds } from "../src/client/components/timeline/useTimelineFolds.ts";
import {
  byteOffsetsFromLengths,
  groupTimelineLines,
  pairQueuedTurns,
  parseTranscriptLine,
  resolveToolResults,
  utf8ByteLength,
  type TimelineGroup,
} from "../src/client/transcript-model.ts";
import {
  assistantContentRow,
  line as jsonl,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { instanceOf } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";

withDom();

const SID = "s1";
let unmounts: Array<() => Promise<void>> = [];

function track<P, R>(hook: RenderedHook<P, R>): RenderedHook<P, R> {
  unmounts.push(hook.unmount);
  return hook;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
});

describe("useAutoOpenSettings", () => {
  test("starts from the Timeline's defaults when nothing is saved", async () => {
    const main = track(
      await renderHook(useAutoOpenSettings, { sid: SID, agentKey: undefined, agentActive: false }),
    );
    expect(main.current().settings).toEqual(defaultTimelineAutoOpen(false));
    const agent = track(
      await renderHook(useAutoOpenSettings, { sid: SID, agentKey: "ag", agentActive: true }),
    );
    expect(agent.current().settings).toEqual(defaultTimelineAutoOpen(true));
  });

  test("a toggle is saved under the session and read back by the next mount", async () => {
    const props = { sid: SID, agentKey: undefined, agentActive: false };
    const first = track(await renderHook(useAutoOpenSettings, props));
    const before = first.current().revision;
    await act(() => first.current().toggle("thinking"));
    expect(first.current().settings.thinking).toBe(!defaultTimelineAutoOpen(false).thinking);
    expect(first.current().revision).toBe(before + 1);
    expect(first.current().context).toEqual({
      settings: first.current().settings,
      revision: first.current().revision,
    });
    expect(localStorage.getItem(timelineAutoOpenStorageKey(SID, undefined))).not.toBeNull();

    const second = track(await renderHook(useAutoOpenSettings, props));
    expect(second.current().settings).toEqual(first.current().settings);
  });

  test("an agent Timeline saves apart from its session, and switching agents reads the other's", async () => {
    const hook = track(
      await renderHook(useAutoOpenSettings, { sid: SID, agentKey: "ag-1", agentActive: true }),
    );
    await act(() => hook.current().toggle("agent"));
    expect(localStorage.getItem(timelineAutoOpenStorageKey(SID, "ag-1"))).not.toBeNull();
    expect(localStorage.getItem(timelineAutoOpenStorageKey(SID, undefined))).toBeNull();

    const revision = hook.current().revision;
    await hook.rerender({ sid: SID, agentKey: "ag-2", agentActive: true });
    expect(hook.current().settings).toEqual(defaultTimelineAutoOpen(true));
    expect(hook.current().revision).toBeGreaterThan(revision);
  });
});

describe("useSidePanel", () => {
  /** パネルとその列、項目リスト、外側のボタンを描き、hook に項目リストの ref を渡す。 */
  function usePanelHarness() {
    const listRef = useRef<HTMLDivElement | null>(null);
    return { listRef, panel: useSidePanel(listRef) };
  }

  async function mountPanel() {
    return track(
      await renderHook(usePanelHarness, undefined, {
        extra: ({ listRef, panel }) =>
          h(
            "div",
            { class: "column" },
            h("button", { class: "outside" }, "outside"),
            h("div", { class: "list", ref: listRef }, h("span", { class: "item" }, "item")),
            h("div", { class: "panel", ref: panel.panelRef }, h("span", null, "in panel")),
          ),
      }),
    );
  }

  function click(selector: string): Promise<void> {
    const el = instanceOf(document.querySelector(selector), HTMLElement, selector);
    return act(() => el.click());
  }

  test("toggles open and closed", async () => {
    const hook = await mountPanel();
    expect(hook.current().panel.open).toBe(false);
    await act(() => hook.current().panel.toggle());
    expect(hook.current().panel.open).toBe(true);
    await act(() => hook.current().panel.toggle());
    expect(hook.current().panel.open).toBe(false);
  });

  test("a click outside closes it; clicks in the panel or on an item do not", async () => {
    const hook = await mountPanel();
    await act(() => hook.current().panel.toggle());
    await click(".panel span");
    expect(hook.current().panel.open).toBe(true);
    await click(".list .item");
    expect(hook.current().panel.open).toBe(true);
    await click(".outside");
    expect(hook.current().panel.open).toBe(false);
  });

  test("while open, the column reserves the panel's width but keeps a minimum for the text", async () => {
    const hook = await mountPanel();
    const panel = instanceOf(document.querySelector(".panel"), HTMLElement, "panel");
    const column = instanceOf(document.querySelector(".column"), HTMLElement, "column");
    sizeOf(panel, 300);
    sizeOf(column, 1000);
    expect(hook.current().panel.reserve).toBe(0);
    await act(() => hook.current().panel.toggle());
    expect(hook.current().panel.reserve).toBe(300);
    await act(() => hook.current().panel.toggle());
    expect(hook.current().panel.reserve).toBe(0);

    sizeOf(column, 400);
    await act(() => hook.current().panel.toggle());
    // 400 - 160 (本文の最低幅) までしか空けない。
    expect(hook.current().panel.reserve).toBe(240);
  });
});

/** happy-dom はレイアウトしないので、要素の幅を決め打ちにする。 */
function sizeOf(el: HTMLElement, width: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, width, 10),
  });
}

describe("useTimelineFolds", () => {
  function groupsOf(raws: readonly string[]): { groups: TimelineGroup[]; offsets: number[] } {
    const offsets = byteOffsetsFromLengths(
      0,
      raws.map((raw) => utf8ByteLength(raw)),
    );
    const parsed = resolveToolResults(pairQueuedTurns(raws.map(parseTranscriptLine), raws));
    return { groups: groupTimelineLines(parsed, offsets), offsets };
  }

  // 0: 発話, 1-2: thinking と途中の応答 (1 つの fold group), 3: 最終応答
  const raws = [
    jsonl(userContentRow("q")),
    jsonl(assistantContentRow([{ type: "thinking", thinking: "hmm" }])),
    jsonl(assistantContentRow([{ type: "thinking", thinking: "more" }])),
    jsonl(assistantContentRow([{ type: "text", text: "a" }])),
  ];

  function foldKeyOf(groups: readonly TimelineGroup[]): string {
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    return foldGroupKey(fold.entries);
  }

  test("opens every fold around a line, and nothing for a line outside any fold", async () => {
    const { groups, offsets } = groupsOf(raws);
    const hook = track(
      await renderHook(({ revision }: { revision: number }) => useTimelineFolds(revision, groups), {
        revision: 0,
      }),
    );
    const key = foldKeyOf(groups);
    await act(() => hook.current().openFoldsAt(offsets[0]));
    expect(hook.current().store.isOpen(key, false)).toBe(false);
    await act(() => hook.current().openFoldsAt(undefined));
    expect(hook.current().store.isOpen(key, false)).toBe(false);
    await act(() => hook.current().openFoldsAt(offsets[2]));
    expect(hook.current().store.isOpen(key, false)).toBe(true);
  });

  test("a new auto-open revision drops what was opened or closed by hand", async () => {
    const { groups, offsets } = groupsOf(raws);
    const hook = track(
      await renderHook(({ revision }: { revision: number }) => useTimelineFolds(revision, groups), {
        revision: 0,
      }),
    );
    const key = foldKeyOf(groups);
    await act(() => hook.current().openFoldsAt(offsets[1]));
    expect(hook.current().store.isOpen(key, false)).toBe(true);
    await hook.rerender({ revision: 1 });
    expect(hook.current().store.isOpen(key, false)).toBe(false);
  });

  test("mountRevision moves each time a fold's body is mounted for the first time", async () => {
    const { groups } = groupsOf(raws);
    const hook = track(
      await renderHook(({ revision }: { revision: number }) => useTimelineFolds(revision, groups), {
        revision: 0,
      }),
    );
    const start = hook.current().mountRevision;
    await act(() => hook.current().store.markMounted("a"));
    expect(hook.current().mountRevision).toBe(start + 1);
    await act(() => hook.current().store.markMounted("a"));
    expect(hook.current().mountRevision).toBe(start + 1);
    await act(() => hook.current().store.markMounted("b"));
    expect(hook.current().mountRevision).toBe(start + 2);
  });
});
