// A UDS peer standing in for the daemon, for the tests of the client's side of
// a conversation the current daemon would not hold: replies out of order, a
// reply from an older daemon, a refusal, a connection dropped mid-handshake.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jsonText, parseWith, type RequestFrame, RequestFrameSchema } from "@ccmsg/protocol";

const RequestFrameTextSchema = jsonText(RequestFrameSchema);

/** A request line the client wrote, read as the frame every request has. */
export function frameOf(line: string): RequestFrame {
  const read = parseWith(RequestFrameTextSchema, line);
  if (!read.ok) throw new Error(`the client wrote no request frame: ${read.failure.summary}`);
  return read.value;
}

/** What the peer does with one request: write these lines back, or hang up
 * without answering. */
export type FakeAnswer = object[] | "hang up";

export interface FakeDaemon {
  readonly sock: string;
  /** Every request read, in the order the client wrote them. */
  readonly requests: readonly RequestFrame[];
  /** Stop listening and remove the socket's directory. */
  stop(): void;
}

/** A peer listening on a socket of its own that answers each request line
 * with `answer(request)`. */
export function fakeDaemon(answer: (req: RequestFrame) => FakeAnswer): FakeDaemon {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fake-daemon-"));
  const sock = path.join(dir, "daemon.sock");
  const requests: RequestFrame[] = [];
  const server = Bun.listen<{ buf: string; decoder: TextDecoder }>({
    unix: sock,
    socket: {
      open(socket) {
        socket.data = { buf: "", decoder: new TextDecoder() };
      },
      data(socket, chunk) {
        const conn = socket.data;
        conn.buf += conn.decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = conn.buf.indexOf("\n")) >= 0) {
          const req = frameOf(conn.buf.slice(0, at));
          conn.buf = conn.buf.slice(at + 1);
          requests.push(req);
          const reply = answer(req);
          if (reply === "hang up") {
            socket.end();
            return;
          }
          for (const frame of reply) socket.write(`${JSON.stringify(frame)}\n`);
        }
      },
      close() {},
      error() {},
    },
  });
  return {
    sock,
    requests,
    stop() {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
