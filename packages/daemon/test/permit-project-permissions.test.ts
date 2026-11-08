// 許可依頼の project_permissions (DR-0040 §12) の wire の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - 設定ファイルは依頼の permit の行の cwd の .claude/settings.local.json
//   - permit_permission_apply は依頼の行にある変更だけを、そのファイルにだけ
//     書く。行に無い rule / add と remove の取り違え / 依頼でない呼び出しは
//     断り、何も書かない
//   - project_permissions だけの依頼にも適用できる。* を含む rule もそのまま書く
//   - 適用は ev:"permit_state" の applied に載り、依頼は既読になって全タブに
//     届く。適用はファイルに書いてから答える
//   - permit_settings_read はそのファイルを今の中身で読む (無ければ missing)
//   - 読めない設定は settings_unreadable で断り、書かない
//   - role gate: apply と settings_read は user 限定
//
// 書き込みそのものの形 (ソート・インデント・他キー保持) は
// project-permissions.test.ts。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject } from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { PERMIT_REFUSED_TEXT, permitLines, permitSessionTree } from "./permit-rows.ts";

const SID_A = "9e700000-0000-4000-8000-0000000000a1";
const ID = "toolu_perm";

const tmpDir = perTestTmpDir();

/** A subscribed user connection. */
async function subscribedUser(ctx: InProcessDaemon): Promise<TestClient> {
  const u = await userConn(ctx);
  await u.request({ op: "subscribe" });
  await u.readEventUntil("permit_state");
  return u;
}

/** A session whose transcript holds a request (`permit` call ID, answered as
 * requested) made in a fresh project directory `dir`, asking for
 * `project_permissions`. `more` is put after it in the transcript. */
async function asked(
  ctx: InProcessDaemon,
  project_permissions: readonly ({ add: string } | { remove: string })[],
  more = "",
): Promise<{ s: TestClient; dir: string; file: string }> {
  const dir = fs.realpathSync(tmpDir("perm-wire-"));
  const input: JsonObject = {
    blocked: "`just deploy` が止められた",
    commands: [{ command: "just deploy" }],
    project_permissions: project_permissions.map((p): JsonObject => ({ ...p })),
  };
  const transcript = permitSessionTree(
    tmpDir("perm-tx-"),
    SID_A,
    permitLines(ID, input, { cwd: dir, timestamp: new Date().toISOString() }) + more,
  );
  const s = await sessionConn(ctx, SID_A, { cwd: dir, transcript_path: transcript });
  return { s, dir, file: path.join(dir, ".claude", "settings.local.json") };
}

const apply = (permission: { add: string } | { remove: string }, tool_use_id = ID) => ({
  op: "permit_permission_apply" as const,
  sid: SID_A,
  tool_use_id,
  permission,
});

