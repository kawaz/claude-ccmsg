// A hooks module's `POST /op` over `<state dir>/http.sock` (DR-0046): the
// body is a request of the wire with what it says of who asks, the answer the
// wire's reply. The session is the one the process at the other end of the
// socket runs (its `sessions/<pid>.json`); each request is a connection of its
// own, so the ops that mean something only on a connection that stays open
// are refused.
//
// Here the asking process is this test process: its pid is the peer the
// daemon reads, and the tests write the state file that names its session.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { BODY_MAX_BYTES, HEAD_MAX_BYTES, readHttp1 } from "../src/http1.ts";
import { listenOpHttp } from "../src/op-http.ts";
import {
  fixtureDir,
  type InProcessDaemon,
  refusedReply,
  servedReply,
  sessionConn,
  startInProcessDaemon,
  startTestDaemon,
  stopInProcessDaemon,
  stopTestDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { fakeHarness, parseEnvelope } from "./peer-harness.ts";

const SID = "0b000000-0000-4000-8000-000000000001";
const HELLO = { sid: SID, protocol: PROTOCOL_VERSION } as const;

/** Write `<configDir>/sessions/<pid>.json` naming `sid`, as Claude Code
 * writes one for its process. */
function recordSession(configDir: string, pid: number, sid: string, cwd = "/tmp"): void {
  fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "sessions", `${String(pid)}.json`),
    JSON.stringify({ pid, sessionId: sid, cwd, startedAt: 1, kind: "interactive" }),
  );
}

/** A daemon in this process with its `POST /op` listening, and this process
 * recorded as session SID in a config dir the daemon reaches: one a hello of
 * SID announced, as its sidecar's does. */
async function started(): Promise<{
  ctx: InProcessDaemon;
  configDir: string;
  sidecar: TestClient;
}> {
  const ctx = await startInProcessDaemon();
  ctx.daemon.opHttp = listenOpHttp(ctx.daemon);
  const configDir = path.join(ctx.base, "claude-config");
  recordSession(configDir, process.pid, SID);
  const sidecar = await sessionConn(ctx, SID, { config_dir: configDir });
  return { ctx, configDir, sidecar };
}

async function stopped(run: { ctx: InProcessDaemon; sidecar: TestClient }): Promise<void> {
  run.sidecar.close();
  await stopInProcessDaemon(run.ctx);
}

