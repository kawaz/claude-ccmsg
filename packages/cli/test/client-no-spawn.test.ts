// The client's attaches that never spawn a daemon (a sidecar naming its run):
// what each gives
// back when no daemon listens, when the daemon refuses a step, and when the
// connection drops mid-handshake. The end-to-end tests drive these against a
// real daemon, which accepts; a refusal or a drop needs a peer that answers
// otherwise.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  type Paths,
  PROTOCOL_VERSION,
  type RequestFrame,
  resolvePaths,
  type SessionIdentity,
  VERSION,
} from "@ccmsg/protocol";
import { connectIfRunning, nameRunNoSpawn } from "../src/client.ts";
import { type FakeAnswer, type FakeDaemon, fakeDaemon } from "./fake-daemon.ts";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const SESSION: SessionIdentity = {
  role: "session",
  sid: "11111111-2222-4333-8444-555555555555",
  repo: "r",
  ws: "w",
  cwd: "/tmp",
};

const RUN = { runId: "run-1", startedAt: 1 };

/** A fake daemon, stopped once the test ends, and the paths that reach it. */
function daemon(answer: (req: RequestFrame) => FakeAnswer): { peer: FakeDaemon; paths: Paths } {
  const peer = fakeDaemon(answer);
  cleanup.push(() => peer.stop());
  return { peer, paths: resolvePaths({ CCMSG_STATE_DIR: path.dirname(peer.sock) }) };
}

/** Paths whose socket nothing listens on. */
function nobodyListening(): Paths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-no-daemon-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return resolvePaths({ CCMSG_STATE_DIR: dir });
}

const accepted = (req: RequestFrame): object => {
  if (req.op === "hello") {
    return { ok: true, version: VERSION, protocol: PROTOCOL_VERSION, request_id: req.request_id };
  }
  return { ok: true, request_id: req.request_id };
};

const refused = (req: RequestFrame): object => ({
  ok: false,
  error: { code: "bad_request", msg: `no ${req.op}` },
  request_id: req.request_id,
});

/** A peer that accepts every request except `op`, which it answers with
 * `refuse` instead. */
function acceptingBut(
  op: string,
  refuse: (req: RequestFrame) => FakeAnswer,
): (req: RequestFrame) => FakeAnswer {
  return (req: RequestFrame): FakeAnswer => (req.op === op ? refuse(req) : [accepted(req)]);
}

const opsOf = (peer: FakeDaemon): string[] => peer.requests.map((r) => r.op);

describe("connectIfRunning", () => {
  test("connects to a daemon listening, and is null when none does", async () => {
    const { paths } = daemon((req) => [accepted(req)]);
    const client = await connectIfRunning(paths);
    expect(client).not.toBeNull();
    client?.close();
    expect(await connectIfRunning(nobodyListening())).toBeNull();
  });
});

describe("nameRunNoSpawn", () => {
  test("a refused hello is null, and the run is not named", async () => {
    const { peer, paths } = daemon(acceptingBut("hello", (req) => [refused(req)]));
    expect(await nameRunNoSpawn(paths, SESSION, RUN)).toBeNull();
    expect(opsOf(peer)).toEqual(["hello"]);
  });

  test("a refused name is null", async () => {
    const { peer, paths } = daemon(acceptingBut("sidecar_hello", (req) => [refused(req)]));
    expect(await nameRunNoSpawn(paths, SESSION, RUN)).toBeNull();
    expect(opsOf(peer)).toEqual(["hello", "sidecar_hello"]);
  });

  test("a connection dropped mid-handshake is null", async () => {
    const { paths } = daemon(acceptingBut("sidecar_hello", () => "hang up"));
    expect(await nameRunNoSpawn(paths, SESSION, RUN)).toBeNull();
  });
});
