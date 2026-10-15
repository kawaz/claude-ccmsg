// A fake Claude Code harness for observing peer-inject delivery: the
// `sessions/<pid>.json` state file and the `<pid>.<hex>.key` beside it in a
// temp config dir, and a UDS bound under /tmp that records the frames it is
// sent. A session that says hello with this `config_dir` receives direct
// messages on `nextUser()`.
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonObject, type Output, parseWith, PROTOCOL_VERSION } from "@ccmsg/protocol";
import * as v from "valibot";
import { connect, type DaemonCtx, jsonObjectOf, type TestClient } from "./helpers.ts";

export const PEER_TOKEN = "tok-abc";

/** The launcher a test daemon names in the envelope's reply line: `bin/ccmsg`
 * of this working copy (resolveLauncher from packages/daemon/src). */
export const LAUNCHER = fileURLToPath(new URL("../../../bin/ccmsg", import.meta.url));

/** Splits an envelope into its attributes and its inner text (the message
 * body, followed by the reply line when there is one). */
export function parseEnvelope(content: string): {
  attrs: Record<string, string>;
  body: string;
} {
  const m = /^<cross-session-message ([^>]*)>\n([\s\S]*)\n<\/cross-session-message>$/.exec(content);
  if (!m) throw new Error(`not an envelope: ${content}`);
  const [, attributes = "", body = ""] = m;
  const attrs: Record<string, string> = {};
  for (const [, name = "", value = ""] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attrs[name] = value;
  }
  return { attrs, body };
}

/** The message frame peer-inject writes after the token. Fields the test
 * does not read are kept, so a frame compares whole. */
const UserFrameSchema = v.looseObject({
  type: v.literal("user"),
  from: v.optional(v.string()),
  session_id: v.string(),
  msg_id: v.string(),
  message: v.looseObject({ content: v.string() }),
});
type UserFrame = Output<typeof UserFrameSchema>;

/** A `user` frame read as one: a frame of that type in another shape fails
 * the test that sent it. */
function readUserFrame(frame: JsonObject): UserFrame {
  const read = parseWith(UserFrameSchema, frame);
  if (!read.ok) throw new Error(`not a peer-inject user frame: ${read.failure.summary}`);
  return read.value;
}

export interface FakeHarness {
  configDir: string;
  socketPath: string;
  /** Every line the socket received, parsed. */
  frames: JsonObject[];
  /** Resolves with the next `user` frame, in arrival order. */
  nextUser(): Promise<UserFrame>;
  /** Resolves with the next `user` frame's envelope text. */
  nextContent(): Promise<string>;
  /** Answer each `user` frame with this status on its `from` socket. */
  refuseWith?: string;
  /** Settles once the socket takes connections. */
  listening: Promise<void>;
  stop(): void;
  /** Unbind the socket and remove the temp dirs. */
  dispose(): void;
}

/** `stall`: the socket accepts connections and never reads them, as a
 * harness that has stopped reading does — a write bigger than the socket's
 * buffer goes in part-way and then waits. Nothing is recorded.
 *
 * `readAfterMs`: the socket starts reading each connection that long after
 * accepting it, so a write bigger than its buffer finishes only then. Frames
 * are recorded and answered as usual.
 *
 * `pid` names the harness process (a pid no process has by default; a live
 * one for what looks for running processes), `cwd` is the working directory
 * the state file records, and `configDir` puts this run into another
 * harness's config dir, as a second run of the same config home. */
export function fakeHarness(
  sid: string,
  opts: {
    peerProtocol?: number;
    stall?: boolean;
    readAfterMs?: number;
    pid?: number;
    cwd?: string;
    name?: string;
    configDir?: string;
  } = {},
): FakeHarness {
  const configDir = opts.configDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-"));
  const sockDir = fs.mkdtempSync("/tmp/pi-");
  const socketPath = path.join(sockDir, "s.sock");
  const pid = opts.pid ?? 424242;
  fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      messagingSocketPath: socketPath,
      peerProtocol: opts.peerProtocol ?? 1,
    }),
  );
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.0123abcd.key`),
    JSON.stringify({ peerToken: PEER_TOKEN }),
  );
  const waiters: ((f: UserFrame) => void)[] = [];
  const users: UserFrame[] = [];
  const nextUser = (): Promise<UserFrame> => {
    const buffered = users.shift();
    return buffered !== undefined
      ? Promise.resolve(buffered)
      : new Promise((resolve) => waiters.push(resolve));
  };
  let stopServer = (): void => {};
  const harness: FakeHarness = {
    configDir,
    socketPath,
    frames: [],
    nextUser,
    nextContent: async () => (await nextUser()).message.content,
    listening: Promise.resolve(),
    stop: () => stopServer(),
    dispose: () => {
      stopServer();
      // A config dir lent by another harness is that harness's to remove.
      if (opts.configDir === undefined) fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(sockDir, { recursive: true, force: true });
    },
  };

  /** One frame read: recorded, refused at once when asked to, handed on. */
  const onFrame = (frame: JsonObject): void => {
    harness.frames.push(frame);
    if (frame.type !== "user") return;
    const user = readUserFrame(frame);
    if (harness.refuseWith !== undefined && user.from !== undefined) {
      void Bun.connect({
        unix: user.from.slice("uds:".length),
        socket: {
          open(s) {
            s.write(
              `${JSON.stringify({ action: "peer_message_status", status: harness.refuseWith, orig_msg_id: user.msg_id })}\n`,
            );
            s.end();
          },
          data() {},
        },
      });
    }
    const w = waiters.shift();
    if (w) w(user);
    else users.push(user);
  };
  /** A line splitter for one connection. */
  const reader = (): ((chunk: Uint8Array) => void) => {
    let buf = "";
    return (chunk) => {
      buf += Buffer.from(chunk).toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) onFrame(jsonObjectOf(line));
    };
  };

  if (opts.stall === true || opts.readAfterMs !== undefined) {
    const held = new Set<net.Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const paused = net.createServer({ pauseOnConnect: true }, (c) => {
      held.add(c);
      c.on("close", () => held.delete(c));
      if (opts.stall === true) return;
      c.on("data", reader());
      const timer = setTimeout(() => {
        timers.delete(timer);
        c.resume();
      }, opts.readAfterMs);
      timers.add(timer);
    });
    harness.listening = new Promise((resolve) => paused.listen(socketPath, resolve));
    stopServer = (): void => {
      for (const timer of timers) clearTimeout(timer);
      for (const c of held) c.destroy();
      paused.close();
    };
    return harness;
  }
  stopServer = (): void => {
    server.stop(true);
  };
  const readers = new WeakMap<object, (chunk: Uint8Array) => void>();
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        readers.set(socket, reader());
      },
      data(socket, chunk) {
        readers.get(socket)?.(chunk);
      },
    },
  });
  return harness;
}

/** A session-role connection whose hello names `configDir` as its
 * CLAUDE_CONFIG_DIR, so peer-inject can find its harness. */
export async function sessionWithConfig(
  ctx: DaemonCtx,
  sid: string,
  configDir?: string,
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    ...(configDir ? { config_dir: configDir } : {}),
  });
  return c;
}
