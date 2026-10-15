// Client-side reply pairing (DR-0029 addendum). The CLI stamps a request_id on
// every request and settles on the reply carrying it back; the two cases below
// are the ones the daemon's own tests cannot cover, because they need a peer
// that answers differently than the current daemon does.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  jsonText,
  parseWith,
  PROTOCOL_VERSION,
  readRequest,
  type Request,
  type RequestFrame,
  RequestFrameSchema,
  UNANNOUNCED_PROTOCOL_VERSION,
  VERSION,
} from "@ccmsg/protocol";
import { Client, helloRequest } from "../src/client.ts";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const RequestFrameTextSchema = jsonText(RequestFrameSchema);

/** A request line the client wrote, read as the frame every request has. */
function frameOf(line: string): RequestFrame {
  const read = parseWith(RequestFrameTextSchema, line);
  if (!read.ok) throw new Error(`the client wrote no request frame: ${read.failure.summary}`);
  return read.value;
}

/** A request line the client wrote, read as a request of this generation. */
function requestOf(line: string): Request {
  const read = readRequest(line);
  if (read.kind !== "request")
    throw new Error(`the client wrote no request: ${line.slice(0, 200)}`);
  return read.request;
}

/** A UDS peer that answers each request line with `reply(request)`. */
async function fakeDaemon(reply: (req: RequestFrame) => object[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-client-corr-"));
  const sock = path.join(dir, "daemon.sock");
  const server = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(socket, chunk) {
        for (const line of new TextDecoder().decode(chunk).split("\n")) {
          if (line.trim() === "") continue;
          for (const frame of reply(frameOf(line))) {
            socket.write(`${JSON.stringify(frame)}\n`);
          }
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });
  cleanup.push(() => {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return sock;
}

test("a reply is paired by request_id, not by arrival order", async () => {
  // Answers in reverse: the second request is replied to first.
  const held: RequestFrame[] = [];
  const sock = await fakeDaemon((req) => {
    held.push(req);
    const [first, second] = held;
    if (first === undefined || second === undefined) return [];
    return [
      { ok: true, room: "r2", events: [], request_id: second.request_id },
      { ok: true, room: "r1", events: [], request_id: first.request_id },
    ];
  });
  const client = await Client.connect(sock);
  const a = client.request({ op: "room_history", room: "r1" });
  const b = client.request({ op: "room_history", room: "r2" });
  expect(await a).toEqual({ ok: true, room: "r1", events: [] });
  expect(await b).toEqual({ ok: true, room: "r2", events: [] });
  client.close();
});

test("a reply with no request_id settles the oldest request", async () => {
  // The refusal of a line the daemon could not read as a request names no
  // request, and neither does a daemon older than the correlation envelope:
  // ensureDaemon has to complete a hello against one before it can decide to
  // replace it.
  const refusal = { ok: false as const, error: { code: "bad_request", msg: "m" } };
  const sock = await fakeDaemon(() => [refusal]);
  const client = await Client.connect(sock);
  expect(await client.request({ op: "hello", role: "user" })).toEqual(refusal);
  client.close();
});

test("a hello reply with no request_id and no protocol is read, so a pre-correlation daemon can still be talked to", async () => {
  // This is the version-mismatch path: ensureDaemon has to read the version in
  // the hello reply of an older daemon before it can decide to replace it, and
  // that daemon echoes no request_id and announces no generation.
  const sock = await fakeDaemon(() => [{ ok: true, version: "0.0.1" }]);
  const client = await Client.connect(sock);
  expect(await client.request(helloRequest({ role: "user" }))).toEqual({
    ok: true,
    version: "0.0.1",
    protocol: UNANNOUNCED_PROTOCOL_VERSION,
  });
  client.close();
});

test("a reply that is not its op's answer fails the request", async () => {
  const sock = await fakeDaemon((req) => [{ ok: true, request_id: req.request_id }]);
  const client = await Client.connect(sock);
  const failure = await client.request({ op: "room_history", room: "r1" }).then(
    () => "answered",
    (e: Error) => e.message,
  );
  expect(failure).toBe(
    'the daemon\'s reply to room_history is not its answer: room: Invalid key: Expected "room" but received undefined; events: Invalid key: Expected "events" but received undefined',
  );
  client.close();
});

/** A UDS peer that closes each connection as soon as it opens. */
function closingPeer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-client-close-"));
  const sock = path.join(dir, "daemon.sock");
  const server = Bun.listen<undefined>({
    unix: sock,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
      close() {},
      error() {},
    },
  });
  cleanup.push(() => {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return sock;
}

// No close event comes again to settle a wait registered after the close.
// "At once" is before the event loop takes its next turn: a request still
// waiting for its reply then would wait for one that never comes.
test("a request on a connection already closed fails at once", async () => {
  const client = await Client.connect(closingPeer());
  expect(await client.readLine()).toBeNull();
  const late = client.request({ op: "ping" });
  const nextTurn = new Promise<string>((resolve) => setImmediate(() => resolve("still waiting")));
  const outcome = await Promise.race([
    late.then(
      () => "answered",
      (e: Error) => e.message,
    ),
    nextTurn,
  ]);
  expect(outcome).toBe("connection closed before response");
});

// Requests larger than the socket takes at once go out whole and in order:
// the peer answers a line only once all of it has arrived.
test("large requests arrive whole, in the order written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-client-big-"));
  const sock = path.join(dir, "daemon.sock");
  const decoder = new TextDecoder();
  let buf = "";
  const server = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(socket, chunk) {
        buf += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buf.indexOf("\n")) >= 0) {
          const req = requestOf(buf.slice(0, at));
          buf = buf.slice(at + 1);
          if (req.op !== "say") throw new Error(`expected a say, got ${req.op}`);
          socket.write(
            `${JSON.stringify({ ok: true, id: String(req.text.length), request_id: req.request_id })}\n`,
          );
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });
  cleanup.push(() => {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = await Client.connect(sock);
  const sizes = [1_000_000, 300_000, 10];
  const answers = await Promise.all(
    sizes.map((size) => client.request({ op: "say", text: "y".repeat(size) })),
  );
  expect(answers.map((a) => (a.ok ? a.id : a.error.msg))).toEqual(sizes.map(String));
  client.close();
});

test("every hello announces this build and the generation it speaks", () => {
  // Both roles: a stale `ccmsg subscribe` is a session-role client, but a
  // browser holding an old bundle is a user-role one, and neither should be
  // able to reach a daemon that has moved on without being noticed.
  expect(helloRequest({ role: "user" })).toMatchObject({
    op: "hello",
    role: "user",
    client_version: VERSION,
    protocol: PROTOCOL_VERSION,
  });
  expect(
    helloRequest({ role: "session", sid: "S", repo: "r", ws: "w", cwd: "/tmp" }),
  ).toMatchObject({
    op: "hello",
    role: "session",
    sid: "S",
    client_version: VERSION,
    protocol: PROTOCOL_VERSION,
  });
});
