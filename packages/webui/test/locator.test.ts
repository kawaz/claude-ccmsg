import { describe, expect, test } from "bun:test";
import {
  agentTimelineHref,
  fileHref,
  filesHref,
  messageHref,
  parseTimelineFilter,
  parseUrl,
  roomHref,
  sessionHref,
  statusHref,
  terminalHref,
  timelineHref,
  usageHref,
  usageStatsHref,
} from "../src/client/locator.ts";

describe("real-path locators", () => {
  test("the app root selects no room", () => {
    expect(parseUrl("/")).toEqual({ view: "room", room: null, mid: null });
  });

  test("room and message paths round-trip without sharing the session namespace", () => {
    expect(parseUrl(roomHref("r/7"))).toEqual({ view: "room", room: "r/7", mid: null });
    expect(parseUrl(messageHref("r7", 9))).toEqual({ view: "room", room: "r7", mid: 9 });
  });

  // /usage belongs to the host, not to a session or a room, so it sits at the
  // root beside /r and /s and survives a reload like any other screen.
  test("the quota tab is the usage root", () => {
    expect(parseUrl(usageHref())).toEqual({ view: "usage", tab: "quota" });
    expect(usageHref()).toBe("/usage");
  });

  // Quota and spend answer different questions, so each is its own reloadable
  // URL rather than a toggle that a refresh forgets.
  test("the spend tab and its span round-trip through the URL", () => {
    for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
      expect(usageStatsHref(period)).toBe(`/usage/stats/${period}`);
      expect(parseUrl(usageStatsHref(period))).toEqual({
        view: "usage",
        tab: "stats",
        period,
        days: null,
      });
    }
  });

  // The URL someone trims by hand has an obvious meaning, so it gets the
  // default span rather than a 404.
  test("the spend tab with no span named opens on the default", () => {
    expect(parseUrl("/usage/stats")).toEqual({
      view: "usage",
      tab: "stats",
      period: "daily",
      days: null,
    });
    expect(usageStatsHref()).toBe("/usage/stats/daily");
  });

  // A hand-typed window rides the URL so a reload keeps it; picking a span
  // produces the bare URL, which is also what resets the window.
  test("a window other than the span's own round-trips as a query", () => {
    expect(usageStatsHref("daily", 9999)).toBe("/usage/stats/daily?days=9999");
    expect(parseUrl("/usage/stats/daily", "?days=9999")).toEqual({
      view: "usage",
      tab: "stats",
      period: "daily",
      days: 9999,
    });
  });

  // One window, one URL: `?days=32` on the daily span renders identically to
  // the bare URL, so it is not a second address for the same page.
  test("a window equal to the span's own default is not spelled out", () => {
    expect(usageStatsHref("daily", 32)).toBe("/usage/stats/daily");
    expect(usageStatsHref("yearly", 36_524)).toBe("/usage/stats/yearly");
    expect(parseUrl("/usage/stats/daily", "?days=32")).toEqual({
      view: "usage",
      tab: "stats",
      period: "daily",
      days: null,
    });
  });

  // 404-ing a hand-edited number would throw away a page that reads perfectly
  // well on the span's default.
  test("an unusable window falls back to the span's default", () => {
    for (const search of [
      "?days=0",
      "?days=36525",
      "?days=abc",
      "?days=1.5",
      "?days=",
      "?days=%zz",
    ]) {
      expect(parseUrl("/usage/stats/weekly", search)).toEqual({
        view: "usage",
        tab: "stats",
        period: "weekly",
        days: null,
      });
    }
  });

  // An unknown span is a structurally invalid path, unlike a trimmed one:
  // there is no sensible reading of "/usage/stats/hourly".
  test("an unrecognised span is an unknown path", () => {
    for (const path of ["/usage/stats/hourly", "/usage/stats/daily/extra", "/usage/other"]) {
      expect(parseUrl(path)).toEqual({ view: "unknown", pathname: path });
    }
  });

  test("the usage path takes no unrecognised segments below it", () => {
    expect(parseUrl("/usage/anything")).toEqual({ view: "unknown", pathname: "/usage/anything" });
  });

  // Sessions and rooms live under /s and /r, so a session literally named
  // "usage" cannot collide with the screen.
  test("a session named usage is unaffected", () => {
    expect(parseUrl(sessionHref("usage"))).toEqual({ view: "session-root", sid: "usage" });
  });

  test("a bare session path is a redirect target, not an implicit tab", () => {
    expect(parseUrl(sessionHref("sess-1"))).toEqual({ view: "session-root", sid: "sess-1" });
  });

  test("all session tabs have distinct reloadable paths", () => {
    expect(parseUrl(filesHref("s1"))).toEqual({
      view: "session",
      tab: "files",
      sid: "s1",
      path: null,
    });
    expect(parseUrl(timelineHref("s1"))).toEqual({
      view: "timeline",
      tab: "timeline",
      sid: "s1",
      position: "head",
    });
    for (const [href, tab] of [
      [terminalHref("s1"), "terminal"],
      [statusHref("s1"), "status"],
    ] as const) {
      expect(parseUrl(href)).toEqual({ view: "session", tab, sid: "s1", path: null });
    }
  });

  test("file path, line range, and source hint use independent query parameters", () => {
    const href = fileHref("s:1", "/external/weird? file.md", {
      lineRange: { start: 10, end: 20 },
      from: "docs/a.md",
    });
    const url = new URL(href, "http://localhost");
    expect(parseUrl(url.pathname, url.search)).toEqual({
      view: "session",
      tab: "files",
      sid: "s:1",
      path: "/external/weird? file.md",
      lineRange: { start: 10, end: 20 },
      from: "docs/a.md",
    });
  });

  test("the section a file was picked in rides its own query parameter", () => {
    for (const section of ["touched", "favorites"] as const) {
      const url = new URL(fileHref("s1", "src/a.ts", { section }), "http://localhost");
      expect(url.searchParams.get("section")).toBe(section);
      expect(parseUrl(url.pathname, url.search)).toEqual({
        view: "session",
        tab: "files",
        sid: "s1",
        path: "src/a.ts",
        section,
      });
    }
  });

  test("an unknown or empty section is a selection without one", () => {
    for (const search of ["?path=a.ts&section=workspace", "?path=a.ts&section="]) {
      expect(parseUrl("/s/s1/files", search)).toEqual({
        view: "session",
        tab: "files",
        sid: "s1",
        path: "a.ts",
      });
    }
    expect(fileHref("s1", "a.ts", { section: null })).toBe(fileHref("s1", "a.ts"));
  });

  // The place inside the file rides as the URL's own fragment, after the
  // query; the locator the store keeps is the same with and without it.
  test("fileHref puts a fragment after the query, and parseUrl reads the same file", () => {
    const href = fileHref("s1", "docs/questions/3344.md", { fragment: "3344-Q3" });
    expect(href).toBe(`${fileHref("s1", "docs/questions/3344.md")}#3344-Q3`);
    const url = new URL(href, "http://localhost");
    expect(url.hash).toBe("#3344-Q3");
    const plain = new URL(fileHref("s1", "docs/questions/3344.md"), "http://localhost");
    expect(parseUrl(url.pathname, url.search)).toEqual(parseUrl(plain.pathname, plain.search));
    expect(fileHref("s1", "a.md", { fragment: "" })).toBe(fileHref("s1", "a.md"));
    expect(fileHref("s1", "a.md", { fragment: null })).toBe(fileHref("s1", "a.md"));
  });

  test("invalid line ranges are ignored while the file remains selected", () => {
    expect(parseUrl("/s/s1/files", "?path=a.ts&lines=20-10")).toEqual({
      view: "session",
      tab: "files",
      sid: "s1",
      path: "a.ts",
    });
  });

  test("an empty path means no selected file", () => {
    expect(parseUrl("/s/s1/files", "?path=")).toEqual({
      view: "session",
      tab: "files",
      sid: "s1",
      path: null,
    });
  });

  test("malformed percent encoding in a files query is rejected instead of becoming a path", () => {
    expect(parseUrl("/s/s1/files", "?path=%zz")).toEqual({
      view: "unknown",
      pathname: "/s/s1/files",
    });
    expect(parseUrl("/s/s1/files", "?path=a.ts&from=%")).toEqual({
      view: "unknown",
      pathname: "/s/s1/files",
    });
  });

  test("timeline requires an explicit head or uuid position segment", () => {
    expect(parseUrl("/s/s1/timeline")).toEqual({
      view: "unknown",
      pathname: "/s/s1/timeline",
    });
  });

  test("timeline position is parsed now even though Phase 1 renders it as head", () => {
    expect(parseUrl(timelineHref("s1", "uuid/opaque"))).toEqual({
      view: "timeline",
      tab: "timeline",
      sid: "s1",
      position: "uuid/opaque",
    });
  });

  test("the three agent kinds are symmetric and round-trip", () => {
    for (const ref of [
      { teammate: "some/mate" },
      { agentId: "a123" },
      { runId: "wf/1", agentId: "a456" },
    ]) {
      const href = agentTimelineHref("s1", ref);
      const url = new URL(href, "http://localhost");
      const parsed = parseUrl(url.pathname, url.search);
      expect(parsed.view).toBe("timeline");
      if (parsed.view === "timeline") expect(parsed.agent).toEqual(ref);
    }
  });

  test("malformed and structurally unknown paths become an in-app unknown locator", () => {
    expect(parseUrl("/s/%zz/files")).toEqual({ view: "unknown", pathname: "/s/%zz/files" });
    expect(parseUrl("/does-not-exist")).toEqual({
      view: "unknown",
      pathname: "/does-not-exist",
    });
  });
});

