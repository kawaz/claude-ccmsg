import { describe, expect, test } from "bun:test";
import { initialState, reducer, type AppState } from "../src/client/store.ts";
import {
  initialLocatorReady,
  isAgentTimelineUrl,
  isSameSessionTabChange,
  missingTarget,
  navigationTarget,
  recentIsValid,
  rememberTimelinePosition,
  resolveSessionRootTarget,
  sessionRootHistory,
  transcriptContainsUuid,
  urlWithRememberedTimelinePosition,
  type RecentRecord,
  type WsClient,
} from "../src/client/navigation.ts";
import type { Locator } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR, parseSidebarUrl } from "../src/client/sidebar-url.ts";

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

  test("the last visible UUID is substituted only for recent persistence, and bottom clears it back to head", () => {
    rememberTimelinePosition("position-sid", "u-42");
    expect(urlWithRememberedTimelinePosition("/s/position-sid/timeline/head", "position-sid")).toBe(
      "/s/position-sid/timeline/u-42",
    );
    rememberTimelinePosition("position-sid", "head");
    expect(urlWithRememberedTimelinePosition("/s/position-sid/timeline/head", "position-sid")).toBe(
      "/s/position-sid/timeline/head",
    );
  });

  test("only a tab change within one session is converted from push to replace", () => {
    expect(isSameSessionTabChange(files("s1"), timeline("s1"))).toBe(true);
    expect(isSameSessionTabChange(files("s1", "a.ts"), files("s1", "b.ts"))).toBe(false);
    expect(isSameSessionTabChange(files("s1"), timeline("s2"))).toBe(false);
  });

  test("existence checks wait for catalogs, then reject only missing targets", () => {
    const loading = initialState();
    expect(missingTarget(loading, files("missing"))).toBeNull();
    expect(missingTarget(loading, { view: "room", room: "missing", mid: null })).toBeNull();

    const ready = hydratedState();
    // The kind travels with the id: the view needs it to say *what* is missing,
    // which a pre-rendered sentence could not be taken apart to recover.
    expect(missingTarget(ready, files("missing"))).toEqual({ kind: "session", id: "missing" });
    expect(missingTarget(ready, { view: "room", room: "missing", mid: null })).toEqual({
      kind: "room",
      id: "missing",
    });
    expect(missingTarget(stateWithSession(), files("s1"))).toBeNull();
  });

  test("a successful session locator clears a previous blocked-navigation error", () => {
    const failed = reducer(initialState(), {
      type: "navigation/missing",
      target: { kind: "session", id: "missing" },
    });
    const recovered = reducer(failed, {
      type: "locator/changed",
      locator: files("s1"),
      sidebar: CLOSED_SIDEBAR,
    });
    expect(recovered.missingTarget).toBeNull();
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

  test("a timeline UUID recent is valid only when the loaded transcript window contains that row", async () => {
    const record = recent("/s/s1/timeline/u-2");
    const present = {
      transcriptRead: async () => ({ ok: true, lines: ['{"uuid":"u-1"}', '{"uuid":"u-2"}'] }),
    } as unknown as WsClient;
    const missing = {
      transcriptRead: async () => ({ ok: true, lines: ['{"uuid":"u-1"}'] }),
    } as unknown as WsClient;

    expect(await recentIsValid(record, "s1", stateWithSession(), present, "http://localhost")).toBe(
      true,
    );
    expect(await recentIsValid(record, "s1", stateWithSession(), missing, "http://localhost")).toBe(
      false,
    );
    expect(
      await resolveSessionRootTarget(record, "s1", stateWithSession(), missing, "http://localhost"),
    ).toBe("/s/s1/timeline/head");
  });

  const agentUrls = [
    "/s/s1/timeline/agent/tm/worker",
    "/s/s1/timeline/agent/sub/a0123456789abcdef",
    "/s/s1/timeline/agent/wf/wf_0123abcd-001/a0123456789abcdef",
  ];

  test("every agent TL URL shape is recognised, and the session's own views are not", () => {
    for (const url of agentUrls) {
      expect(isAgentTimelineUrl(url, "http://localhost")).toBe(true);
    }
    for (const url of ["/s/s1/timeline/head", "/s/s1/timeline/u-2", "/s/s1/files?path=a.ts"]) {
      expect(isAgentTimelineUrl(url, "http://localhost")).toBe(false);
    }
  });

  test("an agent TL is never restored for the session root, so the sidebar always lands on the session's own timeline", async () => {
    const state = stateWithSession();
    const ws = wsWithStat(null);
    for (const url of agentUrls) {
      expect(await recentIsValid(recent(url), "s1", state, ws, "http://localhost")).toBe(false);
      expect(await resolveSessionRootTarget(recent(url), "s1", state, ws, "http://localhost")).toBe(
        "/s/s1/timeline/head",
      );
    }
    // 親セッション自身の TL は従来どおり復元対象のまま。
    expect(
      await recentIsValid(recent("/s/s1/timeline/head"), "s1", state, ws, "http://localhost"),
    ).toBe(true);
  });

  test("malformed JSONL rows cannot accidentally validate a UUID", () => {
    expect(transcriptContainsUuid(["not-json", '{"uuid":"u-1"}'], "u-2")).toBe(false);
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

// path とサイドバーのフォームパネルは 1 つの URL の別々の名前空間なので、
// 「どこを見ているか」を変える遷移でフォームが閉じてはいけない (DR-0021 は
// 検索結果を選んで Timeline へ移ってもパネルが残ることに依存している)。
describe("navigationTarget", () => {
  test("path 遷移では開いている sb.* がそのまま引き継がれる", () => {
    expect(navigationTarget("/s/s2/timeline/head", "?sb.panel=search&sb.search=foo")).toBe(
      "/s/s2/timeline/head?sb.panel=search&sb.search=foo",
    );
  });

  test("ページ固有の query を持つ遷移先でも引き継ぐ (両者は混ざらない)", () => {
    const url = navigationTarget("/usage/stats/daily?days=7", "?sb.panel=room");
    expect(new URL(url, "http://x").searchParams.get("days")).toBe("7");
    expect(parseSidebarUrl(new URL(url, "http://x").search).panel).toBe("room-creator");
  });

  // パネルを変える側は明示する。「閉じる」と「触らない」が同じ引数にならない
  // ように、url が sb.* を持つかどうかからは何も推測しない。
  test("sidebar を渡した側が勝つ (閉じる指定を含む)", () => {
    expect(navigationTarget("/r/room-1", "?sb.panel=new&sb.CWD=/a", CLOSED_SIDEBAR)).toBe(
      "/r/room-1",
    );
    expect(
      navigationTarget("/s/s1/timeline/head", "", parseSidebarUrl("?sb.panel=new&sb.SESSION_ID=x")),
    ).toBe("/s/s1/timeline/head?sb.panel=new&sb.SESSION_ID=x");
  });

  test("何も開いていなければ遷移先はそのまま", () => {
    expect(navigationTarget("/s/s1/files?path=a.ts", "")).toBe("/s/s1/files?path=a.ts");
  });
});
