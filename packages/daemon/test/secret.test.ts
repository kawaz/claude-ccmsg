// The secret handoff through the daemon (DR-0052): a value the person
// pastes in the webui is held in the daemon's memory under an id, the session
// is told the id from `ccmsg:daemon` (DR-0039 §9's notice, into a fake
// harness, peer-harness.ts), the id gives the value back as it was pasted, and
// the webui lists what is held by another key, with neither the id nor the
// value. None of it is written anywhere the daemon logs or keeps state.
//
// 何を保証するか:
//   - 知らせの文は kawaz の指定の 2 行 (1 行目そのまま、2 行目は ID 入りの取り出しコマンド)
//   - 取り出しは貼られたとおりの値 (改行・CR・空白・非 ASCII を足さず削らない) で、期限内は何回でも
//   - 知らせが届かなかった (module が無い) 値は預からない
//   - 一覧 (ev:"secrets") に ID と値が無い。破棄で消え、以後の取り出しは not_found
//   - 3 つの op は user role だけ
//   - 値の文字列が daemon.log・trace・state dir / data dir のどのファイルにも現れない
//     (形の違う secret_put の断りの文を含む)
// 期限 (5 分) で消えることは時計を差し替えた単体テスト (secret-store.test.ts) が持つ。
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SECRET_MAX_LENGTH } from "@ccmsg/protocol";
import { perTestLivePid } from "../../testkit/src/live-pid.ts";
import {
  type DaemonCtx,
  daemonLogOf,
  startTestDaemon,
  stopTestDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { fakeHarness, parseEnvelope, sessionWithConfig, type FakeHarness } from "./peer-harness.ts";

const T = 15000;
const SID = "cccccccc-3333-4333-8444-555555555555";
/** A value with what a paste can carry that a careless reader would change:
 * a trailing newline, a CR, inner and trailing spaces, non-ASCII. */
const SECRET = "test-secret-0123 \r\nline2 ключ 鍵 \n";
/** The part of every test value searched for in the files. */
const MARKER = "test-secret-0123";

const livePid = perTestLivePid();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function daemon(): Promise<DaemonCtx> {
  const ctx = await startTestDaemon();
  cleanups.push(() => stopTestDaemon(ctx));
  return ctx;
}

function harness(sid: string): FakeHarness {
  const h = fakeHarness(sid, { pid: livePid() });
  cleanups.push(() => h.dispose());
  return h;
}

/** The session `sid` with a hooks module (a named run), reachable through
 * its harness. */
async function withModule(ctx: DaemonCtx, sid: string, configDir: string): Promise<TestClient> {
  const c = await sessionWithConfig(ctx, sid, configDir);
  await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  cleanups.push(() => c.close());
  return c;
}

async function subscribedUser(ctx: DaemonCtx): Promise<TestClient> {
  const user = await userConn(ctx);
  cleanups.push(() => user.close());
  await user.requestOk({ op: "subscribe" });
  return user;
}

/** The id the notice names, read off its second line. */
function idOfNotice(body: string): string {
  const m = /^ccmsg secret take ([0-9a-f-]{36}) \| <コマンド>$/.exec(body.split("\n")[1] ?? "");
  if (m?.[1] === undefined) throw new Error(`the notice names no id: ${body}`);
  return m[1];
}

/** Every file under `dir`, read whole. */
function filesUnder(dir: string): { file: string; text: string }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { file: string; text: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out.push({ file, text: fs.readFileSync(file, "utf8") });
  }
  return out;
}

