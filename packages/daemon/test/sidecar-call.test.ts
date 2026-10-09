// Requests to a session's hooks module through its sidecar (DR-0035 §3), with
// no op in particular: the line written, the reply matched to its request.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseJsonWith, type SidecarRequest, SidecarRequestSchema } from "@ccmsg/protocol";
import {
  callSidecar,
  liveSidecars,
  RunPids,
  runMovedOn,
  SidecarReplies,
  type SidecarDeps,
} from "../src/sidecar-call.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("SidecarReplies", () => {
  test("the first reply under an id is the one that counts", async () => {
    const replies = new SidecarReplies();
    replies.open("i1", SID);
    const waited = replies.wait("i1", 5_000);
    const first = { id: "i1", ok: false, error: { code: "unknown_op", message: "x" } } as const;
    expect(replies.take(SID, first)).toBe(true);
    expect(replies.take(SID, { id: "i1", ok: true, result: {} })).toBe(true);
    expect(await waited).toEqual(first);
  });

  test("a reply that arrives before the wait still counts", async () => {
    const replies = new SidecarReplies();
    replies.open("i2", SID);
    replies.take(SID, { id: "i2", ok: true, result: 1 });
    expect(await replies.wait("i2", 5_000)).toEqual({ id: "i2", ok: true, result: 1 });
  });

  test("silence until the deadline is no reply, and the id is forgotten", async () => {
    const replies = new SidecarReplies();
    replies.open("i3", SID);
    expect(await replies.wait("i3", 20)).toBeUndefined();
    expect(replies.take(SID, { id: "i3", ok: true, result: 1 })).toBe(false);
  });

  test("a reply from another session is not taken", () => {
    const replies = new SidecarReplies();
    replies.open("i4", SID);
    expect(replies.take(OTHER, { id: "i4", ok: true, result: 1 })).toBe(false);
  });

  test("a closed id takes no reply", () => {
    const replies = new SidecarReplies();
    replies.open("i5", SID);
    replies.close("i5");
    expect(replies.take(SID, { id: "i5", ok: true, result: 1 })).toBe(false);
  });
});

function deps(extra: Partial<SidecarDeps> = {}): SidecarDeps {
  return {
    sidecarDir: "/sidecars",
    replies: new SidecarReplies(),
    newId: () => "id1",
    listDir: async () => [],
    isAlive: () => true,
    write: async () => "written",
    now: Date.now,
    ...extra,
  };
}

