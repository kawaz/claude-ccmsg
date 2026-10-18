// `ccmsg say` の CLI 契約を、実 CLI を subprocess で走らせて
// 検証する。発声そのものは CCMSG_SAY_BIN で差し替えたモックに置き換える —
// 実 /usr/bin/say を叩くと CI でも手元でも音が出るし、引数がどう届いたかは
// モックの記録の方が正確に読める。
//
// 何を保証するか:
//   - 引数は一切解釈されずそのまま say へ渡る (say のオプションが生きる)
//   - 終了コードは say のものが伝播する
//   - daemon がいない / sid が無い場合でも発声は必ず起きる (観測は諦める)
//   - sid + daemon がある場合は daemon に say が記録される (room には書かない)
//   - --help は ccmsg 側の説明を出し、say を起動しない
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { connect } from "../../daemon/test/helpers.ts";
import { runCli } from "./run-cli.ts";

interface Fixture {
  base: string;
  /** The directories the CLI is pinned to, and whatever else a test sets. */
  env: Record<string, string> & {
    CCMSG_STATE_DIR: string;
    CCMSG_CONFIG_DIR: string;
    CCMSG_DATA_DIR: string;
  };
  /** Each line is one invocation's argv, tab-separated. */
  sayLog: string;
  cleanup: () => void;
}

/** A fake `say` that records its argv and exits with `exitCode`. */
function makeFixture(exitCode = 0): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-say-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const sayLog = path.join(base, "say.log");
  const sayBin = writeMockBin(
    path.join(base, "fake-say"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$(IFS=$'\\t'; echo "$*")" >> ${JSON.stringify(sayLog)}\nexit ${exitCode}\n`,
  );
  return {
    base,
    sayLog,
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
      CCMSG_DATA_DIR: dataDir,
      CCMSG_SAY_BIN: sayBin,
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function sayInvocations(f: Fixture): string[][] {
  if (!fs.existsSync(f.sayLog)) return [];
  return fs
    .readFileSync(f.sayLog, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));
}

describe("ccmsg say", () => {
  // 何を保証するか: ccmsg は引数を一つも解釈しない。`--sid` は ccmsg のグローバル
  // オプションだが、say の shim としては「say に渡る一語」でなければならない
  // (勝手に食べると shim 越しの say の挙動が本物と変わる)。
  test("forwards every argument verbatim, including ones ccmsg would otherwise parse", async () => {
    const f = makeFixture();
    try {
      const res = await runCli(["say", "-v", "Kyoko", "--sid", "こんにちは"], f.env);
      expect(res.code).toBe(0);
      expect(sayInvocations(f)).toEqual([["-v", "Kyoko", "--sid", "こんにちは"]]);
    } finally {
      f.cleanup();
    }
  });

  // 何を保証するか: say の終了コードがそのまま伝わる。shim 越しでも
  // `say ... || handle_failure` のような使い方が壊れない。
  test("propagates the speech binary's exit code", async () => {
    const f = makeFixture(3);
    try {
      const res = await runCli(["say", "boom"], f.env);
      expect(res.code).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  // 何を保証するか (kawaz「最後は exec say するだけ」): session id が無くても、
  // daemon が居なくても、発声は必ず起きる。観測のために音を落とさない。
  test("speaks with no session id and no running daemon, and starts no daemon", async () => {
    const f = makeFixture();
    try {
      const res = await runCli(["say", "no session here"], {
        ...f.env,
        CCMSG_SID: "",
        CLAUDE_CODE_SESSION_ID: "",
      });
      expect(res.code).toBe(0);
      expect(sayInvocations(f)).toEqual([["no session here"]]);
      // 発声のために daemon を起こさない (起動は明示的な操作であるべき)。
      expect(fs.existsSync(path.join(f.env.CCMSG_STATE_DIR, "daemon.sock"))).toBe(false);

      // sid はあるが daemon が居ない場合も同じ: 記録は諦め、発声は行う。
      const res2 = await runCli(["say", "daemon down"], {
        ...f.env,
        CCMSG_SID: "5a000000-0000-4000-8000-000000000000",
      });
      expect(res2.code).toBe(0);
      expect(sayInvocations(f)[1]).toEqual(["daemon down"]);
      expect(fs.existsSync(path.join(f.env.CCMSG_STATE_DIR, "daemon.sock"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  // 何を保証するか: daemon が動いていれば、発声の前にどのセッションが喋ったか
  // が daemon に記録され、webui (user role の subscribe) に ev:"says" で届く —
  // これが webui で「どのセッションが喋ったか」を答える唯一の材料。記録は
  // daemon のメモリだけで、room storage には何も書かない (DR-0036 §3)。
  test("records the say in the running daemon, not in a room", async () => {
    const f = makeFixture();
    try {
      // 別コマンドで daemon を起こしてから say する (say 自身は起こさない)。
      await runCli(["daemon", "start"], f.env);
      const res = await runCli(["say", "-v", "Alex", "hello there"], {
        ...f.env,
        CCMSG_SID: "5a000000-0000-4000-8000-000000000000",
        CCMSG_REPO: "some-repo",
      });
      expect(res.code).toBe(0);
      expect(sayInvocations(f)).toEqual([["-v", "Alex", "hello there"]]);

      const u = await connect(path.join(f.env.CCMSG_STATE_DIR, "daemon.sock"));
      try {
        await u.hello({ role: "user" });
        await u.request({ op: "subscribe" });
        const { ev } = await u.readEventUntil("says");
        expect(ev.says.map((r) => [r.sid, r.text, r.read])).toEqual([
          // argv そのまま (say に渡した形が読み手にも見える)
          ["5a000000-0000-4000-8000-000000000000", "-v Alex hello there", false],
        ]);
      } finally {
        u.close();
      }
      const roomsDir = path.join(f.env.CCMSG_DATA_DIR, "rooms");
      const files = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir) : [];
      expect(files).toEqual([]);
    } finally {
      await runCli(["daemon", "stop"], f.env);
      f.cleanup();
    }
  });

  // 何を保証するか: --help は ccmsg 側の説明で、say は起動しない。逆に引数なしは
  // help ではなく say へ落とす (`echo x | say` の pipe 形を壊さないため)。
  test("--help prints ccmsg's own description without speaking", async () => {
    const f = makeFixture();
    try {
      const res = await runCli(["say", "--help"], f.env);
      expect(res.code).toBe(0);
      expect(res.out).toContain("ccmsg say");
      expect(res.out).toContain("/usr/bin/say");
      expect(sayInvocations(f)).toEqual([]);

      // 引数なしは help ではなく say 起動 (argv は空、stdin 読みの形)。
      // 記録は空行 1 本なので sayInvocations のフィルタでは見えない。
      const bare = await runCli(["say"], { ...f.env, CCMSG_SID: "" });
      expect(bare.code).toBe(0);
      expect(fs.readFileSync(f.sayLog, "utf8")).toBe("\n");
    } finally {
      f.cleanup();
    }
  });
});
