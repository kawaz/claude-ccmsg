// Room messages reach a Claude Code session through its peer messaging socket.
// A fake harness stands in for the session: `sessions/<pid>.json` and the
// `<pid>.<hex>.key` beside it in a temp config dir, and a UDS bound under
// /tmp that records the frames it is sent.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { PeerInjector, renderEnvelope, type InjectMessage } from "../src/peer-inject.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const T = 15000;
const SID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "tok-abc";

interface FakeHarness {
  configDir: string;
  socketPath: string;
  /** Every line the socket received, parsed. */
  frames: Record<string, any>[];
  /** Resolves each time a `user` frame arrives. */
  nextUser(): Promise<Record<string, any>>;
  /** Answer the next `user` frame with this status on its `from` socket. */
  refuseWith?: string;
  stop(): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function fakeHarness(opts: { peerProtocol?: number; sid?: string } = {}): FakeHarness {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-"));
  const sockDir = fs.mkdtempSync("/tmp/pi-");
  const socketPath = path.join(sockDir, "s.sock");
  const pid = 424242;
  fs.mkdirSync(path.join(configDir, "sessions"));
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: opts.sid ?? SID,
      messagingSocketPath: socketPath,
      peerProtocol: opts.peerProtocol ?? 1,
    }),
  );
  fs.writeFileSync(
    path.join(configDir, "sessions", `${pid}.0123abcd.key`),
    JSON.stringify({ peerToken: TOKEN }),
  );
  const waiters: ((f: Record<string, any>) => void)[] = [];
  const users: Record<string, any>[] = [];
  let buf = "";
  const harness: FakeHarness = {
    configDir,
    socketPath,
    frames: [],
    nextUser: () =>
      users.length > 0
        ? Promise.resolve(users.shift()!)
        : new Promise((resolve) => waiters.push(resolve)),
    stop: () => server.stop(true),
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
  cleanups.push(() => {
    server.stop(true);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(sockDir, { recursive: true, force: true });
  });
  return harness;
}

const MESSAGE: InjectMessage = {
  mid: "r7m3",
  from: "user",
  fromLabel: "user",
  text: "hello",
  replyLine: "Reply with: /x/bin/ccmsg reply r7m3 <text>",
};

describe("PeerInjector", () => {
  test("writes auth then user with the envelope, and silence is delivery", async () => {
    const h = fakeHarness();
    const injector = new PeerInjector();
    cleanups.push(() => injector.close());
    expect(await injector.send(h.configDir, SID, MESSAGE)).toBe("delivered");
    expect(h.frames[0]).toEqual({ type: "auth", token: TOKEN });
    const user = h.frames[1]!;
    expect(user.type).toBe("user");
    expect(user.session_id).toBe(SID);
    expect(user.msg_id).toBe("r7m3");
    expect(user.from).toMatch(
      new RegExp(`^uds:${path.dirname(h.socketPath)}/\\d+-[0-9a-f]{8}\\.sock$`),
    );
    expect(user.message).toEqual({
      content:
        '<cross-session-message from="ccmsg" from-name="user" from-mode="prompting" ccmsg-mid="r7m3" ccmsg-from="user">\nhello\n\nReply with: /x/bin/ccmsg reply r7m3 <text>\n</cross-session-message>',
    });
  });

  test("a peer_message_status on the from socket is a refusal", async () => {
    const h = fakeHarness();
    h.refuseWith = "held";
    const injector = new PeerInjector({ statusMs: 2000 });
    cleanups.push(() => injector.close());
    expect(await injector.send(h.configDir, SID, MESSAGE)).toBe("refused");
  });

  test("unavailable: unknown sid, other peerProtocol, no socket, no config dir", async () => {
    const injector = new PeerInjector();
    cleanups.push(() => injector.close());
    const other = fakeHarness({ sid: "someone-else" });
    expect(await injector.send(other.configDir, SID, MESSAGE)).toBe("unavailable");
    const v2 = fakeHarness({ peerProtocol: 2 });
    expect(await injector.send(v2.configDir, SID, MESSAGE)).toBe("unavailable");
    const gone = fakeHarness();
    gone.stop();
    expect(await injector.send(gone.configDir, SID, MESSAGE)).toBe("unavailable");
    expect(await injector.send("/nonexistent-pi-config", SID, MESSAGE)).toBe("unavailable");
  });

  test("archived message carries no reply line", () => {
    const { replyLine: _, ...bare } = MESSAGE;
    expect(renderEnvelope(bare)).toBe(
      '<cross-session-message from="ccmsg" from-name="user" from-mode="prompting" ccmsg-mid="r7m3" ccmsg-from="user">\nhello\n</cross-session-message>',
    );
  });
});

async function sessionWithConfig(ctx: DaemonCtx, sid: string, configDir?: string) {
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

describe("daemon delivery through the peer socket", () => {
  test(
    "a message from the User names user as sender",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const h = fakeHarness();
        await sessionWithConfig(ctx, SID, h.configDir);
        const u = await connect(ctx.sock);
        await u.hello({ role: "user" });
        const created = await u.request<{ room: string }>({ op: "create_room", members: [SID] });
        await u.request({ op: "post", room: created.room, msg: "from kawaz" });
        const content = (await h.nextUser()).message.content as string;
        expect(content).toContain(`from-name="user"`);
        expect(content).toContain(`ccmsg-from="user"`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