/** One request to the socket, as the module makes it. */
async function post(
  ctx: InProcessDaemon,
  body: string,
  init: { method?: string; path?: string } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://ccmsg${init.path ?? "/op"}`, {
    unix: ctx.daemon.paths.httpSock,
    method: init.method ?? "POST",
    ...(init.method === "GET" ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

/** `request` asked with `hello`. */
const asked = (request: object, hello: object = HELLO) => JSON.stringify({ ...request, hello });

describe("POST /op", () => {
  test("serves the op as the session this process runs, and answers the wire's reply", async () => {
    const run = await started();
    try {
      const { status, text } = await post(run.ctx, asked({ op: "peer_list" }));
      expect(status).toBe(200);
      expect(servedReply("peer_list", text).ok).toBe(true);
      // The connection the request was is gone with its reply: the sidecar's
      // is the one left.
      expect(run.ctx.daemon.connections.size).toBe(1);
    } finally {
      await stopped(run);
    }
  });

  // The hello names no location: the location the sidecar's hello gave is
  // kept, and the facts land under the process's session.
  test("the registered location is kept, and the facts land as the session's", async () => {
    const ctx = await startInProcessDaemon();
    ctx.daemon.opHttp = listenOpHttp(ctx.daemon);
    const configDir = path.join(ctx.base, "claude-config");
    recordSession(configDir, process.pid, SID);
    const sidecar = await sessionConn(ctx, SID, {
      repo: "r",
      ws: "w",
      cwd: "/tmp",
      config_dir: configDir,
    });
    try {
      const facts = { at: 5, model: "claude-opus-5-5[1m]" };
      const { status, text } = await post(ctx, asked({ op: "session_facts", facts }));
      expect(status).toBe(200);
      servedReply("session_facts", text);
      expect(ctx.daemon.sessionFacts.get(SID)).toEqual(facts);
      const user = await userConn(ctx);
      const peers = await user.requestOk({ op: "peers" });
      const row = peers.peers.find((p) => p.sid === SID);
      expect([row?.repo, row?.ws, row?.cwd]).toEqual(["r", "w", fs.realpathSync("/tmp")]);
      user.close();
    } finally {
      sidecar.close();
      await stopInProcessDaemon(ctx);
    }
  });

  // Who asks is the process, not the body: a process no state file in reach
  // names, and a body naming another session than the process runs, are
  // refused before anything is served.
  test("a process that is not a session in reach, or runs another, is unknown_peer", async () => {
    const ctx = await startInProcessDaemon();
    ctx.daemon.opHttp = listenOpHttp(ctx.daemon);
    const configDir = path.join(ctx.base, "claude-config");
    try {
      const facts = { op: "session_facts", facts: { at: 1 } };
      // No state file of this process anywhere.
      const unrecorded = refusedReply(
        "an unrecorded process",
        (await post(ctx, asked(facts))).text,
      );
      expect(unrecorded.error.code).toBe("unknown_peer");
      expect(unrecorded.error.msg).toContain(
        `process ${String(process.pid)} is not a Claude Code session`,
      );
      // A state file in a dir the daemon does not reach (no hello named it).
      recordSession(configDir, process.pid, SID);
      expect(refusedReply("out of reach", (await post(ctx, asked(facts))).text).error.code).toBe(
        "unknown_peer",
      );
      // In reach, but the body means another session (the id just changed).
      const sidecar = await sessionConn(ctx, SID, { config_dir: configDir });
      const other = "0b000000-0000-4000-8000-000000000002";
      const mismatch = refusedReply(
        "another session",
        (await post(ctx, asked(facts, { ...HELLO, sid: other }))).text,
      );
      expect(mismatch.error).toEqual({
        code: "unknown_peer",
        msg: `process ${String(process.pid)} runs session ${SID}, not ${other} (its id may have just changed: /clear, /resume)`,
      });
      expect(ctx.daemon.sessionFacts.get(SID)).toBeUndefined();
      expect(ctx.daemon.sessionFacts.get(other)).toBeUndefined();
      // A file that is not this process's (its pid field another) names nobody.
      fs.writeFileSync(
        path.join(configDir, "sessions", `${String(process.pid)}.json`),
        JSON.stringify({ pid: 1, sessionId: SID }),
      );
      expect(refusedReply("another's file", (await post(ctx, asked(facts))).text).error.code).toBe(
        "unknown_peer",
      );
      sidecar.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // The generation is checked as on daemon.sock.
  test("a hello of another generation is refused with the generation spoken", async () => {
    const run = await started();
    try {
      const otherGeneration = await post(
        run.ctx,
        asked({ op: "peer_list" }, { ...HELLO, protocol: PROTOCOL_VERSION + 1 }),
      );
      expect(otherGeneration.status).toBe(200);
      expect(refusedReply("another generation", otherGeneration.text).error).toEqual({
        code: "bad_request",
        msg: `client speaks protocol ${String(PROTOCOL_VERSION + 1)}, this daemon speaks ${String(PROTOCOL_VERSION)}`,
      });
    } finally {
      await stopped(run);
    }
  });

  // What the op is is the wire's to read: an op the daemon does not serve,
  // and one of the user role, are refused as on daemon.sock.
  test("an op that does not read, or not the session role's, is refused as the wire refuses it", async () => {
    const run = await started();
    try {
      const unknown = await post(run.ctx, asked({ op: "no_such_op" }));
      expect(unknown.status).toBe(200);
      expect(refusedReply("an unknown op", unknown.text).error.code).toBe("invalid_args");
      const userOnly = await post(run.ctx, asked({ op: "turn_abort", session_id: SID }));
      expect(refusedReply("a user role op", userOnly.text).error.code).toBe("bad_request");
    } finally {
      await stopped(run);
    }
  });

  test("the ops that need a connection left open are refused, and nothing is named", async () => {
    const ctx = await startInProcessDaemon();
    ctx.daemon.opHttp = listenOpHttp(ctx.daemon);
    try {
      for (const request of [
        { op: "hello", role: "session", sid: SID },
        { op: "sidecar_hello", run_id: "r1", started_at: 1 },
        { op: "subscribe" },
        { op: "transcript_subscribe", sid: SID },
        { op: "transcript_unsubscribe", sid: SID },
        { op: "session_status_subscribe", sid: SID },
        { op: "session_status_unsubscribe", sid: SID },
      ]) {
        const { status, text } = await post(ctx, asked(request));
        expect(status).toBe(200);
        const refusal = refusedReply(request.op, text).error;
        expect(refusal.code).toBe("bad_request");
        expect(refusal.msg).toContain(`op '${request.op}' needs a connection that stays open`);
      }
      expect(ctx.daemon.sessions.has(SID)).toBe(false);
      expect(ctx.daemon.subscribers.size).toBe(0);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("a body that is not a request with its hello is a 400 with the refusal", async () => {
    const run = await started();
    try {
      for (const body of [
        "not json",
        "[1]",
        JSON.stringify({ op: "peer_list" }),
        JSON.stringify({ op: "peer_list", hello: "me" }),
        JSON.stringify({ op: "peer_list", hello: { protocol: 1 } }),
      ]) {
        const { status, text } = await post(run.ctx, body);
        expect({ body, status }).toEqual({ body, status: 400 });
        expect(refusedReply(body, text).error.code).toBe("bad_request");
      }
    } finally {
      await stopped(run);
    }
  });

  test("one path, one method", async () => {
    const run = await started();
    try {
      expect((await post(run.ctx, asked({ op: "ping" }), { path: "/ops" })).status).toBe(404);
      const get = await fetch("http://ccmsg/op", { unix: run.ctx.daemon.paths.httpSock });
      expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    } finally {
      await stopped(run);
    }
  });

  // The socket is the uid's alone, as daemon.sock is (DR-0046 §5).
  test("the socket is the owner's alone, and one a predecessor left is replaced", async () => {
    const ctx = await startInProcessDaemon();
    try {
      fs.writeFileSync(ctx.daemon.paths.httpSock, "stale");
      ctx.daemon.opHttp = listenOpHttp(ctx.daemon);
      const stat = fs.statSync(ctx.daemon.paths.httpSock);
      expect(stat.isSocket()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // The request is read off the connection as it comes: in any pieces, and
  // answered once whole, the connection closing with the answer.
  test("a request sent in pieces is answered once whole, and the connection closes", async () => {
    const run = await started();
    try {
      const body = asked({ op: "ping" });
      const raw = `POST /op HTTP/1.1\r\nHost: ccmsg\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;
      const got = Promise.withResolvers<string>();
      let text = "";
      const socket = await Bun.connect({
        unix: run.ctx.daemon.paths.httpSock,
        socket: {
          data(_s, chunk) {
            text += new TextDecoder().decode(chunk);
          },
          close() {
            got.resolve(text);
          },
        },
      });
      for (let at = 0; at < raw.length; at += 7) {
        socket.write(raw.slice(at, at + 7));
        await Bun.sleep(1);
      }
      const response = await got.promise;
      expect(response.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(response).toContain("\r\nconnection: close\r\n");
      expect(response).toContain('"pong":true');
    } finally {
      await stopped(run);
    }
  });
});

describe("readHttp1", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("a request line, headers and a body of Content-Length bytes", () => {
    const body = '{"op":"ping","text":"日本語"}';
    const head = `POST /op HTTP/1.1\r\nHost: x\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n\r\n`;
    expect(readHttp1(bytes(head + body))).toEqual({
      kind: "request",
      request: { method: "POST", path: "/op", body },
    });
    // Short of the head's end or of the body: not yet.
    expect(readHttp1(bytes(head.slice(0, -2))).kind).toBe("incomplete");
    expect(readHttp1(bytes(head + body).subarray(0, head.length + 3)).kind).toBe("incomplete");
    // No Content-Length is no body.
    expect(readHttp1(bytes("GET /op HTTP/1.1\r\nHost: x\r\n\r\n"))).toEqual({
      kind: "request",
      request: { method: "GET", path: "/op", body: "" },
    });
  });

  test("what it does not read is refused, not guessed", () => {
    const refused = (text: string) => {
      const read = readHttp1(bytes(text));
      return read.kind === "refused" ? read.status : read.kind;
    };
    expect(refused("POST /op HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")).toBe(501);
    expect(refused("POST /op HTTP/1.1\r\nContent-Length: x\r\n\r\n")).toBe(400);
    expect(
      refused(`POST /op HTTP/1.1\r\nContent-Length: ${String(BODY_MAX_BYTES + 1)}\r\n\r\n`),
    ).toBe(413);
    expect(refused("HELLO\r\n\r\n")).toBe(400);
    expect(refused("POST /op HTTP/1.1\r\nno colon\r\n\r\n")).toBe(400);
    expect(refused(`POST /op HTTP/1.1\r\nX: ${"a".repeat(HEAD_MAX_BYTES)}`)).toBe(431);
  });
});

// `send` and `peers` (DR-0039 §3) over POST /op, end to end: the sessions are
// matched against the live runs of the sessions the daemon reaches (DR-0034
// §2), here those of the config dir it is told to serve.
describe("send_message and peer_list over POST /op", () => {
  const OTHER = "22222222-2222-4333-8444-555555555555";
  const BARE = "33333333-2222-4333-8444-555555555555";
  const RUN = "mgq1k2x3abcd1234";

  test("sends to the sessions `to` names, as the asking process's session, and lists them", async () => {
    const work = fs.realpathSync(fixtureDir("op-http-work"));
    // Two sessions in one directory, each a running process (not this one,
    // which asks): one has a hooks module (its run is named), the other none.
    const otherProc = Bun.spawn(["sleep", "60"]);
    const other = fakeHarness(OTHER, { pid: otherProc.pid, cwd: work, name: "other" });
    const bare = fakeHarness(BARE, { pid: process.ppid, cwd: work, configDir: other.configDir });
    recordSession(other.configDir, process.pid, SID);
    const ctx = await startTestDaemon({ CCMSG_CLAUDE_CONFIG_DIRS: other.configDir });
    const module = await sessionConn(ctx, OTHER, { repo: "", ws: "", cwd: "" });
    try {
      await module.requestOk({ op: "sidecar_hello", run_id: RUN, started_at: 1 });
      const ask = async (request: object) => {
        const res = await fetch("http://ccmsg/op", {
          unix: path.join(ctx.stateDir, "http.sock"),
          method: "POST",
          body: asked(request),
        });
        expect(res.status).toBe(200);
        return res.text();
      };
      const results = async (request: object) =>
        servedReply("send_message", await ask({ op: "send_message", ...request })).results;
      const text = "line 1\n`not run` $HOME 'quoted' \"double\"\n";
      expect(await results({ to: { cwd: work }, text })).toEqual([
        { sid: OTHER, name: "other", cwd: work, outcome: "delivered" },
        { sid: BARE, cwd: work, outcome: "not_delivered", reason: "no_module" },
      ]);
      const { attrs, body } = parseEnvelope(await other.nextContent());
      expect(attrs.from).toBe(`ccmsg:${SID}`);
      expect(body).toBe(text);
      // The name and the id narrow as the cwd does; every field given must match.
      expect(
        (await results({ to: { name: "other", cwd: work }, text: "n" })).map((r) => r.outcome),
      ).toEqual(["delivered"]);
      expect(await results({ to: { name: "other", session_id: BARE }, text: "n" })).toEqual([]);
      const ended = "44444444-2222-4333-8444-555555555555";
      expect(await results({ to: { session_id: ended }, text: "n" })).toEqual([
        { sid: ended, outcome: "not_delivered", reason: "ended" },
      ]);
      const listed = servedReply("peer_list", await ask({ op: "peer_list", cwd_prefix: work }));
      expect(listed.peers).toEqual([
        { sid: OTHER, name: "other", cwd: work, pids: [otherProc.pid], module: true, self: false },
        { sid: BARE, cwd: work, pids: [process.ppid], module: false, self: false },
      ]);
    } finally {
      module.close();
      other.dispose();
      bare.dispose();
      otherProc.kill();
      await stopTestDaemon(ctx);
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
