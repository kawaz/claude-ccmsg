// filepath-existence-cache: dedup + batch coordinator for fs_stat_batch.
// Tests use a synchronous fake `sender` so batch scheduling is observable
// without a real WS — the module's contract is:
//   1. enqueue collapses duplicates (never asks the daemon twice for the
//      same sid+path);
//   2. multiple enqueues within the same microtask coalesce into one batch;
//   3. subscribers fire exactly once per batch response;
//   4. clearSid wipes both cache + queue and notifies subscribers.
import { afterEach, describe, expect, test } from "bun:test";
import type { FsStatEntry } from "@ccmsg/protocol";
import {
  clearFilePathCacheForSid,
  configureFilePathExistenceCache,
  enqueueFilePathProbe,
  getFilePathStatus,
  subscribeFilePathCache,
  _resetFilePathCacheForTests,
} from "../src/client/filepath-existence-cache.ts";

afterEach(() => _resetFilePathCacheForTests());

/** Install a controllable sender that records every batch it was asked for
 * and resolves with a caller-supplied map. Returns the recorded calls list
 * so tests can assert dedup / coalescing without a real WS. */
function installSender(responseFor: (path: string) => FsStatEntry | null): {
  calls: { sid: string; paths: string[] }[];
} {
  const calls: { sid: string; paths: string[] }[] = [];
  configureFilePathExistenceCache(async (sid, paths) => {
    calls.push({ sid, paths });
    return paths.map((p) => responseFor(p));
  });
  return { calls };
}

describe("filepath-existence-cache", () => {
  test("enqueue: microtask batches all pending probes for a sid into one request", async () => {
    // Three synchronous enqueues within the same tick must fan into a
    // single fs_stat_batch — that's the whole reason for the microtask
    // debounce (a screen full of TimelineItems each enqueuing on mount).
    const { calls } = installSender((p) =>
      p === "/a.md" || p === "/b.md" ? { kind: "contained", path: p.slice(1) } : null,
    );
    enqueueFilePathProbe("s1", "/a.md");
    enqueueFilePathProbe("s1", "/b.md");
    enqueueFilePathProbe("s1", "/c.md");
    await Promise.resolve(); // let queueMicrotask flush
    await Promise.resolve(); // let the async sender resolve
    expect(calls.length).toBe(1);
    expect(calls[0]!.sid).toBe("s1");
    expect(calls[0]!.paths.sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(getFilePathStatus("s1", "/a.md")).toEqual({ kind: "contained", path: "a.md" });
    expect(getFilePathStatus("s1", "/b.md")).toEqual({ kind: "contained", path: "b.md" });
    expect(getFilePathStatus("s1", "/c.md")).toBeNull();
  });

  test("dedup: enqueuing a path already known is a no-op", async () => {
    // Once the cache holds an answer (or a pending), re-enqueue during the
    // next render pass must not schedule a duplicate probe. This is the
    // property that makes it safe to call enqueue from render.
    const { calls } = installSender(() => ({ kind: "contained", path: "x.md" }));
    enqueueFilePathProbe("s1", "/x.md");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    // Same path enqueued again after the answer landed — no new call.
    enqueueFilePathProbe("s1", "/x.md");
    await Promise.resolve();
    expect(calls.length).toBe(1);
  });

  test("subscribers fire once per batch response, not per resolved path", async () => {
    // Batch of 5 paths -> exactly one subscriber notification (fires when
    // the whole batch's answers are written back). Tests re-render economy
    // for TimelineItem: 20-code-span message = 1 re-render, not 20.
    const { calls } = installSender(() => ({ kind: "contained", path: "x" }));
    let fires = 0;
    const off = subscribeFilePathCache(() => {
      fires += 1;
    });
    for (let i = 0; i < 5; i += 1) enqueueFilePathProbe("s1", `/p${i}.md`);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(fires).toBe(1);
    off();
  });

  test("clearFilePathCacheForSid wipes cache + notifies subscribers", async () => {
    // Session disconnect / reconnect must let subsequent enqueues re-probe
    // even for previously-answered paths — the file may have moved.
    installSender(() => ({ kind: "contained", path: "x" }));
    enqueueFilePathProbe("s1", "/x.md");
    await Promise.resolve();
    await Promise.resolve();
    expect(getFilePathStatus("s1", "/x.md")).not.toBeUndefined();
    let fires = 0;
    const off = subscribeFilePathCache(() => {
      fires += 1;
    });
    clearFilePathCacheForSid("s1");
    expect(getFilePathStatus("s1", "/x.md")).toBeUndefined();
    expect(fires).toBe(1);
    off();
  });

  test("enqueue is a silent no-op when no sender is wired (test/storybook safety)", () => {
    // In test / storybook contexts nobody calls configureFilePathExistenceCache,
    // and MarkdownView must render without crashing. `undefined` status
    // means "never asked" and TimelineItem falls back to plain code.
    enqueueFilePathProbe("s1", "/never.md");
    expect(getFilePathStatus("s1", "/never.md")).toBeUndefined();
  });

  test("sender rejection collapses to null for every requested path", async () => {
    // A daemon error or dropped WS must not leave paths "pending" forever
    // — writing null lets the caller keep rendering plain code (declined
    // linkification) and a session-reset (clearSid) re-opens the probe path.
    configureFilePathExistenceCache(async () => {
      throw new Error("ws dropped");
    });
    enqueueFilePathProbe("s1", "/a.md");
    await Promise.resolve();
    await Promise.resolve();
    expect(getFilePathStatus("s1", "/a.md")).toBeNull();
  });
});