// DR-0050 §4: which bubble kind the session's own Timeline shows alone is the
// page query `filter`, beside the position and never on an agent's Timeline.
describe("the Timeline's filter", () => {
  test("round-trips beside any position", () => {
    for (const filter of ["say", "permit"] as const) {
      for (const position of ["head", "u-1"]) {
        const href = timelineHref("s1", position, filter);
        const url = new URL(href, "http://x");
        expect(parseUrl(url.pathname, url.search)).toEqual({
          view: "timeline",
          tab: "timeline",
          sid: "s1",
          position,
          filter,
        });
      }
    }
    expect(timelineHref("s1", "head", "say")).toBe("/s/s1/timeline/head?filter=say");
    expect(timelineHref("s1", "u-1", null)).toBe("/s/s1/timeline/u-1");
  });

  test("an unknown or empty value is no filter", () => {
    for (const search of [
      "?filter=",
      "?filter=all",
      "?filter=SAY",
      "?other=say",
      "",
      "?filter=%zz",
    ]) {
      expect(parseTimelineFilter(search)).toBeNull();
      expect(parseUrl("/s/s1/timeline/head", search)).toEqual({
        view: "timeline",
        tab: "timeline",
        sid: "s1",
        position: "head",
      });
    }
  });

  test("an agent's Timeline does not read it", () => {
    expect(parseUrl("/s/s1/timeline/agent/sub/a1", "?filter=say")).toEqual({
      view: "timeline",
      tab: "timeline",
      sid: "s1",
      position: "head",
      agent: { agentId: "a1" },
    });
  });
});