describe("secret handoff", () => {
  test(
    "the session is told the id from ccmsg:daemon, and the id gives the value back as pasted, more than once",
    async () => {
      const ctx = await daemon();
      const h = harness(SID);
      await withModule(ctx, SID, h.configDir);
      const user = await subscribedUser(ctx);

      const put = await user.requestOk({ op: "secret_put", session_id: SID, value: SECRET });
      expect(put.notice).toEqual({ sid: SID, outcome: "delivered" });
      expect(put.chars).toBe(Array.from(SECRET).length);

      const { attrs, body } = parseEnvelope(await h.nextContent());
      expect(attrs.from).toBe("ccmsg:daemon");
      const id = idOfNotice(body);
      expect(body).toBe(
        "ユーザからシークレットを受け取りました (5分有効) 。値は表示せずパイプで利用してください。\n" +
          `ccmsg secret take ${id} | <コマンド>`,
      );

      const taker = await userConn(ctx);
      cleanups.push(() => taker.close());
      expect((await taker.requestOk({ op: "secret_take", id })).value).toBe(SECRET);
      expect((await taker.requestOk({ op: "secret_take", id })).value).toBe(SECRET);
    },
    T,
  );

  test(
    "the list names each held secret by a key of its own, with neither its id nor its value, and 破棄 drops it",
    async () => {
      const ctx = await daemon();
      const h = harness(SID);
      await withModule(ctx, SID, h.configDir);
      const user = await subscribedUser(ctx);
      // The subscribe-time push, empty.
      expect((await user.readEventUntil("secrets", () => true)).ev.secrets).toEqual([]);

      const put = await user.requestOk({ op: "secret_put", session_id: SID, value: SECRET });
      const id = idOfNotice(parseEnvelope(await h.nextContent()).body);
      const { ev } = await user.readEventUntil("secrets", (e) => e.secrets.length === 1);
      const [listed] = ev.secrets;
      expect(listed).toEqual({
        key: put.key ?? "",
        session_id: SID,
        received_at: listed?.received_at ?? 0,
        expires_at: (listed?.received_at ?? 0) + 5 * 60 * 1000,
        chars: Array.from(SECRET).length,
      });
      expect(listed?.key).not.toBe(id);
      expect(JSON.stringify(ev)).not.toContain(id);
      expect(JSON.stringify(ev)).not.toContain(MARKER);

      expect(await user.requestOk({ op: "secret_discard", key: put.key ?? "" })).toEqual({
        ok: true,
      });
      expect((await user.readEventUntil("secrets", (e) => e.secrets.length === 0)).ev).toEqual({
        ev: "secrets",
        secrets: [],
      });
      expect((await user.requestError({ op: "secret_take", id })).error.code).toBe("not_found");
      expect(
        (await user.requestError({ op: "secret_discard", key: put.key ?? "" })).error.code,
      ).toBe("not_found");
    },
    T,
  );

  test(
    "two secrets of one session are held apart, each under its own id",
    async () => {
      const ctx = await daemon();
      const h = harness(SID);
      await withModule(ctx, SID, h.configDir);
      const user = await subscribedUser(ctx);
      await user.requestOk({ op: "secret_put", session_id: SID, value: `${MARKER}-a` });
      const a = idOfNotice(parseEnvelope(await h.nextContent()).body);
      await user.requestOk({ op: "secret_put", session_id: SID, value: `${MARKER}-b` });
      const b = idOfNotice(parseEnvelope(await h.nextContent()).body);
      expect(a).not.toBe(b);
      expect((await user.requestOk({ op: "secret_take", id: a })).value).toBe(`${MARKER}-a`);
      expect((await user.requestOk({ op: "secret_take", id: b })).value).toBe(`${MARKER}-b`);
    },
    T,
  );

  // DR-0052 §5: no one knows the id of a secret whose notice did not arrive.
  test(
    "a value whose notice did not arrive (no hooks module) is not held",
    async () => {
      const ctx = await daemon();
      const h = harness(SID);
      const unnamed = await sessionWithConfig(ctx, SID, h.configDir);
      cleanups.push(() => unnamed.close());
      const user = await subscribedUser(ctx);

      const put = await user.requestOk({ op: "secret_put", session_id: SID, value: SECRET });
      expect(put).toEqual({
        ok: true,
        notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
        chars: Array.from(SECRET).length,
      });
      expect(h.frames).toEqual([]);
      // Ordered past the put: the list it left is empty.
      await user.requestOk({ op: "ping" });
      const pushed = await user.pendingEvents();
      const lists = pushed.flatMap((item) =>
        "ev" in item && item.ev === "secrets" ? [item.secrets] : [],
      );
      expect(lists.at(-1)).toEqual([]);
    },
    T,
  );

  test(
    "an id nothing is held under is not_found",
    async () => {
      const ctx = await daemon();
      const user = await userConn(ctx);
      cleanups.push(() => user.close());
      expect(
        (await user.requestError({ op: "secret_take", id: "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }))
          .error.code,
      ).toBe("not_found");
    },
    T,
  );

  test(
    "a session-role connection may not hand, take or discard a secret",
    async () => {
      const ctx = await daemon();
      const s = await sessionWithConfig(ctx, SID);
      cleanups.push(() => s.close());
      for (const body of [
        { op: "secret_put", session_id: SID, value: SECRET },
        { op: "secret_take", id: "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" },
        { op: "secret_discard", key: "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" },
      ] as const) {
        expect((await s.requestError(body)).error.code).toBe("bad_request");
      }
    },
    T,
  );

  // DR-0052 §8: the value is in no file the daemon writes, whichever way it
  // came in, and a refusal does not quote it.
  test(
    "the value is in no file of the daemon's state and data dirs, nor in a refusal",
    async () => {
      const ctx = await daemon();
      const h = harness(SID);
      await withModule(ctx, SID, h.configDir);
      const user = await subscribedUser(ctx);

      const put = await user.requestOk({ op: "secret_put", session_id: SID, value: SECRET });
      const id = idOfNotice(parseEnvelope(await h.nextContent()).body);
      await user.requestOk({ op: "secret_take", id });
      await user.requestOk({ op: "secret_discard", key: put.key ?? "" });

      // Refused for the value itself: too long, and of another type.
      const tooLong = MARKER.repeat(Math.ceil((SECRET_MAX_LENGTH + 1) / MARKER.length));
      const refusals = [
        await user.requestRefusal({ op: "secret_put", session_id: SID, value: tooLong }),
        await user.requestRefusal({ op: "secret_put", session_id: SID, value: [MARKER] }),
        await user.requestRefusal({ op: "secret_put", session_id: SID, value: { v: MARKER } }),
      ];
      for (const refusal of refusals) {
        expect(refusal.error.code).toBe("invalid_args");
        expect(refusal.error.msg).not.toContain(MARKER);
      }
      // A refusal is logged as it is answered; the ping orders the log past it.
      await user.requestOk({ op: "ping" });

      expect(daemonLogOf(ctx)).toContain("secret_put: session_id=");
      expect(daemonLogOf(ctx)).toContain("refused");
      const leaks = [...filesUnder(ctx.stateDir), ...filesUnder(ctx.dataDir)]
        .filter(({ text }) => text.includes(MARKER) || text.includes("line2 ключ"))
        .map(({ file }) => file);
      expect(leaks).toEqual([]);
    },
    T,
  );
});
