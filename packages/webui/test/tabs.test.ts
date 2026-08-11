// Tabs.tsx: the one place the UI decides what a tab *is* — an <a>, a
// <button>, or an inert <span> — and what it announces while being it. Three
// panes render their tab rows through it with three different class sets, so a
// regression here changes all of them at once, silently and only for screen
// readers. That is exactly what a test is for.
//
// Test strategy mirrors markdown-view.test.ts: the component is called
// directly and the returned Preact VNode tree is walked by hand (`.type` /
// `.props`), since there is no DOM or renderToString in this repo. Fold is
// covered in the same file because it is the other half of the same task and
// just as small.
import { describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import { Tabs } from "../src/client/components/Tabs.tsx";
import { Fold } from "../src/client/components/Fold.tsx";

function isVNode(x: unknown): x is VNode {
  return x != null && typeof x === "object" && "type" in x && "props" in x;
}

function children(node: VNode): unknown[] {
  const c = (node.props as { children?: unknown }).children;
  return Array.isArray(c) ? c : [c];
}

/** The rendered tabs, in order. `items.map` leaves one nested array. */
function tabsOf(row: VNode): VNode[] {
  return children(row)
    .flat(Infinity)
    .filter((c): c is VNode => isVNode(c));
}

function props(node: VNode): Record<string, unknown> {
  return node.props as Record<string, unknown>;
}

describe("Tabs", () => {
  const items = [
    { id: "files", label: "Files", href: "#files" },
    { id: "timeline", label: "Timeline", disabled: true, title: "transcript がありません" },
    { id: "status", label: "Status" },
  ];

  test("the row is a tablist carrying the caller's class and label", () => {
    const row = Tabs({
      items,
      selected: "files",
      class: "session-tabs-list",
      tabClass: "session-tab",
      label: "表示",
    });
    expect(row.type).toBe("div");
    expect(props(row).class).toBe("session-tabs-list");
    expect(props(row).role).toBe("tablist");
    expect(props(row)["aria-label"]).toBe("表示");
  });

  test("an item with href is a link, so a tab stays middle-clickable", () => {
    const tab = tabsOf(Tabs({ items, selected: "files", tabClass: "session-tab" }))[0];
    expect(tab.type).toBe("a");
    expect(props(tab).href).toBe("#files");
  });

  test("an item without href is a button that reports its id to onSelect", () => {
    const picked: string[] = [];
    const tab = tabsOf(
      Tabs({
        items,
        selected: "files",
        tabClass: "session-tab",
        onSelect: (id) => picked.push(id),
      }),
    )[2];
    expect(tab.type).toBe("button");
    expect(props(tab).type).toBe("button");
    (props(tab).onClick as () => void)();
    expect(picked).toEqual(["status"]);
  });

  test("a disabled item is an inert span — no href, no handler, and it says so", () => {
    const tab = tabsOf(Tabs({ items, selected: "files", tabClass: "session-tab" }))[1];
    expect(tab.type).toBe("span");
    expect(props(tab)["aria-disabled"]).toBe("true");
    expect(props(tab).onClick).toBeUndefined();
    expect(props(tab).title).toBe("transcript がありません");
    // Still a tab: the row must read as one set even where one view is missing.
    expect(props(tab).role).toBe("tab");
  });

  test("a disabled tab is not drawn as selected even when it is the selected id — a session with no transcript sits on `timeline` and must not underline it", () => {
    const tab = tabsOf(Tabs({ items, selected: "timeline", tabClass: "session-tab" }))[1];
    expect(props(tab).class).toBe("session-tab disabled");
    expect(props(tab)["aria-selected"]).toBeUndefined();
  });

  test("selection shows up as both the `active` class and aria-selected", () => {
    const [files, , status] = tabsOf(Tabs({ items, selected: "status", tabClass: "session-tab" }));
    expect(props(status).class).toBe("session-tab active");
    expect(props(status)["aria-selected"]).toBe(true);
    expect(props(files).class).toBe("session-tab");
    expect(props(files)["aria-selected"]).toBe(false);
  });

  test("every tab answers to role=tab regardless of which element it became", () => {
    for (const tab of tabsOf(Tabs({ items, selected: "files", tabClass: "t" }))) {
      expect(props(tab).role).toBe("tab");
    }
  });
});

describe("Fold", () => {
  test("renders a <details> with the caller's id/class and a <summary> above the body", () => {
    const fold = Fold({
      id: "room-list-normal",
      class: "session-section",
      summaryClass: "session-section-summary",
      summary: "Active (2)",
      children: "body",
    });
    expect(fold.type).toBe("details");
    expect(props(fold).id).toBe("room-list-normal");
    expect(props(fold).class).toBe("session-section");
    const [summary, body] = children(fold);
    expect(isVNode(summary) && summary.type).toBe("summary");
    expect(isVNode(summary) && props(summary).class).toBe("session-section-summary");
    expect(isVNode(summary) && children(summary)[0]).toBe("Active (2)");
    expect(body).toBe("body");
  });

  test("`open` is what it says and defaults to closed", () => {
    expect(props(Fold({ summary: "s", children: null, open: true })).open).toBe(true);
    expect(props(Fold({ summary: "s", children: null })).open).toBeUndefined();
  });
});
