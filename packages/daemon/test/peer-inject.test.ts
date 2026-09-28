// Room messages reach a Claude Code session through its peer messaging socket,
// never through its subscribe stream. A fake harness (peer-harness.ts) stands
// in for the session: `sessions/<pid>.json` and the `<pid>.<hex>.key` beside it
// in a temp config dir, and a UDS bound under /tmp that records the frames it
// is sent.
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { PeerInjector, renderEnvelope, type InjectMessage } from "../src/peer-inject.ts";
import { connect, startTestDaemon, stopTestDaemon } from "./helpers.ts";
import {
  PEER_TOKEN,
  fakeHarness as spawnHarness,
  parseEnvelope,
  replyWith,
  sessionWithConfig,
  type FakeHarness,
} from "./peer-harness.ts";

const T = 15000;
const SID = "11111111-2222-4333-8444-555555555555";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function fakeHarness(opts: { peerProtocol?: number; sid?: string } = {}): FakeHarness {
  const h = spawnHarness(opts.sid ?? SID, opts);
  cleanups.push(() => h.dispose());
  return h;
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
    expect(h.frames[0]).toEqual({ type: "auth", token: PEER_TOKEN });
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

describe("daemon delivery through the peer socket", () => {
  test(
    "a msg reaches the session socket and never its subscribe stream",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const h = fakeHarness();
        const a = await sessionWithConfig(ctx, "SENDER");
        const b = await sessionWithConfig(ctx, SID, h.configDir);
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["SENDER", SID],
        });
        const room = created.room;
        await b.request({ op: "subscribe" });

        const first = await a.request<{ mid: number }>({ op: "post", room, msg: "via socket" });
        const { attrs, body } = parseEnvelope(await h.nextContent());
        expect(attrs["ccmsg-mid"]).toBe(`${room}m${first.mid}`);
        expect(attrs["ccmsg-from"]).toBe("SENDER");
        expect(attrs["from-name"]).toBe("a1");
        expect(body).toBe(`via socket\n\n${replyWith(`${room}m${first.mid}`)}`);

        // Live delivery to subscribers happens before the post is answered, so
        // a round trip on b orders its stream past the moment in question.
        await b.request({ op: "rooms" });
        const pushed = await b.pendingEvents();
        expect(pushed.filter((e) => e.type === "msg")).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a session subscriber gets no msg on any replay path, only the room's other events",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await sessionWithConfig(ctx, "SENDER");
        await sessionWithConfig(ctx, SID);
        const room = (
          await a.request<{ room: string }>({
            op: "create_room",
            members: ["SENDER", SID],
            msg: "opening",
          })
        ).room;
        await a.request({ op: "post", room, msg: "second" });

        const paths: Record<string, Record<string, unknown>> = {
          since_seq: { since_seq: { [room]: 0 } },
          since: { since: { [room]: 0 } },
          backlog: { backlog: true },
          recent: {},
        };
        for (const [name, extra] of Object.entries(paths)) {
          const sub = await sessionWithConfig(ctx, SID);
          await sub.request({ op: "subscribe", ...extra });
          await sub.request({ op: "rooms" });
          const pushed = await sub.pendingEvents();
          const inRoom = pushed.filter((e) => e.r === room || e.ev === "room_cursors");
          expect({ name, msgs: inRoom.filter((e) => e.type === "msg") }).toEqual({
            name,
            msgs: [],
          });
          // The path did run: the cursor replays and the snapshot carry the
          // room's member events, the bare default its cursor summary.
          if (name === "recent") {
            expect(inRoom.some((e) => e.ev === "room_cursors")).toBe(true);
          } else {
            expect({ name, member: inRoom.some((e) => e.type === "member") }).toEqual({
              name,
              member: true,
            });
          }
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a subscribed member of a new room gets its snapshot without the opening msg",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const h = fakeHarness();
        const a = await sessionWithConfig(ctx, "SENDER");
        const b = await sessionWithConfig(ctx, SID, h.configDir);
        await b.request({ op: "subscribe" });
        const room = (
          await a.request<{ room: string }>({
            op: "create_room",
            members: ["SENDER", SID],
            msg: "opening",
          })
        ).room;
        expect(parseEnvelope(await h.nextContent()).attrs["ccmsg-mid"]).toBe(`${room}m1`);
        await b.request({ op: "rooms" });
        const pushed = (await b.pendingEvents()).filter((e) => e.r === room);
        expect(pushed.some((e) => e.type === "member")).toBe(true);
        expect(pushed.filter((e) => e.type === "msg")).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

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
        const { attrs } = parseEnvelope(await h.nextContent());
        expect(attrs["from-name"]).toBe("user");
        expect(attrs["ccmsg-from"]).toBe("user");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
