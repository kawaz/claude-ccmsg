// Client-side reply pairing (DR-0029 addendum). The CLI stamps a request_id on
// every request and settles on the reply carrying it back; the two cases below
// are the ones the daemon's own tests cannot cover, because they need a peer
// that answers differently than the current daemon does.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { PROTOCOL_VERSION, VERSION } from "@ccmsg/protocol";
import { Client, helloRequest } from "../src/client.ts";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

/** A UDS peer that answers each request line with `reply(request)`. */
async function fakeDaemon(reply: (req: any) => unknown[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-client-corr-"));
  const sock = path.join(dir, "daemon.sock");
  const server = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(socket, chunk) {
        for (const line of new TextDecoder().decode(chunk).split("\n")) {
          if (line.trim() === "") continue;
          for (const frame of reply(JSON.parse(line))) {
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
  const held: any[] = [];
  const sock = await fakeDaemon((req) => {
    held.push(req);
    if (held.length < 2) return [];
    const [first, second] = held;
    return [
      { ok: true, which: "second", request_id: second.request_id },
      { ok: true, which: "first", request_id: first.request_id },
    ];
  });
  const client = await Client.connect(sock);
  const a = client.request<{ which: string }>({ op: "ping" });
  const b = client.request<{ which: string }>({ op: "peers" });
  expect((await a).which).toBe("first");
  expect((await b).which).toBe("second");
  client.close();
});

test("a reply with no request_id is accepted, so a pre-correlation daemon can still be talked to", async () => {
  // This is the version-mismatch path: ensureDaemon has to complete a hello
  // against an older daemon before it can decide to replace it, and that
  // daemon echoes nothing.
  const sock = await fakeDaemon(() => [{ ok: true, version: "0.0.1" }]);
  const client = await Client.connect(sock);
  expect(await client.request<{ version: string }>({ op: "hello", role: "user" })).toMatchObject({
    ok: true,
    version: "0.0.1",
  });
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
test("a request on a connection already closed fails at once", async () => {
  const client = await Client.connect(closingPeer());
  expect(await client.readLine()).toBeNull();
  const late = client.request({ op: "ping" });
  const outcome = await Promise.race([
    late.then(
      () => "answered",
      (e: Error) => e.message,
    ),
    Bun.sleep(1_000).then(() => "still waiting"),
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
          const req = JSON.parse(buf.slice(0, at));
          buf = buf.slice(at + 1);
          socket.write(
            `${JSON.stringify({ ok: true, size: req.text.length, request_id: req.request_id })}\n`,
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
    sizes.map((size) => client.request<{ size: number }>({ op: "x", text: "y".repeat(size) })),
  );
  expect(answers.map((a) => a.size)).toEqual(sizes);
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
