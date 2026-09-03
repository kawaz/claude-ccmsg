// session_dump_file op contract: the role guard, the 2-phase ack → result
// event carrying the written path, and the sid-not-found classification the
// webui branches on. The op writes a real file into a real dumps/ directory —
// stubbing the write would leave the one thing the op exists for untested.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode } from "@ccmsg/protocol";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RECORD_1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
const RECORD_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A daemon whose data dir is disposable, optionally with `SID` connected and
 * carrying a one-line transcript. The connected route is what the test can
 * inject: the historical route reads `$HOME/.claude*`, which bun's
 * `os.homedir()` resolves from the passwd database rather than the
 * environment, so it cannot be pointed at a fixture in-process. */
function daemonWith(opts: { transcript: boolean }): { daemon: Daemon; dataDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-dump-op-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const sessions = new Map<string, unknown>();
  if (opts.transcript) {
    const file = path.join(root, `${SID}.jsonl`);
    fs.writeFileSync(
      file,
      [
        { timestamp: "2026-07-20T00:00:00Z", uuid: RECORD_1, content: "hello" },
        { timestamp: "2026-07-20T00:00:01Z", uuid: RECORD_2, content: "second" },
      ]
        .map((r) =>
          JSON.stringify({
            timestamp: r.timestamp,
            uuid: r.uuid,
            type: "user",
            message: { role: "user", content: r.content },
          }),
        )
        .join("\n") + "\n",
    );
    sessions.set(SID, { conns: new Set([{}]), meta: { transcript_path: file } });
  }
  const daemon = {
    paths: { dataDir, dumps: path.join(dataDir, "dumps") },
    config: {},
    sessions,
    connections: new Set<Conn>(),
    log: { error() {} },
  } as unknown as Daemon;
  return { daemon, dataDir };
}

/** Drive one request and resolve once `count` frames (replies AND events, in
 * write order) have been written back — same harness as llm-stats-op. */
function requestFrames(
  daemon: Daemon,
  identity: Conn["identity"],
  request: unknown,
  count: number,
): Promise<Record<string, any>[]> {
  return new Promise((resolve) => {
    const frames: Record<string, any>[] = [];
    const conn: Conn = {
      identity,
      subscribed: false,
      write(line) {
        frames.push(JSON.parse(line));
        if (frames.length === count) resolve(frames);
      },
    };
    daemon.connections.add(conn);
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

const USER: Conn["identity"] = { role: "user", id: "u1" } as Conn["identity"];
const SESSION: Conn["identity"] = {
  role: "session",
  sid: "s1",
  repo: "r",
  ws: "w",
} as Conn["identity"];

describe("session_dump_file op", () => {
  test("acks, then answers with the absolute path of the written text dump", async () => {
    const { daemon, dataDir } = daemonWith({ transcript: true });
    const [ack, event] = await requestFrames(
      daemon,
      USER,
      { op: "session_dump_file", request_id: "q1", sid: SID },
      2,
    );
    expect(ack).toEqual({ ok: true, accepted: true, request_id: "q1" });
    expect(event?.ev).toBe("session_dump_file_result");
    expect(event?.request_id).toBe("q1");
    expect(event?.ok).toBe(true);
    // The path is what the caller hands to another session, so it must be
    // absolute, under the daemon's own dumps/, and actually readable.
    expect(path.isAbsolute(event?.path)).toBe(true);
    expect(path.dirname(event?.path)).toBe(path.join(dataDir, "dumps"));
    expect(path.basename(event?.path).startsWith(`${SID}-`)).toBe(true);
    // Text, not jsonl: a successor session reads this file directly instead
    // of parsing it as structured data.
    expect(path.basename(event?.path).endsWith(".txt")).toBe(true);
    const written = fs.readFileSync(event?.path, "utf8");
    expect(written).toContain(`Session: ${SID}`);
    expect(written).toContain("[+0ms user user→self]\nhello");
    expect(event?.bytes).toBe(Buffer.byteLength(written));
    expect(event?.entries).toBe(2);
  });

  // The dump is the whole session's contents; a session-role peer asking for
  // another session's would be reading past its own boundary.
  test("refuses a session-role caller before doing any work", async () => {
    const { daemon, dataDir } = daemonWith({ transcript: true });
    const [reply] = await requestFrames(
      daemon,
      SESSION,
      { op: "session_dump_file", request_id: "q2", sid: SID },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
    expect(fs.existsSync(path.join(dataDir, "dumps"))).toBe(false);
  });

  // "pick another session" is the fix, so it must not read as a daemon fault.
  test("reports an unresolvable sid as session_not_found", async () => {
    const { daemon } = daemonWith({ transcript: false });
    const [, event] = await requestFrames(
      daemon,
      USER,
      { op: "session_dump_file", request_id: "q3", sid: SID },
      2,
    );
    expect(event?.ok).toBe(false);
    expect(event?.error.code).toBe(ErrorCode.session_not_found);
  });

  // The wire fields exist so the webui can dump "from this message on" using a
  // uuid it already displays; a bound that never reached dumpSession would
  // look identical to a full dump.
  test("passes a record-uuid bound through to the dump", async () => {
    const { daemon } = daemonWith({ transcript: true });
    const [, event] = await requestFrames(
      daemon,
      USER,
      { op: "session_dump_file", request_id: "q5", sid: SID, since: RECORD_2 },
      2,
    );
    expect(event?.ok).toBe(true);
    expect(event?.entries).toBe(1);
    const written = fs.readFileSync(event?.path, "utf8");
    expect(written).toContain("second");
    expect(written).not.toContain("hello");
  });

  test("reports a uuid this session never recorded as an error event", async () => {
    const { daemon } = daemonWith({ transcript: true });
    const [, event] = await requestFrames(
      daemon,
      USER,
      {
        op: "session_dump_file",
        request_id: "q6",
        sid: SID,
        since: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      2,
    );
    expect(event?.ok).toBe(false);
    expect(event?.error.msg).toContain("not found in this session's transcript");
  });

  test("requires a request_id, like every other op", async () => {
    const { daemon } = daemonWith({ transcript: true });
    const [reply] = await requestFrames(daemon, USER, { op: "session_dump_file", sid: SID }, 1);
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });
});
