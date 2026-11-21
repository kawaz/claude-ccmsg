// 許可依頼の project_permissions (DR-0040 §12) の wire の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - 設定ファイルは依頼の permit の行の cwd の .claude/settings.local.json
//   - permit_permission_apply は依頼の行にある変更だけを、そのファイルにだけ
//     書く。行に無い rule / add と remove の取り違え / 依頼でない呼び出しは
//     断り、何も書かない
//   - project_permissions だけの依頼にも適用できる。* を含む rule もそのまま書く
//   - 適用は ev:"permit_state" の applied に載って全タブに届く。適用だけでは
//     依頼は既読にならない (操作の項目が全部済んだ時に外れる、DR-0040 §4)。
//     適用はファイルに書いてから答える
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
  isKind,
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { fixPermitRuleSets } from "../src/permit-state.ts";
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

/** permit_permission_apply of the item at `index`: its 適用 (`change:
 * "add"`, the default) or its 削除 (`"remove"`). */
const apply = (index: number, tool_use_id = ID, change: "add" | "remove" = "add") => ({
  op: "permit_permission_apply" as const,
  sid: SID_A,
  tool_use_id,
  index,
  change,
});

describe("permit project_permissions over the wire", () => {
  // 何を保証するか: 依頼の行にある項目を位置で適用すると、その行の cwd の設定
  // ファイルに書かれ、応答は changed と適用時刻。適用は ev:"permit_state" の
  // marks に run で載る。依頼にはまだ実行していないコマンドがあるので、未読の
  // まま (適用 1 件では既読にしない、DR-0040 §4)。ファイルに書いてから答える。
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

      const applied = await u.requestOk(apply(0));
      expect(applied).toEqual({ ok: true, changed: true, applied_at: applied.applied_at });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: ["Bash(just deploy)"] },
      });
      const { ev } = await u.readEventUntil("permit_state", (e) => e.marks.length === 1);
      expect(ev).toEqual({
        ev: "permit_state",
        unread: before.unread,
        granted: [],
        marks: [
          {
            tool_use_id: ID,
            kind: "project_permissions",
            index: 0,
            mark: "run",
            at: applied.applied_at,
          },
        ],
        rules: [{ tool_use_id: ID, index: 0, rules: ["Bash(just deploy)"] }],
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
      await u.requestOk(apply(0));
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")),
      ).toEqual({ permissions: { allow: [rule] } });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 依頼の行に無い位置、依頼でない呼び出し (断られた呼び出し)、
  // 知らない id の適用は invalid_args で断り、ファイルを作らない。書くのは行に
  // ある rule だけで、任意の文字列を書く口にならない。
  test("refuses an item the request does not have, and writes nothing", async () => {
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
      for (const [id, index] of [
        [ID, 2],
        ["toolu_refused", 0],
        ["toolu_x", 0],
      ] as const) {
        expect(await u.request(apply(index, id))).toMatchObject({
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

  // 何を保証するか: エージェントが書いたファイルの rule は、daemon が当たる形に
  // 直した組を書く (DR-0040 §12): Write は Edit に、/ 1 つは // に、symlink を
  // 通る path には実体の綴りの // の rule を添えて、項目ごとに 1 回で書く。
  // remove は書かれたまま (当たらない古い rule も消せる)。直した組は
  // ev:"permit_state" の rules に載る。
  test("writes the rules fixed for each item: a form that matches, and the real path's beside", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const work = fs.realpathSync(tmpDir("perm-links-"));
      fs.mkdirSync(path.join(work, "real"));
      fs.symlinkSync("real", path.join(work, "link"));
      const { s, dir, file } = await asked(ctx, [
        { add: "Write(//w/a.toml)" },
        { add: "Edit(/w/b.toml)" },
        { add: `Edit(/${work}/link/c.toml)` },
        { remove: "Write(/w/c)" },
      ]);
      fs.mkdirSync(path.join(dir, ".claude"));
      fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Write(/w/c)"] } }));
      for (const index of [0, 1, 2]) {
        expect(await u.request(apply(index))).toMatchObject({ ok: true, changed: true });
      }
      expect(await u.request(apply(3, ID, "remove"))).toMatchObject({ ok: true, changed: true });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: {
          allow: [
            `Edit(/${work}/link/c.toml)`,
            `Edit(/${work}/real/c.toml)`,
            "Edit(//w/a.toml)",
            "Edit(//w/b.toml)",
          ].toSorted(),
        },
      });
      const { ev } = await u.readEventUntil("permit_state", (e) => e.rules.length === 4);
      expect(ev.rules.map((set) => [set.index, set.rules])).toEqual([
        [0, ["Edit(//w/a.toml)"]],
        [1, ["Edit(//w/b.toml)"]],
        [2, [`Edit(/${work}/link/c.toml)`, `Edit(/${work}/real/c.toml)`]],
        [3, ["Write(/w/c)"]],
      ]);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: rule の組は daemon が依頼を見つけた時に固めて
  // permit-state.json に持つ。後で symlink が張り替わっても、書く組は変わらない。
  test("keeps the rules fixed when a symlink changes after", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const work = fs.realpathSync(tmpDir("perm-relink-"));
      fs.mkdirSync(path.join(work, "real"));
      fs.mkdirSync(path.join(work, "other"));
      fs.symlinkSync("real", path.join(work, "link"));
      const { s, file } = await asked(ctx, [{ add: `Edit(/${work}/link/c.toml)` }]);
      await u.requestOk({ op: "notification_list", sid: SID_A });
      // Whether the list's own fixing or this one lands first, the rules are
      // fixed once this is done.
      await fixPermitRuleSets(ctx.daemon.permits, ctx.daemon.home);
      fs.rmSync(path.join(work, "link"));
      fs.symlinkSync("other", path.join(work, "link"));
      await u.requestOk(apply(0));
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: [`Edit(/${work}/link/c.toml)`, `Edit(/${work}/real/c.toml)`] },
      });
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain(
        `"rules":[{"sid":"${SID_A}","tool_use_id":"${ID}","index":0,"rules":["Edit(/${work}/link/c.toml)","Edit(/${work}/real/c.toml)"]}]`,
      );
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: add の項目の「削除」は、状態にかかわらず、rule の組と一致する
  // rule を全部消し (無ければ何も書かない、ファイルが無ければ作らない)、項目を
  // dismiss にする。冪等で、二度目は何も変えない (送らない)。適用と削除は最後の
  // 操作が勝つ: 適用 → 削除で dismiss、削除 → 適用で run (DR-0040 §12)。
  test("an add item's 削除 takes its rules out and dismisses it; the last of 適用 and 削除 wins", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const work = fs.realpathSync(tmpDir("perm-delete-"));
      fs.mkdirSync(path.join(work, "real"));
      fs.symlinkSync("real", path.join(work, "link"));
      const { s, file } = await asked(ctx, [{ add: `Edit(/${work}/link/c.toml)` }]);
      const markOf = async (): Promise<string | undefined> => {
        await u.request({ op: "ping" });
        const events = (await u.pendingEvents()).filter(isKind("permit_state"));
        return events.at(-1)?.marks.find((m) => m.kind === "project_permissions")?.mark;
      };
      // Nothing there yet: no file is made, and the item is dismissed.
      expect(await u.request(apply(0, ID, "remove"))).toMatchObject({ ok: true, changed: false });
      expect(fs.existsSync(file)).toBe(false);
      expect(await markOf()).toBe("dismiss");
      expect(await u.request(apply(0))).toMatchObject({ ok: true, changed: true });
      expect(await markOf()).toBe("run");
      fs.writeFileSync(
        file,
        JSON.stringify({
          permissions: {
            allow: [`Edit(/${work}/link/c.toml)`, `Edit(/${work}/real/c.toml)`, "Bash(ls)"],
          },
        }),
      );
      expect(await u.request(apply(0, ID, "remove"))).toMatchObject({ ok: true, changed: true });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: ["Bash(ls)"] },
      });
      expect(await markOf()).toBe("dismiss");
      // Again: the same result, nothing written or sent.
      const before = fs.readFileSync(file, "utf8");
      expect(await u.request(apply(0, ID, "remove"))).toMatchObject({ ok: true, changed: false });
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(await markOf()).toBeUndefined();
      expect(await u.request(apply(0))).toMatchObject({ ok: true, changed: true });
      expect(await markOf()).toBe("run");
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: remove の項目の「削除」はその rule を消して項目を run にする
  // (冪等)。書き戻し (change: "add") は無く、invalid_args で断る。「やらない」は
  // permit_dismiss で dismiss にするだけで、ファイルは触らない。
  test("a remove item's 削除 takes the rule out and runs it, and it is never added back", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await subscribedUser(ctx);
      const { s, dir, file } = await asked(ctx, [
        { remove: "Bash(old)" },
        { remove: "Bash(other)" },
      ]);
      fs.mkdirSync(path.join(dir, ".claude"));
      fs.writeFileSync(
        file,
        JSON.stringify({ permissions: { allow: ["Bash(old)", "Bash(other)"] } }),
      );
      expect(await u.request(apply(0, ID, "add"))).toMatchObject({
        ok: false,
        error: { code: "invalid_args" },
      });
      expect(await u.request(apply(0, ID, "remove"))).toMatchObject({ ok: true, changed: true });
      expect(await u.request(apply(0, ID, "remove"))).toMatchObject({ ok: true, changed: false });
      await u.requestOk({
        op: "permit_dismiss",
        sid: SID_A,
        tool_use_id: ID,
        kind: "project_permissions",
        index: 1,
        dismissed: true,
      });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        permissions: { allow: ["Bash(other)"] },
      });
      const { ev } = await u.readEventUntil("permit_state", (e) => e.marks.length === 2);
      expect(ev.marks.map(({ index, mark }) => [index, mark])).toEqual([
        [0, "run"],
        [1, "dismiss"],
      ]);
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
      expect(await u.request(apply(0))).toMatchObject({
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
      expect(await s.request(apply(0))).toMatchObject({
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
