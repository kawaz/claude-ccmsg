// Timeline の in-view 検索 (DR-0022) の hook をマウントして、契約を固定する。
// - [N/M] の M は検索対象 (👤/🤖/💬) の unit のうちクエリに合うもの。新しい
//   クエリは 1 番目から数え直し、↑/↓ は端で反対側へ回る
// - 📁 (閉じた fold も数えるか) は localStorage に残る。off の間は画面に出て
//   いる unit だけを数える
// - まだ描かれていない unit への ↓ は、その行を囲む fold を開けさせ、本文が
//   描かれたところで一致の位置へ寄せる
// - クエリ・モードの変更は store のこのセッションの検索条件に流す
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import { AppContext } from "../src/client/context.ts";
import { CLOSED_FOLD_SCOPE_KEY } from "../src/client/in-view-search.ts";
import type { ScrollHold } from "../src/client/useScrollHold.ts";
import type { Store } from "../src/client/useStore.ts";
import {
  useInViewSearch,
  type InViewSearch,
  type TimelineSearch,
} from "../src/client/components/timeline/useInViewSearch.ts";
import { useTranscriptModel } from "../src/client/components/timeline/useTranscriptModel.ts";
import { defined } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";
import { exchange, FakeTranscriptWs, SID, timelineStore } from "./timeline-harness.ts";

withDom();

let unmounts: Array<() => Promise<void>> = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
});

const LINES = [...exchange(1, "alpha one"), ...exchange(2, "beta"), ...exchange(3, "alpha two")];

interface Props {
  search: TimelineSearch;
  foldMountRevision: number;
  /** DOM に描いてある発話の番号 (0 始まり)。描いていない unit は閉じた fold の
   * 中の扱い。 */
  mounted: readonly number[];
}

interface Probe {
  search: InViewSearch;
  mounted: readonly number[];
  /** 発話の unit の key (`<offset>-0`)。 */
  userUnitKeys: string[];
}

function query(queryText: string): TimelineSearch {
  return { queryText, caseSensitive: false, regex: false };
}

async function mountSearch(options: {
  mounted?: readonly number[];
  initial?: TimelineSearch;
}): Promise<{
  hook: RenderedHook<Props, Probe>;
  store: Store;
  opened: Array<number | undefined>;
  heldTo: HTMLElement[];
}> {
  const store = timelineStore();
  const ws = new FakeTranscriptWs(store);
  const opened: Array<number | undefined> = [];
  const heldTo: HTMLElement[] = [];
  const scrollHold: ScrollHold = {
    toBottom() {},
    toElement(target) {
      heldTo.push(target);
    },
    release() {},
  };
  function useProbe({ search, foldMountRevision, mounted }: Props): Probe {
    const model = useTranscriptModel({ lines: LINES, start: 0 });
    const userUnitKeys = model.groups.flatMap((group) =>
      group.kind === "entry" && group.line.kind === "turn" && group.line.role === "user"
        ? [`${group.offset}-0`]
        : [],
    );
    const inViewSearch = useInViewSearch({
      sid: SID,
      search,
      groups: model.groups,
      ccmsgTargets: model.ccmsgTargets,
      openFoldsAt: (offset) => opened.push(offset),
      foldMountRevision,
      scrollHold,
    });
    return { search: inViewSearch, userUnitKeys, mounted };
  }
  const wrap = (child: ComponentChild) =>
    h(AppContext.Provider, { value: { store, ws: ws.handle } }, child);
  const hook = await renderHook(
    useProbe,
    {
      search: options.initial ?? query("alpha"),
      foldMountRevision: 0,
      mounted: options.mounted ?? [0, 1, 2],
    },
    {
      wrap,
      extra: ({ search, userUnitKeys, mounted }) =>
        h(
          "div",
          null,
          userUnitKeys.map((key, i) =>
            mounted.includes(i)
              ? h(
                  "span",
                  {
                    key,
                    class: `unit-${i}`,
                    ref: (el: HTMLElement | null) => search.searchCtx?.registerRef(key, el),
                  },
                  i === 0 ? "alpha one" : i === 1 ? "beta" : "alpha two",
                )
              : null,
          ),
        ),
    },
  );
  unmounts.push(hook.unmount);
  return { hook, store, opened, heldTo };
}

