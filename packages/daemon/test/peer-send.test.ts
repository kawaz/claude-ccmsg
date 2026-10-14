// peer_send / peer_list (DR-0039 §3) over stand-in runs and deliveries: which
// sessions a target matches, what each gets, and what a send says for each.
import { describe, expect, test } from "bun:test";
import type { SessionInputReadiness } from "@ccmsg/protocol";
import type { SessionRun } from "../src/address-send.ts";
import type { InjectFrame, InjectResult } from "../src/peer-inject.ts";
import { listPeers, type PeerSendDeps, sendToPeers } from "../src/peer-send.ts";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "bbbbbbbb-0000-4000-8000-000000000002";
const B = "cccccccc-0000-4000-8000-000000000003";

function run(sid: string, pid: number, fields: { cwd?: string; name?: string } = {}): SessionRun {
  return { configDir: "/cfg", sid, pid, ...fields };
}

/** Deps over `runs`, where `/link` is a symlink to `/work`, `modules` have a
 * hooks module, and each run's delivery answers what `answers` says for its
 * pid (delivered when it says nothing). */
function deps(
  runs: SessionRun[],
  options: {
    modules?: string[];
    answers?: Record<number, InjectResult>;
    readiness?: SessionInputReadiness;
  } = {},
): PeerSendDeps & { frames: { pid: number; frame: InjectFrame }[] } {
  const frames: { pid: number; frame: InjectFrame }[] = [];
  let mid = 0;
  return {
    frames,
    runs: async () => runs,
    realpath: async (dir) => (dir === "/link" ? "/work" : dir === "/gone" ? undefined : dir),
    hasModule: (sid) => (options.modules ?? [A, B, ME]).includes(sid),
    readiness: () => options.readiness ?? { kind: "ended" },
    issueMid: () => `i/${String(++mid)}`,
    deliver: async (r, frame) => {
      frames.push({ pid: r.pid, frame });
      return options.answers?.[r.pid] ?? { outcome: "delivered" };
    },
    log: () => {},
  };
}

describe("sendToPeers", () => {
  test("a directory matches by realpath, whole, and the sender is left out", async () => {
    const d = deps([
      run(ME, 1, { cwd: "/work" }),
      run(A, 2, { cwd: "/link" }),
      run(B, 3, { cwd: "/work/sub" }),
    ]);
    expect(await sendToPeers({ from: ME, to: { cwd: "/link" }, text: "t" }, d)).toEqual([
      { sid: A, cwd: "/work", outcome: "delivered" },
    ]);
    expect(d.frames.map((f) => f.pid)).toEqual([2]);
    expect(d.frames[0]?.frame.content).toContain(`from="ccmsg:${ME}"`);
  });

  test("every field given must match; pid picks the run", async () => {
    const runs = [run(A, 2, { name: "x" }), run(A, 4, { name: "x" }), run(B, 3, { name: "x" })];
    expect(
      (await sendToPeers({ from: ME, to: { name: "x" }, text: "t" }, deps(runs))).map((r) => r.sid),
    ).toEqual([A, B]);
    const d = deps(runs);
    expect(await sendToPeers({ from: ME, to: { name: "x", pid: 4 }, text: "t" }, d)).toEqual([
      { sid: A, name: "x", outcome: "delivered" },
    ]);
    expect(d.frames.map((f) => f.pid)).toEqual([4]);
    expect(
      await sendToPeers({ from: ME, to: { name: "y", session_id: A }, text: "t" }, deps(runs)),
    ).toEqual([]);
  });

  // One run that took it is the session's delivery; one cut off part-way
  // leaves it unconfirmed; failures report the first of refused, unreachable,
  // no_status_socket, no_peer_socket.
  test("a session's runs come to one result", async () => {
    const runs = [run(A, 2), run(A, 4), run(B, 3), run(B, 5)];
    const answers: Record<number, InjectResult> = {
      2: { outcome: "unconfirmed" },
      4: { outcome: "unavailable", cause: "no_peer_socket" },
      3: { outcome: "unavailable", cause: "no_peer_socket" },
      5: { outcome: "refused" },
    };
    expect(
      await sendToPeers({ from: ME, to: { pid: 2 }, text: "t" }, deps(runs, { answers })),
    ).toEqual([{ sid: A, outcome: "unconfirmed" }]);
    expect(
      await sendToPeers({ from: ME, to: { session_id: B }, text: "t" }, deps(runs, { answers })),
    ).toEqual([{ sid: B, outcome: "not_delivered", reason: "refused" }]);
  });

  test("a session without a hooks module is not sent to", async () => {
    const d = deps([run(A, 2)], { modules: [] });
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, d)).toEqual([
      { sid: A, outcome: "not_delivered", reason: "no_module" },
    ]);
    expect(d.frames).toEqual([]);
  });

  test("a session named by id that no run serves says why", async () => {
    const changed = deps([], { readiness: { kind: "session_changed" } });
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, changed)).toEqual([
      { sid: A, outcome: "not_delivered", reason: "session_changed" },
    ]);
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, deps([]))).toEqual([
      { sid: A, outcome: "not_delivered", reason: "ended" },
    ]);
    // Matched by no id, nobody: no result to give.
    expect(
      await sendToPeers({ from: ME, to: { cwd: "/gone" }, text: "t" }, deps([run(A, 2)])),
    ).toEqual([]);
  });

  test("matching the sender alone says self, and sends nothing", async () => {
    const d = deps([run(ME, 1, { name: "me" })]);
    expect(await sendToPeers({ from: ME, to: { name: "me" }, text: "t" }, d)).toEqual([
      { sid: ME, name: "me", outcome: "not_delivered", reason: "self" },
    ]);
    expect(await sendToPeers({ from: ME, to: { session_id: ME }, text: "t" }, deps([]))).toEqual(
      [],
    );
    expect(d.frames).toEqual([]);
  });
});

describe("listPeers", () => {
  test("lists what a send would match, the sender marked, by sid", async () => {
    const runs = [run(B, 5, { cwd: "/link" }), run(B, 3, { cwd: "/link" }), run(ME, 1), run(A, 2)];
    expect(await listPeers(ME, {}, deps(runs, { modules: [B] }))).toEqual([
      { sid: ME, pids: [1], module: false, self: true },
      { sid: A, pids: [2], module: false, self: false },
      { sid: B, cwd: "/work", pids: [3, 5], module: true, self: false },
    ]);
    expect((await listPeers(ME, { cwd: "/work" }, deps(runs))).map((p) => p.sid)).toEqual([B]);
  });
});
