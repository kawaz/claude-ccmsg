import { describe, expect, test } from "bun:test";
import {
  agentTimelineHref,
  fileHref,
  filesHref,
  messageHref,
  parseUrl,
  roomHref,
  sessionHref,
  sessionRoomsHref,
  statusHref,
  terminalHref,
  timelineHref,
} from "../src/client/locator.ts";

describe("real-path locators", () => {
  test("the app root selects no room", () => {
    expect(parseUrl("/")).toEqual({ view: "room", room: null, mid: null });
  });

  test("room and message paths round-trip without sharing the session namespace", () => {
    expect(parseUrl(roomHref("r/7"))).toEqual({ view: "room", room: "r/7", mid: null });
    expect(parseUrl(messageHref("r7", 9))).toEqual({ view: "room", room: "r7", mid: 9 });
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
      [sessionRoomsHref("s1"), "rooms"],
    ] as const) {
      expect(parseUrl(href)).toEqual({ view: "session", tab, sid: "s1", path: null });
    }
  });

  test("file path, line range, and source hint use independent query parameters", () => {
    const href = fileHref("s:1", "/external/weird? file.md", { start: 10, end: 20 }, "docs/a.md");
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