describe("liveSidecars", () => {
  test("takes the session's sockets of live harness pids only, in name order", async () => {
    const d = deps({
      listDir: async () => [
        `${SID}.200.sock`,
        `${SID}.100.sock`,
        `${SID}.300.sock`,
        `${OTHER}.100.sock`,
        `${SID}.abc.sock`,
        `${SID}.100.sock.tmp`,
      ],
      isAlive: (pid) => pid !== 300,
    });
    expect(await liveSidecars(SID, d)).toEqual([
      `/sidecars/${SID}.100.sock`,
      `/sidecars/${SID}.200.sock`,
    ]);
  });

  test("a missing directory is no sidecar", async () => {
    const d = deps({
      listDir: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await liveSidecars(SID, d)).toEqual([]);
  });
});

/** The request in a line the daemon wrote. */
function requestIn(line: string): SidecarRequest {
  const read = parseJsonWith(SidecarRequestSchema, line);
  if (!read.ok) throw new Error(`not a sidecar request: ${read.failure.summary}`);
  return read.value;
}

describe("callSidecar", () => {
  // Any op goes out the same way; `describe` stands for one the daemon has no
  // dedicated code for.
  test("writes one versioned line naming the op and waits for its reply", async () => {
    const lines: { socket: string; line: string }[] = [];
    const d: SidecarDeps = deps({
      write: async (socket, line) => {
        lines.push({ socket: path.basename(socket), line });
        d.replies.take(SID, {
          id: requestIn(line).id,
          ok: true,
          result: { v: [1], ops: ["describe", "prompt.send"] },
        });
        return "written";
      },
    });
    const call = await callSidecar(`/sidecars/${SID}.100.sock`, SID, "describe", {}, 1_000, d);
    expect(lines).toEqual([
      {
        socket: `${SID}.100.sock`,
        line: `${JSON.stringify({ v: 1, op: "describe", id: "id1", args: {} })}\n`,
      },
    ]);
    expect(call).toEqual({
      id: "id1",
      write: "written",
      reply: {
        ok: true,
        value: { id: "id1", ok: true, result: { v: [1], ops: ["describe", "prompt.send"] } },
      },
    });
  });

  // The reply names its request, not its op: the result is read by the op's
  // schema here, where the request was made.
  test("a result not of the op's shape is a failure, not a reply", async () => {
    const d: SidecarDeps = deps({
      write: async (_socket, line) => {
        d.replies.take(SID, { id: requestIn(line).id, ok: true, result: { outcome: "accepted" } });
        return "written";
      },
    });
    const call = await callSidecar("/s", SID, "describe", {}, 1_000, d);
    expect(call).toMatchObject({ id: "id1", write: "written", reply: { ok: false } });
  });

  test("a failed reply is read whatever the op", async () => {
    const error = { code: "unknown_op", message: "no op describe" } as const;
    const d: SidecarDeps = deps({
      write: async (_socket, line) => {
        d.replies.take(SID, { id: requestIn(line).id, ok: false, error });
        return "written";
      },
    });
    expect(await callSidecar("/s", SID, "describe", {}, 1_000, d)).toEqual({
      id: "id1",
      write: "written",
      reply: { ok: true, value: { id: "id1", ok: false, error } },
    });
  });

  test("a line nobody took is not written, and its id takes no reply", async () => {
    const d = deps({ write: async () => "not_written" });
    expect(await callSidecar("/s", SID, "describe", {}, 1_000, d)).toEqual({
      id: "id1",
      write: "not_written",
    });
    expect(d.replies.take(SID, { id: "id1", ok: true, result: 1 })).toBe(false);
  });

  test("no reply within the time is a written call without a reply", async () => {
    const call = await callSidecar("/s", SID, "describe", {}, 20, deps());
    expect(call).toEqual({ id: "id1", write: "written", reply: undefined });
  });

  // The line may have reached the module after all: its reply is still
  // waited for, and settles the call.
  test("a write that may have gone in still takes the module's reply", async () => {
    const result = { v: [1], ops: ["describe"] };
    const d: SidecarDeps = deps({
      write: async (_socket, line) => {
        d.replies.take(SID, { id: requestIn(line).id, ok: true, result });
        return "uncertain";
      },
    });
    expect(await callSidecar("/s", SID, "describe", {}, 1_000, d)).toEqual({
      id: "id1",
      write: "uncertain",
      reply: { ok: true, value: { id: "id1", ok: true, result } },
    });
  });
});

describe("RunPids", () => {
  test("keeps an id's pids past the poll that last listed it, until they end", () => {
    const runs = new RunPids();
    const alive = new Set([100, 200]);
    runs.record([{ sessionId: SID, pid: 100 }], (pid) => alive.has(pid));
    // /clear: the process is listed under the new id from now on.
    runs.record([{ sessionId: OTHER, pid: 100 }], (pid) => alive.has(pid));
    expect(runs.pidsOf(SID)).toEqual([100]);
    expect(runs.pidsOf(OTHER)).toEqual([100]);
    alive.delete(100);
    runs.record([], (pid) => alive.has(pid));
    expect(runs.pidsOf(SID)).toEqual([]);
    expect(runs.pidsOf(OTHER)).toEqual([]);
  });

  test("rows without a usable id or pid are skipped", () => {
    const runs = new RunPids();
    runs.record([{ sessionId: "", pid: 5 }, { sessionId: SID, pid: 1 }, { pid: 7 }], () => true);
    expect(runs.pidsOf(SID)).toEqual([]);
  });
});

describe("runMovedOn", () => {
  test("a live process of the id bound under another id", async () => {
    const d = deps({ listDir: async () => [`${OTHER}.100.sock`, `${SID}.abc.sock`, "junk"] });
    expect(await runMovedOn(SID, [100], d)).toBe(true);
    expect(await runMovedOn(SID, [200], d)).toBe(false);
    expect(await runMovedOn(SID, [], d)).toBe(false);
    expect(await runMovedOn(OTHER, [100], d)).toBe(false);
    expect(await runMovedOn(SID, [100], { ...d, isAlive: () => false })).toBe(false);
  });
});
