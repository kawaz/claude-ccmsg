// A direct message reaches a Claude Code session through its peer messaging
// socket (DR-0036 §1). A fake harness (peer-harness.ts) stands in for the
// session: `sessions/<pid>.json` and the `<pid>.<hex>.key` beside it in a temp
// config dir, and a UDS bound under /tmp that records the frames it is sent.
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  PeerInjector,
  writeSocket,
  type InjectFrame,
  type InjectResult,
} from "../src/peer-inject.ts";
import { defined } from "./helpers.ts";
import { PEER_TOKEN, fakeHarness as spawnHarness, type FakeHarness } from "./peer-harness.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";

const SID = "11111111-2222-4333-8444-555555555555";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function fakeHarness(
  opts: { peerProtocol?: number; sid?: string; stall?: boolean; readAfterMs?: number } = {},
): FakeHarness {
  const h = spawnHarness(opts.sid ?? SID, opts);
  cleanups.push(() => h.dispose());
  return h;
}

const MESSAGE: InjectFrame = {
  mid: "d7",
  content: '<cross-session-message from="ccmsg">\nhello\n</cross-session-message>',
};

describe("PeerInjector", () => {
  test("writes auth then user with the envelope, and silence is delivery", async () => {
    const h = fakeHarness();
    const injector = new PeerInjector();
    cleanups.push(() => injector.close());
    expect(await injector.deliver(h.configDir, SID, MESSAGE)).toEqual({ outcome: "delivered" });
    expect(h.frames[0]).toEqual({ type: "auth", token: PEER_TOKEN });
    const user = defined(h.frames[1], "user");
    expect(user.type).toBe("user");
    expect(user.session_id).toBe(SID);
    expect(user.msg_id).toBe("d7");
    expect(user.from).toMatch(
      new RegExp(`^uds:${path.dirname(h.socketPath)}/\\d+-[0-9a-f]{8}\\.sock$`),
    );
    expect(user.message).toEqual({ content: MESSAGE.content });
  });

  test("a peer_message_status on the from socket is a refusal", async () => {
    const h = fakeHarness();
    h.refuseWith = "held";
    const injector = new PeerInjector({ statusMs: 2000 });
    cleanups.push(() => injector.close());
    expect(await injector.deliver(h.configDir, SID, MESSAGE)).toEqual({ outcome: "refused" });
  });

  test("unavailable: unknown sid, other peerProtocol, no socket, no config dir", async () => {
    const injector = new PeerInjector();
    cleanups.push(() => injector.close());
    const noPeer: InjectResult = { outcome: "unavailable", cause: "no_peer_socket" };
    const other = fakeHarness({ sid: "someone-else" });
    expect(await injector.deliver(other.configDir, SID, MESSAGE)).toEqual(noPeer);
    const v2 = fakeHarness({ peerProtocol: 2 });
    expect(await injector.deliver(v2.configDir, SID, MESSAGE)).toEqual(noPeer);
    const gone = fakeHarness();
    gone.stop();
    expect(await injector.deliver(gone.configDir, SID, MESSAGE)).toEqual({
      outcome: "unavailable",
      cause: "unreachable",
    });
    expect(await injector.deliver("/nonexistent-pi-config", SID, MESSAGE)).toEqual(noPeer);
  });

  // The write takes longer than the refusal window: the recipient starts
  // reading after 600 ms and refuses the moment it has the frame. The window
  // starts when the write has finished, so the refusal is still heard.
  test("a refusal right after a write longer than the refusal window is refused", async () => {
    const h = fakeHarness({ readAfterMs: 600 });
    await h.listening;
    h.refuseWith = "held";
    const injector = new PeerInjector();
    cleanups.push(() => injector.close());
    const big = { ...MESSAGE, content: "x".repeat(4 * 1024 * 1024) };
    expect(await injector.deliver(h.configDir, SID, big)).toEqual({ outcome: "refused" });
  });

  // A socket that stopped reading takes part of a large message: it may hold
  // all of it in the end, so the message is neither delivered nor not.
  test("a write that started and did not finish in time is unconfirmed", async () => {
    const h = fakeHarness({ stall: true });
    await h.listening;
    const injector = new PeerInjector({ writeMs: 300 });
    cleanups.push(() => injector.close());
    const big = { ...MESSAGE, content: "x".repeat(4 * 1024 * 1024) };
    expect(await injector.deliver(h.configDir, SID, big)).toEqual({ outcome: "unconfirmed" });
  });
});

describe("writeSocket", () => {
  test("written, not_written, and uncertain by how far the payload got", async () => {
    const h = fakeHarness();
    expect(await writeSocket(h.socketPath, "{}\n", 1_000)).toBe("written");

    const dir = shortTmpDir("pi-w-");
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(await writeSocket(path.join(dir, "none.sock"), "{}\n", 1_000)).toBe("not_written");

    const stalled = fakeHarness({ stall: true });
    await stalled.listening;
    expect(await writeSocket(stalled.socketPath, "x".repeat(4 * 1024 * 1024), 300)).toBe(
      "uncertain",
    );
  });
});