describe("permit project_permissions over the wire", () => {
  // 何を保証するか: 依頼の行にある変更を適用すると、その行の cwd の設定ファイルに
  // 書かれ、応答は changed と適用時刻。適用は ev:"permit_state" の applied に
  // 載り、依頼は既読になる (許可する と同じ印)。ファイルに書いてから答える。
  // settings_read は書いた後の中身を返す (書く前は missing)。
  test("applies a permission the request asked for, into the call's directory, and marks it applied", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, file } = await asked(ctx, [{ add: "Bash(just deploy)" }]);
      expect(
        await u.requestOk({ op: "permit_settings_read", sid: SID_A, tool_use_id: ID }),
      ).toEqual({ ok: true, attachment: { path: file, read: false, reason: "missing" } });
      const { ev: before } = await u.readEventUntil("permit_state", (e) => e.unread.length === 1);
      expect(before.unread.map((p) => p.tool_use_id)).toEqual([ID]);

      const applied = await u.requestOk(apply({ add: "Bash(just deploy)" }));
      expect(applied).toEqual({ ok: true, changed: true, applied_at: applied.applied_at });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: ["Bash(just deploy)"] },
      });
      const { ev } = await u.readEventUntil("permit_state", (e) => e.applied.length === 1);
      expect(ev).toEqual({
        ev: "permit_state",
        unread: [],
        applied: [
          {
            tool_use_id: ID,
            permission: { add: "Bash(just deploy)" },
            applied_at: applied.applied_at,
          },
        ],
      });
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain(applied.applied_at);
      const read = await u.requestOk({ op: "permit_settings_read", sid: SID_A, tool_use_id: ID });
      expect(read.attachment).toMatchObject({ read: true, content: fs.readFileSync(file, "utf8") });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: project_permissions だけの依頼にも適用でき、* を含む rule も
  // そのまま書かれる (判断は人がバブルで見てする)。
  test("applies a request of project permissions alone, and writes a rule with a * as is", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const dir = fs.realpathSync(tmpDir("perm-wire-"));
      const rule = "Bash(find . -name \\*.json)";
      const transcript = permitSessionTree(
        tmpDir("perm-tx-"),
        SID_A,
        permitLines(
          ID,
          { blocked: "毎回止められる", project_permissions: [{ add: rule }] },
          { cwd: dir },
        ),
      );
      const s = await sessionConn(ctx, SID_A, { cwd: dir, transcript_path: transcript });
      await u.requestOk(apply({ add: rule }));
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")),
      ).toEqual({ permissions: { allow: [rule] } });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 行に無い rule、行の add を remove として (その逆も)、依頼で
  // ない呼び出し (断られた呼び出し)、知らない id の適用は invalid_args で断り、
  // ファイルを作らない。任意の文字列を書く口にならない。
  test("refuses a permission the request did not ask for, and writes nothing", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const refused = permitLines(
        "toolu_refused",
        { blocked: "x", project_permissions: [{ add: "Bash(just deploy)" }] },
        { result: PERMIT_REFUSED_TEXT },
      );
      const { s, dir } = await asked(
        ctx,
        [{ add: "Bash(just deploy)" }, { remove: "Bash(just old)" }],
        refused,
      );
      for (const [id, permission] of [
        [ID, { add: "Bash(rm -rf /)" }],
        [ID, { remove: "Bash(just deploy)" }],
        [ID, { add: "Bash(just old)" }],
        ["toolu_refused", { add: "Bash(just deploy)" }],
        ["toolu_x", { add: "Bash(just deploy)" }],
      ] as const) {
        expect(await u.request(apply(permission, id))).toMatchObject({
          ok: false,
          error: { code: "invalid_args" },
        });
      }
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 読めない設定ファイルへの適用は settings_unreadable で断り、
  // ファイルを書き換えず、適用済みにしない。
  test("refuses to apply over settings that do not read, leaving them", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const { s, file } = await asked(ctx, [{ add: "Bash(just deploy)" }]);
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "{ broken");
      expect(await u.request(apply({ add: "Bash(just deploy)" }))).toMatchObject({
        ok: false,
        error: { code: "settings_unreadable" },
      });
      expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
      expect(ctx.daemon.permits.applied).toEqual([]);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: apply と settings_read は user role 限定 (依頼したセッション
  // 自身も自分の許可を書けない)。project_permissions の無い依頼の settings_read
  // は断る。
  test("apply and settings_read are the person's, and need project permissions", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const plain = permitLines("toolu_plain", { blocked: "x", commands: [{ command: "ls" }] });
      const { s, dir } = await asked(ctx, [{ add: "Bash(just deploy)" }], plain);
      expect(await s.request(apply({ add: "Bash(just deploy)" }))).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
      expect(
        await s.request({ op: "permit_settings_read", sid: SID_A, tool_use_id: ID }),
      ).toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
      expect(
        await u.request({ op: "permit_settings_read", sid: SID_A, tool_use_id: "toolu_plain" }),
      ).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