function counter(search: InViewSearch): string {
  return `${search.currentIndex}/${search.matchCount}`;
}

describe("useInViewSearch", () => {
  test("counts matching units from the first and walks them with wrap-around", async () => {
    const { hook } = await mountSearch({});
    expect(counter(hook.current().search)).toBe("1/2");
    await act(() => hook.current().search.next());
    expect(counter(hook.current().search)).toBe("2/2");
    await act(() => hook.current().search.next());
    expect(counter(hook.current().search)).toBe("1/2");
    await act(() => hook.current().search.prev());
    expect(counter(hook.current().search)).toBe("2/2");

    await hook.rerender({ search: query("beta"), foldMountRevision: 0, mounted: [0, 1, 2] });
    expect(counter(hook.current().search)).toBe("1/1");
  });

  test("the 👤 / 🤖 target toggles take their units out of the count", async () => {
    const { hook } = await mountSearch({ initial: query("answer") });
    expect(hook.current().search.matchCount).toBe(3);
    await act(() => hook.current().search.targets.toggleAI());
    expect(hook.current().search.targets.ai).toBe(false);
    expect(hook.current().search.matchCount).toBe(0);
    await act(() => hook.current().search.targets.toggleAI());
    await hook.rerender({ search: query("alpha"), foldMountRevision: 0, mounted: [0, 1, 2] });
    await act(() => hook.current().search.targets.toggleUser());
    expect(hook.current().search.matchCount).toBe(0);
  });

  test("an invalid regex counts nothing and says so; an empty query gives no search context", async () => {
    const { hook } = await mountSearch({
      initial: { queryText: "(", caseSensitive: false, regex: true },
    });
    expect(hook.current().search.hasError).toBe(true);
    expect(hook.current().search.matchCount).toBe(0);
    await hook.rerender({ search: query(""), foldMountRevision: 0, mounted: [0, 1, 2] });
    expect(hook.current().search.searchCtx).toBeUndefined();
  });

  test("with closed folds out of scope only units on screen count, and the choice is kept", async () => {
    const { hook } = await mountSearch({ mounted: [0, 1] });
    expect(hook.current().search.foldScope.searchClosedFolds).toBe(true);
    expect(hook.current().search.matchCount).toBe(2);
    await act(() => hook.current().search.foldScope.toggle());
    expect(hook.current().search.foldScope.searchClosedFolds).toBe(false);
    expect(hook.current().search.matchCount).toBe(1);
    expect(localStorage.getItem(CLOSED_FOLD_SCOPE_KEY)).not.toBeNull();

    const again = await mountSearch({ mounted: [0, 1] });
    expect(again.hook.current().search.foldScope.searchClosedFolds).toBe(false);
  });

  test("↓ to a unit not on the page opens its folds, then holds on it once its body is there", async () => {
    const { hook, opened, heldTo } = await mountSearch({ mounted: [0] });
    const [, , third] = hook.current().userUnitKeys;
    expect(counter(hook.current().search)).toBe("1/2");
    await act(() => hook.current().search.next());
    expect(opened).toEqual([Number(defined(third, "third unit").split("-")[0])]);
    expect(heldTo).toEqual([]);

    // fold が開いて本文 (= unit) が描かれ、mountRevision が進んだ時に寄せる。
    await hook.rerender({ search: query("alpha"), foldMountRevision: 1, mounted: [0, 2] });
    expect(heldTo).toHaveLength(1);
    expect(heldTo[0]?.className).toBe("unit-2");
    expect(counter(hook.current().search)).toBe("2/2");
  });

  test("a query edit is written to this session's search in the store", async () => {
    const { hook, store } = await mountSearch({});
    await act(() => hook.current().search.changeSearch({ queryText: "beta", regex: true }));
    expect(store.getState().sessionTrees.get(SID)?.timelineSearch).toEqual({
      queryText: "beta",
      caseSensitive: false,
      regex: true,
    });
  });
});
