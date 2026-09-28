// A fake Claude Code harness for observing peer-inject delivery: the
// `sessions/<pid>.json` state file and the `<pid>.<hex>.key` beside it in a
// temp config dir, and a UDS bound under /tmp that records the frames it is
// sent. A session that says hello with this `config_dir` receives room
// messages on `nextUser()`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { connect, type DaemonCtx, type TestClient } from "./helpers.ts";

export const PEER_TOKEN = "tok-abc";

/** The launcher a test daemon names in the envelope's reply line: `bin/ccmsg`
 * of this working copy (resolveLauncher from packages/daemon/src). */
export const LAUNCHER = fileURLToPath(new URL("../../../bin/ccmsg", import.meta.url));

/** The reply line a recipient of `<room>m<mid>` is told to answer with. */
export function replyWith(mid: string): string {
  return `Reply with: ${LAUNCHER} reply ${mid} <text>`;
}

/** Splits an envelope into its attributes and its inner text (the message
 * body, followed by the reply line when there is one). */
export function parseEnvelope(content: string): {
  attrs: Record<string, string>;
  body: string;
} {
  const m = /^<cross-session-message ([^>]*)>\n([\s\S]*)\n<\/cross-session-message>$/.exec(content);
  if (!m) throw new Error(`not an envelope: ${content}`);
  const attrs: Record<string, string> = {};
  for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
  return { attrs, body: m[2]! };
}

export interface FakeHarness {
  configDir: string;
  socketPath: string;
  /** Every line the socket received, parsed. */
  frames: Record<string, any>[];
  /** Resolves with the next `user` frame, in arrival order. */
  nextUser(): Promise<Record<string, any>>;
  /** Resolves with the next `user` frame's envelope text. */
  nextContent(): Promise<string>;
  /** Answer each `user` frame with this status on its `from` socket. */
  refuseWith?: string;
  stop(): void;
  /** Unbind the socket and remove the temp dirs. */
  dispose(): void;
}

export function fakeHarness(sid: string, opts: { peerProtocol?: number } = {}): FakeHarness {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-"));
  const sockDir = fs.mkdtempSync("/tmp/pi-");
  const socketPath = path.join(sockDir, "s.sock");
  const pid = 424242;
  fs.mkdirSync(path.join(configDir, "sessions"));
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: sid,
      messagingSocketPath: socketPath,
      peerProtocol: opts.peerProtocol ?? 1,
    }),
  );
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.0123abcd.key`),
    JSON.stringify({ peerToken: PEER_TOKEN }),
  );
  const waiters: ((f: Record<string, any>) => void)[] = [];
  const users: Record<string, any>[] = [];
  let buf = "";
  const nextUser = (): Promise<Record<string, any>> =>
    users.length > 0
      ? Promise.resolve(users.shift()!)
      : new Promise((resolve) => waiters.push(resolve));
  const harness: FakeHarness = {
    configDir,
    socketPath,
    frames: [],
    nextUser,
    nextContent: async () => (await nextUser()).message.content as string,
    stop: () => server.stop(true),
    dispose: () => {
      server.stop(true);
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(sockDir, { recursive: true, force: true });
    },
  };
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        buf += Buffer.from(chunk).toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const frame = JSON.parse(line);
          harness.frames.push(frame);
          if (frame.type !== "user") continue;
          if (harness.refuseWith !== undefined && typeof frame.from === "string") {
            void Bun.connect({
              unix: frame.from.slice("uds:".length),
              socket: {
                open(s) {
                  s.write(
                    `${JSON.stringify({ action: "peer_message_status", status: harness.refuseWith, orig_msg_id: frame.msg_id })}\n`,
                  );
                  s.end();
                },
                data() {},
              },
            });
          }
          const w = waiters.shift();
          if (w) w(frame);
          else users.push(frame);
        }
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
