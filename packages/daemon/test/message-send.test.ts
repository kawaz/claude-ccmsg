// message_send (DR-0036 §1): a session sends to another session's peer
// messaging socket, and is told whether it arrived. A fake
// harness (peer-harness.ts) stands in for the recipient.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type RequestInput } from "@ccmsg/protocol";
import { parseDirectDeliveries } from "@ccmsg/protocol";
import { createMidIssuer } from "../src/direct-send.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";
import {
  LAUNCHER,
  fakeHarness as spawnHarness,
  parseEnvelope,
  sessionWithConfig,
  type FakeHarness,
} from "./peer-harness.ts";

type MessageSendInput = Extract<RequestInput, { op: "message_send" }>;

const T = 15000;
const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";
const NOBODY = "cccccccc-2222-4333-8444-555555555555";
const MID_RE = /^[0-9a-f]{32}\/\d+$/;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function harness(sid: string, opts: { stall?: boolean } = {}): FakeHarness {
  const h = spawnHarness(sid, opts);
  cleanups.push(() => h.dispose());
  return h;
}

async function daemon(): Promise<DaemonCtx> {
  const ctx = await startTestDaemon();
  cleanups.push(() => stopTestDaemon(ctx));
  return ctx;
}

describe("createMidIssuer", () => {
  test("counts from 1 under one instance id; each issuer draws its own id", () => {
    const issue = createMidIssuer();
    const first = issue();
    const second = issue();
    expect(first).toMatch(MID_RE);
    expect(first.endsWith("/1")).toBe(true);
    expect(second).toBe(`${first.slice(0, 32)}/2`);
    expect(createMidIssuer()().slice(0, 32)).not.toBe(first.slice(0, 32));
  });
});

