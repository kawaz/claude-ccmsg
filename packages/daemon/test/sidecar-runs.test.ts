// The runs of each session as their sidecars name them (DR-0035 §3): a run is
// live while its sidecar's connection to the daemon is open, and the daemon
// ties it to its harness process from Claude Code's own register.
import { describe, expect, test } from "bun:test";
import { type AgentRow, type SidecarRunHello, SidecarRuns } from "../src/sidecar-runs.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const DIR = "/h/.claude-a";
const T0 = 1_791_955_713_000;

function hello(extra: Partial<SidecarRunHello> = {}): SidecarRunHello {
  return { sid: SID, runId: "run1", startedAt: T0 + 300, configDir: DIR, ...extra };
}

function row(pid: number, startedAt: number, extra: Partial<AgentRow> = {}): AgentRow {
  return { sessionId: SID, pid, startedAt, configDir: DIR, ...extra };
}

/** A registry over a process table of `alive` and a clock that reads `at`. */
function registry(alive: Set<number> = new Set([100, 200, 300])) {
  const clock = { at: T0 + 1_000 };
  const runs = new SidecarRuns({
    sidecarDir: "/sidecars",
    isAlive: (pid) => alive.has(pid),
    now: () => clock.at,
  });
  return { runs, clock, alive };
}

describe("a run is live while its sidecar's connection is open", () => {
  test("named: live, with the socket its sidecar bound", () => {
    const { runs } = registry();
    const a = {};
    runs.announce(a, hello({ hyouiSessionId: "hy-1" }), []);
    expect(runs.liveOf(SID)).toEqual([
      {
        sid: SID,
        runId: "run1",
        startedAt: T0 + 300,
        configDir: DIR,
        hyouiSessionId: "hy-1",
        socket: `/sidecars/${SID}.run1.sock`,
      },
    ]);
    expect(runs.liveOf(OTHER)).toEqual([]);
  });

  test("closed: gone, and only the connection that named it takes it away", () => {
    const { runs } = registry();
    const first = {};
    const second = {};
    runs.announce(first, hello(), []);
    // The same run named again on a new connection (its sidecar was started
    // again) before the first connection's close arrived.
    runs.announce(second, hello({ hyouiSessionId: "hy-2" }), []);
    expect(runs.liveOf(SID).map((r) => r.hyouiSessionId)).toEqual(["hy-2"]);
    expect(runs.leave(first)).toBe(false);
    expect(runs.liveOf(SID).length).toBe(1);
    expect(runs.leave(second)).toBe(true);
    expect(runs.liveOf(SID)).toEqual([]);
    expect(runs.leave(second)).toBe(false);
  });

  // A resume started twice: one session, two harness processes, each with a
  // run id of its own. Listed oldest first, the order user_prompt asks in.
  test("two runs of one session are both live and told apart by run id", () => {
    const { runs } = registry();
    const late = {};
    const early = {};
    runs.announce(late, hello({ runId: "run2", startedAt: T0 + 900 }), []);
    runs.announce(early, hello({ runId: "run1", startedAt: T0 + 300 }), []);
    expect(runs.liveOf(SID).map((r) => r.runId)).toEqual(["run1", "run2"]);
    runs.leave(early);
    expect(runs.liveOf(SID).map((r) => r.runId)).toEqual(["run2"]);
  });

  // A connection names one run: a second hello on it moves it (the module's
  // sidecar is per session id, so this is the same sidecar renamed).
  test("a connection that names another run no longer holds the first", () => {
    const { runs } = registry();
    const conn = {};
    runs.announce(conn, hello(), []);
    runs.announce(conn, hello({ runId: "run9" }), []);
    expect(runs.liveOf(SID).map((r) => r.runId)).toEqual(["run9"]);
  });
});

describe("the harness pid of a run", () => {
  // `claude agents --json` lists each process with its start; the module was
  // loaded just after its process started, so the nearest start is its run's.
  test("is the session's row whose start is nearest the run's", () => {
    const { runs } = registry();
    const rows = [row(100, T0), row(200, T0 + 800), row(300, T0 + 250, { sessionId: OTHER })];
    expect(runs.announce({}, hello({ startedAt: T0 + 300 }), rows).pid).toBe(100);
    expect(runs.announce({}, hello({ runId: "run2", startedAt: T0 + 900 }), rows).pid).toBe(200);
  });

  test("is looked for in the run's own config dir only, when it names one", () => {
    const { runs } = registry();
    const rows = [row(100, T0 + 300, { configDir: "/h/.claude-b" }), row(200, T0)];
    expect(runs.announce({}, hello(), rows).pid).toBe(200);
    expect(runs.announce({}, hello({ runId: "run2", configDir: undefined }), rows).pid).toBe(100);
  });

  // Two runs never share one process: a run whose own row is not listed yet
  // stays without a pid rather than taking its sibling's.
  test("is not one another live run of the session already has", () => {
    const { runs } = registry();
    const rows = [row(100, T0)];
    expect(runs.announce({}, hello(), rows).pid).toBe(100);
    expect(runs.announce({}, hello({ runId: "run2", startedAt: T0 + 900 }), rows).pid).toBe(
      undefined,
    );
  });

  test("not listed yet: found by a later poll", () => {
    const { runs, clock } = registry();
    runs.announce({}, hello(), []);
    expect(runs.liveOf(SID)[0]?.pid).toBeUndefined();
    clock.at += 5_000;
    const { found } = runs.reconcile({ agents: [row(100, T0)], answeredDirs: [DIR] }, T0 + 2_000);
    expect(found.map((run) => run.pid)).toEqual([100]);
    expect(runs.liveOf(SID)[0]?.pid).toBe(100);
  });
});

