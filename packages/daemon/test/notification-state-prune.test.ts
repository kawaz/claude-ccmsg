// The daemon's start-time upkeep of the person's state (DR-0045 §7,
// DR-0040 §4).
//
// 何を保証するか (各 test の doc comment 参照):
//   - say-read.json と permit-state.json の状態は、起動の時に走っていない
//     (プロセスの一覧に居ない) セッションの分を落とす。一覧が 1 件も返さない・
//     失敗した時は何も落とさない
//   - 旧来の permit-requests.json は起動時に消し、log に 1 行書く。無ければ何も
//     しない
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pruneNotificationState, removeRequestRecordsFile } from "../src/server.ts";
import { SessionIds } from "../src/session-ids.ts";
import { startInProcessDaemon, stopInProcessDaemon } from "./helpers.ts";

const KEPT = "3e700000-0000-4000-8000-0000000000a1";
const GONE = "3e700000-0000-4000-8000-0000000000a2";

describe("the person's state of sessions not running", () => {
  // 何を保証するか: 起動の時に走っていない (プロセスの一覧に居ない) セッションの
  // 既読の say・許可依頼の既読 / 許可済み / 適用はファイルから落ち、走っている
  // セッションの分は残る。一覧が 1 件も返さない (null) 時と一覧が失敗した時は
  // 何も落とさない。
  test("is dropped from both files, a running session's kept", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const { sayUnread, permits } = ctx.daemon;
      sayUnread.read = new SessionIds({ [KEPT]: ["toolu_say_kept"], [GONE]: ["toolu_say_gone"] });
      permits.read = new SessionIds({ [KEPT]: ["toolu_p_kept"], [GONE]: ["toolu_p_gone"] });
      permits.granted = new SessionIds({ [GONE]: ["toolu_p_gone"] });
      permits.applied = [
        { sid: GONE, tool_use_id: "toolu_p_gone", permission: { add: "Bash(x)" }, applied_at: "t" },
        { sid: KEPT, tool_use_id: "toolu_p_kept", permission: { add: "Bash(y)" }, applied_at: "t" },
      ];

      await pruneNotificationState(ctx.daemon, async () => null);
      await pruneNotificationState(ctx.daemon, async () => {
        throw new Error("cannot list");
      });
      expect(sayUnread.read.ids()).toHaveLength(2);

      await pruneNotificationState(ctx.daemon, async () => new Set([KEPT, "someone-else"]));
      expect(sayUnread.read.ids()).toEqual(["toolu_say_kept"]);
      expect(JSON.parse(fs.readFileSync(ctx.daemon.paths.sayRead, "utf8"))).toMatchObject({
        read: { [KEPT]: ["toolu_say_kept"] },
      });
      expect(JSON.parse(fs.readFileSync(ctx.daemon.paths.permitState, "utf8"))).toMatchObject({
        read: { [KEPT]: ["toolu_p_kept"] },
        granted: {},
        applied: [{ sid: KEPT, tool_use_id: "toolu_p_kept" }],
      });
      expect(fs.readFileSync(ctx.daemon.paths.log, "utf8")).toContain(
        "notification state: dropped the state of 1 of 2 sessions not running",
      );
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("the request records file", () => {
  // 何を保証するか: 起動時に <stateDir>/permit-requests.json があれば消して log に
  // 1 行書き、無ければ何もしない (log にも書かない)。
  test("is removed at the start, and nothing is said when there is none", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const file = path.join(ctx.daemon.paths.stateDir, "permit-requests.json");
      fs.writeFileSync(file, '{"requests":[]}\n');
      await removeRequestRecordsFile(ctx.daemon);
      expect(fs.existsSync(file)).toBe(false);
      const said = (): number =>
        fs
          .readFileSync(ctx.daemon.paths.log, "utf8")
          .split("\n")
          .filter((line) => line.includes("permit-requests: removed")).length;
      expect(said()).toBe(1);
      await removeRequestRecordsFile(ctx.daemon);
      expect(said()).toBe(1);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
