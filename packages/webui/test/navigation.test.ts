import { describe, expect, test } from "bun:test";
import { initialState, reducer, type AppState } from "../src/client/store.ts";
import {
  initialLocatorReady,
  isSameSessionTabChange,
  missingTargetMessage,
  recentIsValid,
  resolveSessionRootTarget,
  sessionRootHistory,
  type RecentRecord,
  type WsClient,
} from "../src/client/navigation.ts";
import type { Locator } from "../src/client/locator.ts";

function hydratedState(): AppState {
  return {
    ...initialState(),
    roomsLoaded: true,
    peersLoaded: true,
    agentsLoaded: true,
  };
}

function stateWithSession(sid = "s1", cwd = "/repo"): AppState {
  const state = hydratedState();
  return {
    ...state,
    peers: [{ sid, cwd } as AppState["peers"][number]],
  };
}

function wsWithStat(result: unknown): WsClient {
  return {
    fsStatBatch: async () => result,
  } as unknown as WsClient;
}

const files = (sid: string, path: string | null = null): Locator => ({
  view: "session",
  tab: "files",
  sid,
  path,
});
const timeline = (sid: string): Locator => ({
  view: "timeline",
  tab: "timeline",
  sid,
  position: "head",
});

describe("Navigation API routing decisions", () => {
  test("session-root redirects push when moving from another resource and replace within the same session", () => {
    expect(sessionRootHistory(files("s1"), "s1")).toBe("replace");
    expect(sessionRootHistory(files("s1"), "s2")).toBe("push");
    expect(sessionRootHistory({ view: "room", room: "r1", mid: null }, "s1")).toBe("push");
  });

  test("only a tab change within one session is converted from push to replace", () => {
    expect(isSameSessionTabChange(files("s1"), timeline("s1"))).toBe(true);
    expect(isSameSessionTabChange(files("s1", "a.ts"), files("s1", "b.ts"))).toBe(false);
    expect(isSameSessionTabChange(files("s1"), timeline("s2"))).toBe(false);
  });

  test("existence checks wait for catalogs, then reject only missing targets", () => {
    const loading = initialState();
    expect(missingTargetMessage(loading, files("missing"))).toBeNull();
    expect(missingTargetMessage(loading, { view: "room", room: "missing", mid: null })).toBeNull();

    const ready = hydratedState();
    expect(missingTargetMessage(ready, files("missing"))).toContain("missing");
    expect(missingTargetMessage(ready, { view: "room", room: "missing", mid: null })).toContain(
      "missing",
    );
    expect(missingTargetMessage(stateWithSession(), files("s1"))).toBeNull();
  });

  test("a successful session locator clears a previous blocked-navigation error", () => {
    const failed = reducer(initialState(), {
      type: "navigation/error",
      message: "セッション missing は存在しません",
    });
    const recovered = reducer(failed, { type: "locator/changed", locator: files("s1") });
    expect(recovered.navigationError).toBeNull();
    expect(recovered.currentSid).toBe("s1");
  });

  test("initial load waits for the catalog required by its locator kind", () => {
    const state = initialState();
    expect(initialLocatorReady(state, files("s1"))).toBe(false);
    expect(initialLocatorReady({ ...state, peersLoaded: true }, files("s1"))).toBe(false);
    expect(
      initialLocatorReady({ ...state, peersLoaded: true, agentsLoaded: true }, files("s1")),
    ).toBe(true);
    expect(initialLocatorReady(state, { view: "room", room: "r1", mid: null })).toBe(false);
    expect(
      initialLocatorReady({ ...state, roomsLoaded: true }, { view: "room", room: "r1", mid: null }),
    ).toBe(true);
  });
});

describe("recent session restoration", () => {
  const recent = (url: string): RecentRecord => ({
    url,
    updatedAt: "2026-07-28T00:00:00.000Z",
  });

  test("a valid non-file recent URL is restored without probing the filesystem", async () => {
    const record = recent("/s/s1/status");
    expect(
      await recentIsValid(record, "s1", stateWithSession(), wsWithStat(null), "http://localhost"),
    ).toBe(true);
    expect(
      await resolveSessionRootTarget(
        record,
        "s1",
        stateWithSession(),
        wsWithStat(null),
        "http://localhost",
      ),
    ).toBe(record.url);
  });

  test("a missing session makes its recent URL invalid", async () => {
    expect(
      await recentIsValid(
        recent("/s/s1/status"),
        "s1",
        hydratedState(),
        wsWithStat(null),
        "http://localhost",
      ),
    ).toBe(false);
  });

  test("relative file recents are checked against the session cwd", async () => {
    let probed: string[] = [];
    const ws = {
      fsStatBatch: async (_sid: string, paths: string[]) => {
        probed = paths;
        return { ok: true, results: [{ path: paths[0] }] };
      },
    } as unknown as WsClient;
    const record = recent("/s/s1/files?path=src%2Fapp.ts");
    expect(await recentIsValid(record, "s1", stateWithSession(), ws, "http://localhost")).toBe(
      true,
    );
    expect(probed).toEqual(["/repo/src/app.ts"]);
  });

  test("a missing recent file falls back to timeline/head", async () => {
    const record = recent("/s/s1/files?path=missing.ts");
    const ws = wsWithStat({ ok: true, results: [null] });
    expect(await recentIsValid(record, "s1", stateWithSession(), ws, "http://localhost")).toBe(
      false,
    );
    expect(
      await resolveSessionRootTarget(record, "s1", stateWithSession(), ws, "http://localhost"),
    ).toBe("/s/s1/timeline/head");
  });
});
