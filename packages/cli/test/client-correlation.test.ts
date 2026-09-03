// Client-side reply pairing (DR-0029 addendum). The CLI stamps a request_id on
// every request and settles on the reply carrying it back; the two cases below
// are the ones the daemon's own tests cannot cover, because they need a peer
// that answers differently than the current daemon does.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "../src/client.ts";

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
