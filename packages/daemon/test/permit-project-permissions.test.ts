// 許可依頼の project_permissions (DR-0040 §12) の wire の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - permit_request は project_permissions を、依頼したセッションのプロジェクト
//     ディレクトリの .claude/settings.local.json と組にして記録する
//   - permit_permission_apply は記録にある変更だけを、記録が名指すファイルに
//     だけ書く。記録に無い rule / add と remove の取り違えは断り、何も書かない
//   - project_permissions だけの依頼も記録する。* を含む rule もそのまま書く
//   - 適用した変更には applied_at が付き、記録は既読になって全タブに届く
//   - permit_settings_read は記録が名指すファイルを今の中身で読む (無ければ missing)
//   - 読めない設定は settings_unreadable で断り、書かない
//   - role gate: apply と settings_read は user 限定
//
// 書き込みそのものの形 (ソート・インデント・他キー保持) は
// project-permissions.test.ts。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PermitRequestRecord } from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";

const SID_A = "9e700000-0000-4000-8000-0000000000a1";

const tmpDir = perTestTmpDir();

/** A subscribed user connection. */
async function subscribedUser(ctx: InProcessDaemon): Promise<TestClient> {
  const u = await userConn(ctx);
  await u.request({ op: "subscribe" });
  await u.readEventUntil("permit_requests");
  return u;
}

/** A session working in a fresh project directory (its realpath, as the
 * daemon registers it), which asked for `project_permissions`; the record
 * as the user tab got it. */
async function asked(
  ctx: InProcessDaemon,
  u: TestClient,
  project_permissions: readonly ({ add: string } | { remove: string })[],
): Promise<{ s: TestClient; dir: string; record: PermitRequestRecord }> {
  const dir = fs.realpathSync(tmpDir("perm-wire-"));
  const s = await sessionConn(ctx, SID_A, { cwd: dir });
  await s.requestOk({
    op: "permit_request",
    permit: {
      blocked: "`just deploy` が止められた",
      commands: [{ command: "just deploy" }],
      project_permissions,
    },
  });
  const { ev } = await u.readEventUntil("permit_request");
  return { s, dir, record: ev.request };
}

describe("permit project_permissions over the wire", () => {
  // 何を保証するか: 記録は project_permissions を書かれた順のまま (未適用) と、
  // 依頼したセッションのプロジェクトの settings.local.json のパスを持つ。
  // project_permissions の無い依頼には project_settings が無い。
  test("records the project permissions with the asking session's settings file", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, dir, record } = await asked(ctx, u, [
        { add: "Bash(just deploy)" },
        { remove: "Bash(just old)" },
      ]);
      expect(record.project_settings).toEqual({
        path: path.join(dir, ".claude", "settings.local.json"),
        permissions: [{ add: "Bash(just deploy)" }, { remove: "Bash(just old)" }],
      });
      await s.requestOk({
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls" }] },
      });
      const { ev } = await u.readEventUntil("permit_request");
      expect("project_settings" in ev.request).toBe(false);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: project_permissions だけの依頼も記録され、* を含む rule も
  // そのまま書かれる (判断は人がバブルで見てする)。
  test("records a request of project permissions alone, and writes a rule with a * as is", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const dir = fs.realpathSync(tmpDir("perm-wire-"));
      const s = await sessionConn(ctx, SID_A, { cwd: dir });
      const rule = "Bash(find . -name \\*.json)";
      const answered = await s.requestOk({
        op: "permit_request",
        permit: { blocked: "毎回止められる", project_permissions: [{ add: rule }] },
      });
      const { ev } = await u.readEventUntil("permit_request");
      expect([ev.request.intents, ev.request.commands]).toEqual([[], []]);
      await u.requestOk({
        op: "permit_permission_apply",
        id: answered.id,
        permission: { add: rule },
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")),
      ).toEqual({ permissions: { allow: [rule] } });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 記録にある変更を適用すると、そのファイルに書かれ、応答は
  // changed と適用時刻、記録はその変更に applied_at が付き既読になって全タブに
  // 届く。
  // settings_read は書いた後の中身を返す (書く前は missing)。
  test("applies a permission the request asked for, and marks it applied", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, dir, record } = await asked(ctx, u, [{ add: "Bash(just deploy)" }]);
      const file = path.join(dir, ".claude", "settings.local.json");
      expect(await u.requestOk({ op: "permit_settings_read", id: record.id })).toEqual({
        ok: true,
        attachment: { path: file, read: false, reason: "missing" },
      });
      const applied = await u.requestOk({
        op: "permit_permission_apply",
        id: record.id,
        permission: { add: "Bash(just deploy)" },
      });
      expect(applied).toEqual({ ok: true, changed: true, applied_at: applied.applied_at });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: ["Bash(just deploy)"] },
      });
      const { ev } = await u.readEventUntil("permit_request");
      expect(ev.request.project_settings?.permissions).toEqual([
        { add: "Bash(just deploy)", applied_at: applied.applied_at },
      ]);
      // Applying is acting on the request, as 許可する is: it is read now.
      expect(ev.request.read).toBe(true);
      const read = await u.requestOk({ op: "permit_settings_read", id: record.id });
      expect(read.attachment).toMatchObject({ read: true, content: fs.readFileSync(file, "utf8") });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 記録に無い rule、記録の add を remove として (その逆も)、
  // 持っていない id の適用は invalid_args で断り、ファイルを作らない。
  // 任意の文字列を書く口にならない。
  test("refuses a permission the request did not ask for, and writes nothing", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, dir, record } = await asked(ctx, u, [
        { add: "Bash(just deploy)" },
        { remove: "Bash(just old)" },
      ]);
      for (const [id, permission] of [
        [record.id, { add: "Bash(rm -rf /)" }],
        [record.id, { remove: "Bash(just deploy)" }],
        [record.id, { add: "Bash(just old)" }],
        ["0000/999", { add: "Bash(just deploy)" }],
      ] as const) {
        expect(await u.request({ op: "permit_permission_apply", id, permission })).toMatchObject({
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
  // ファイルを書き換えず、記録に applied_at を付けない。
  test("refuses to apply over settings that do not read, leaving them", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, dir, record } = await asked(ctx, u, [{ add: "Bash(just deploy)" }]);
      const file = path.join(dir, ".claude", "settings.local.json");
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "{ broken");
      expect(
        await u.request({
          op: "permit_permission_apply",
          id: record.id,
          permission: { add: "Bash(just deploy)" },
        }),
      ).toMatchObject({ ok: false, error: { code: "settings_unreadable" } });
      expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
      expect(ctx.daemon.permitRequests.find(record.id)?.project_settings?.permissions).toEqual([
        { add: "Bash(just deploy)" },
      ]);
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
      const u = await subscribedUser(ctx);
      const { s, dir, record } = await asked(ctx, u, [{ add: "Bash(just deploy)" }]);
      expect(
        await s.request({
          op: "permit_permission_apply",
          id: record.id,
          permission: { add: "Bash(just deploy)" },
        }),
      ).toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(await s.request({ op: "permit_settings_read", id: record.id })).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
      const plain = await s.requestOk({
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls" }] },
      });
      expect(await u.request({ op: "permit_settings_read", id: plain.id })).toMatchObject({
        ok: false,
        error: { code: "invalid_args" },
      });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