describe("a run whose harness is gone", () => {
  // A sidecar can outlive its harness (one whose output is not a socket
  // notices only when a write to the module fails), with its connection to
  // the daemon still open.
  test("a pid that no longer runs: not live, and dropped by the next poll", () => {
    const { runs, alive } = registry();
    runs.announce({}, hello(), [row(100, T0)]);
    alive.delete(100);
    expect(runs.liveOf(SID)).toEqual([]);
    expect(runs.reconcile({ agents: [], answeredDirs: [DIR] }, T0).dropped.length).toBe(1);
    alive.add(100);
    expect(runs.liveOf(SID)).toEqual([]);
  });

  // A poll that began after the run was named, of the run's config dir, that
  // lists no process of its session: the harness is gone.
  test("a session its config dir no longer lists: dropped by a poll begun after the name", () => {
    const { runs } = registry();
    // Named at T0 + 1000.
    runs.announce({}, hello(), []);
    // Begun before the run was named: says nothing about it.
    expect(runs.reconcile({ agents: [], answeredDirs: [DIR] }, T0 + 500).dropped).toEqual([]);
    expect(runs.liveOf(SID).length).toBe(1);
    // Another dir answered, not the run's: says nothing either.
    const other = runs.reconcile({ agents: [], answeredDirs: ["/h/.claude-b"] }, T0 + 2_000);
    expect(other.dropped).toEqual([]);
    expect(runs.liveOf(SID).length).toBe(1);
    const own = runs.reconcile({ agents: [], answeredDirs: [DIR] }, T0 + 2_000);
    expect(own.dropped.map((run) => run.runId)).toEqual(["run1"]);
    expect(runs.liveOf(SID)).toEqual([]);
  });

  test("a poll that changes nothing says so", () => {
    const { runs } = registry();
    runs.announce({}, hello(), [row(100, T0)]);
    expect(runs.reconcile({ agents: [row(100, T0)], answeredDirs: [DIR] }, T0)).toEqual({
      found: [],
      dropped: [],
    });
  });
});

describe("a session that changed its id (/clear, /resume)", () => {
  // The module keeps its run id across the change and starts a sidecar under
  // the new id, so a run once named under the old id is now live under another.
  test("its run now serves another id: moved on", () => {
    const { runs } = registry();
    const before = {};
    runs.announce(before, hello(), []);
    expect(runs.movedOn(SID)).toBe(false);
    runs.leave(before);
    runs.announce({}, hello({ sid: OTHER }), []);
    expect(runs.movedOn(SID)).toBe(true);
    expect(runs.movedOn(OTHER)).toBe(false);
  });

  test("a live run of the id itself, or no run of it ever: not moved on", () => {
    const { runs } = registry();
    runs.announce({}, hello({ runId: "run2" }), []);
    runs.announce({}, hello({ sid: OTHER }), []);
    expect(runs.movedOn(SID)).toBe(false);
    expect(runs.movedOn("aaaaaaaa-2222-4333-8444-555555555555")).toBe(false);
  });

  // What a run once served is kept while the run lives on — between two of
  // its sidecars included — and let go once a poll begun after the run's last
  // close finds it named nowhere.
  test("forgotten once the run itself is gone", () => {
    const { runs, clock } = registry();
    const before = {};
    runs.announce(before, hello(), []);
    runs.leave(before);
    const after = {};
    runs.announce(after, hello({ sid: OTHER }), []);
    clock.at += 1_000;
    runs.leave(after);
    // Begun before that close: the run may be between two sidecars.
    runs.reconcile({ agents: [], answeredDirs: [] }, clock.at - 500);
    const again = {};
    runs.announce(again, hello({ sid: OTHER }), []);
    expect(runs.movedOn(SID)).toBe(true);
    clock.at += 1_000;
    runs.leave(again);
    runs.reconcile({ agents: [], answeredDirs: [] }, clock.at + 500);
    runs.announce({}, hello({ sid: OTHER }), []);
    expect(runs.movedOn(SID)).toBe(false);
  });
});