describe("message_send", () => {
  test(
    "delivers the v2-shaped envelope, and the reply line's command reaches the sender",
    async () => {
      const ctx = await daemon();
      const ha = harness(A);
      const hb = harness(B);
      const a = await sessionWithConfig(ctx, A, ha.configDir);
      const b = await sessionWithConfig(ctx, B, hb.configDir);

      const sent = await a.requestOk({ op: "message_send", to: B, text: "question\nline 2" });
      expect(sent.outcome).toBe("delivered");
      if (sent.outcome !== "delivered") throw new Error("not delivered");
      const { mid: sentMid, ...sentRest } = sent;
      expect(sentRest).toEqual({ ok: true, outcome: "delivered" });
      expect(sentMid).toMatch(MID_RE);
      const content = await hb.nextContent();
      const { attrs, body } = parseEnvelope(content);
      expect(attrs).toEqual({
        from: `ccmsg:${A}`,
        "from-name": `ccmsg:${A}`,
        "from-mode": "prompting",
        "ccmsg-mid": sent.mid,
        "ccmsg-from": A,
      });
      expect(body).toBe(
        `question\nline 2\n\nReply with: ${LAUNCHER} reply ${sent.mid} --to ${A} <text>`,
      );
      // What the webui and dump read out of the recipient's transcript.
      expect(parseDirectDeliveries(content)).toEqual([
        { mid: sent.mid, from: A, fromLabel: `ccmsg:${A}`, text: "question\nline 2" },
      ]);

      // The reply line is `reply <mid> --to <A>`: the CLI turns it into this.
      const replied = await b.requestOk({
        op: "message_send",
        to: A,
        text: "answer",
        reply_to: sent.mid,
      });
      if (replied.outcome !== "delivered") throw new Error("not delivered");
      expect(replied.mid).toBe(`${sent.mid.slice(0, 32)}/${Number(sent.mid.split("/")[1]) + 1}`);
      const back = parseEnvelope(await ha.nextContent());
      expect(back.attrs["ccmsg-reply-to"]).toBe(sent.mid);
      expect(back.attrs["ccmsg-from"]).toBe(B);
      expect(back.body).toBe(
        `answer\n\nReply with: ${LAUNCHER} reply ${replied.mid} --to ${B} <text>`,
      );
    },
    T,
  );

  test(
    "not delivered: each reason is answered, and nothing is written for a session it cannot reach",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, A);
      const send = (to: string) => a.request({ op: "message_send", to, text: "hi" });

      expect(await send(NOBODY)).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "session_not_found",
      });

      await sessionWithConfig(ctx, B);
      expect(await send(B)).toMatchObject({ outcome: "not_delivered", reason: "no_config_dir" });

      // A config dir whose sessions/ has no state file for this sid.
      const elsewhere = harness(NOBODY);
      const c = "dddddddd-2222-4333-8444-555555555555";
      await sessionWithConfig(ctx, c, elsewhere.configDir);
      expect(await send(c)).toMatchObject({ outcome: "not_delivered", reason: "no_peer_socket" });
      expect(elsewhere.frames).toEqual([]);

      const gone = harness("eeeeeeee-2222-4333-8444-555555555555");
      gone.stop();
      await sessionWithConfig(ctx, "eeeeeeee-2222-4333-8444-555555555555", gone.configDir);
      expect(await send("eeeeeeee-2222-4333-8444-555555555555")).toMatchObject({
        outcome: "not_delivered",
        reason: "unreachable",
      });
    },
    T,
  );

  // The recipient's socket stopped reading: the write goes in part-way and
  // runs out of time. It may yet arrive whole, so it is not called not
  // delivered — a resend could deliver it twice.
  test(
    "a write that started and did not finish in time is unconfirmed, with the mid it carries",
    async () => {
      const ctx = await daemon();
      const hb = harness(B, { stall: true });
      await hb.listening;
      const a = await sessionWithConfig(ctx, A);
      await sessionWithConfig(ctx, B, hb.configDir);
      const res = await a.requestOk({
        op: "message_send",
        to: B,
        text: "x".repeat(4 * 1024 * 1024),
      });
      expect(res.outcome).toBe("unconfirmed");
      if (res.outcome !== "unconfirmed") throw new Error("not unconfirmed");
      const { mid, ...rest } = res;
      expect(rest).toEqual({ ok: true, outcome: "unconfirmed" });
      expect(mid).toMatch(MID_RE);
    },
    T,
  );

  test(
    "a refusal from the recipient's harness is answered as refused",
    async () => {
      const ctx = await daemon();
      const hb = harness(B);
      hb.refuseWith = "denied";
      const a = await sessionWithConfig(ctx, A);
      await sessionWithConfig(ctx, B, hb.configDir);
      expect(await a.request({ op: "message_send", to: B, text: "hi" })).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "refused",
      });
    },
    T,
  );

  test(
    "invalid_args: a person, a non-sid recipient, the sender itself, empty text, a room mid as reply_to",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, A);
      await sessionWithConfig(ctx, B);
      const u = await connect(ctx.sock);
      await u.hello({ role: "user" });
      const code = async (client: typeof a, req: MessageSendInput) =>
        (await client.requestError(req)).error.code;

      expect(await code(u, { op: "message_send", to: B, text: "hi" })).toBe("invalid_args");
      expect(await code(a, { op: "message_send", to: "user", text: "hi" })).toBe("invalid_args");
      expect(await code(a, { op: "message_send", to: `ccmsg:${B}`, text: "hi" })).toBe(
        "invalid_args",
      );
      expect(await code(a, { op: "message_send", to: A, text: "hi" })).toBe("invalid_args");
      expect(await code(a, { op: "message_send", to: B, text: "" })).toBe("invalid_args");
      expect(await code(a, { op: "message_send", to: B, text: "hi", reply_to: "r7m3" })).toBe(
        "invalid_args",
      );
    },
    T,
  );

  test(
    "nothing is written when the refusal socket cannot be opened: not delivered, no_status_socket",
    async () => {
      const ctx = await daemon();
      const hb = harness(B);
      const a = await sessionWithConfig(ctx, A);
      await sessionWithConfig(ctx, B, hb.configDir);
      // The refusal socket is bound beside the recipient's own; a directory
      // that takes no new entry leaves the recipient's socket reachable but
      // gives the sender nowhere to hear a refusal on.
      const socketDir = path.dirname(hb.socketPath);
      fs.chmodSync(socketDir, 0o500);
      cleanups.push(() => fs.chmodSync(socketDir, 0o700));
      expect(await a.request({ op: "message_send", to: B, text: "hi" })).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "no_status_socket",
      });
      expect(hb.frames).toEqual([]);
    },
    T,
  );

  test(
    "a session hello whose sid is not a session id is refused",
    async () => {
      const ctx = await daemon();
      for (const sid of ["x; printf PWNED >&2; #", "A", `${A} `, A.toUpperCase(), `ccmsg:${A}`]) {
        const c = await connect(ctx.sock);
        cleanups.push(() => c.close());
        const res = await c.requestError({
          op: "hello",
          protocol: PROTOCOL_VERSION,
          role: "session",
          sid,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        expect({ sid, code: res.error?.code }).toEqual({ sid, code: "invalid_args" });
        const after = await c.requestError({
          op: "message_send",
          to: B,
          text: "hi",
        });
        expect(after.error?.code).toBe("hello_required");
      }
      const peers = await (
        await sessionWithConfig(ctx, A)
      ).requestOk({
        op: "peers",
      });
      expect(peers.peers.map((p) => p.sid)).toEqual([A]);
    },
    T,
  );

  test(
    "requires hello",
    async () => {
      const ctx = await daemon();
      const raw = await connect(ctx.sock);
      const res = await raw.requestError({
        op: "message_send",
        to: B,
        text: "hi",
      });
      expect(res.error?.code).toBe("hello_required");
    },
    T,
  );
});
