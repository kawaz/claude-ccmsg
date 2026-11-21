// The session bookmarks' storage moved from the key of when the UI called
// them pins (`ccmsg.pinnedSessions`, `{ v: 1, pins }` or a bare list of
// Session Search hits) to `ccmsg.sessionBookmarks` (`{ v: 1, bookmarks }`),
// once, at startup (DR-0043 §11): what the legacy key holds is written under
// the current key and the legacy key removed, so no bookmark is lost.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionBookmark } from "../src/client/session-bookmarks.ts";
import {
  LEGACY_SESSION_BOOKMARKS_STORAGE_KEY,
  migrateLegacySessionBookmarks,
  parseSessionBookmarks,
  SESSION_BOOKMARKS_STORAGE_KEY,
} from "../src/client/utils.ts";
import { withDom } from "./dom.ts";

withDom();

afterEach(() => {
  localStorage.clear();
});

const stored: SessionBookmark = {
  sid: "a1",
  cwd: "/w/a",
  repo: "kawaz/a",
  ws: "main",
  title: "t",
  file: "/p/a1.jsonl",
  updated_at: "2026-11-01T00:00:00.000Z",
};

function current(): SessionBookmark[] {
  return parseSessionBookmarks(localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY));
}

describe("migrateLegacySessionBookmarks", () => {
  test("moves the legacy { v: 1, pins } to the current key and removes the legacy key", () => {
    localStorage.setItem(
      LEGACY_SESSION_BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ v: 1, pins: [stored] }),
    );
    migrateLegacySessionBookmarks();
    expect(JSON.parse(localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY) ?? "null")).toEqual({
      v: 1,
      bookmarks: [stored],
    });
    expect(localStorage.getItem(LEGACY_SESSION_BOOKMARKS_STORAGE_KEY)).toBeNull();
  });

  test("moves a legacy list of Session Search hits, dropping a hit with no cwd", () => {
    localStorage.setItem(
      LEGACY_SESSION_BOOKMARKS_STORAGE_KEY,
      JSON.stringify([
        { ...stored, score: 3 },
        { ...stored, sid: "b1", cwd: null },
      ]),
    );
    migrateLegacySessionBookmarks();
    expect(current()).toEqual([stored]);
    expect(localStorage.getItem(LEGACY_SESSION_BOOKMARKS_STORAGE_KEY)).toBeNull();
  });

  test("keeps what the current key holds and only removes the legacy key", () => {
    const newer = { ...stored, sid: "n1", cwd: "/w/n" };
    localStorage.setItem(
      SESSION_BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ v: 1, bookmarks: [newer] }),
    );
    localStorage.setItem(
      LEGACY_SESSION_BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ v: 1, pins: [stored] }),
    );
    migrateLegacySessionBookmarks();
    expect(current()).toEqual([newer]);
    expect(localStorage.getItem(LEGACY_SESSION_BOOKMARKS_STORAGE_KEY)).toBeNull();
  });

  test("leaves a legacy value it cannot read, and says so", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      localStorage.setItem(LEGACY_SESSION_BOOKMARKS_STORAGE_KEY, "not json");
      migrateLegacySessionBookmarks();
      expect(localStorage.getItem(LEGACY_SESSION_BOOKMARKS_STORAGE_KEY)).toBe("not json");
      expect(localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("does nothing when there is no legacy key", () => {
    migrateLegacySessionBookmarks();
    expect(localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY)).toBeNull();
  });

  test("a second run finds nothing to move", () => {
    localStorage.setItem(
      LEGACY_SESSION_BOOKMARKS_STORAGE_KEY,
      JSON.stringify({ v: 1, pins: [stored] }),
    );
    migrateLegacySessionBookmarks();
    const after = localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY);
    migrateLegacySessionBookmarks();
    expect(localStorage.getItem(SESSION_BOOKMARKS_STORAGE_KEY)).toBe(after);
  });
});
