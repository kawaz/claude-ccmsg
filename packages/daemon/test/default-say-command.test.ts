// The built-in say command and which say command a daemon runs
// (docs/design/say-command.md).
//
// 何を保証するか (各 test の doc comment 参照):
//   - config に say_command が無い daemon は組み込み ([daemon の bun, 同梱の
//     default-say-command.ts]) を使う。テストの run の lifeline の下では何も起こさない。
//     say_command があればそれを使う
//   - 組み込みは stdin の JSON の spoken を `[say, "--", spoken]` で渡し、say の
//     終了コードで終わる。読めない入力と say が無い時は鳴らさず 0 以外で終わる
//
// 該当なし: 組み込みが実物の /usr/bin/say を起こすこと (音が出る)。say の場所は
// 引数で差し替えて、記録するだけのコマンドで確かめる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { DEFAULT_SAY_COMMAND_SCRIPT, defaultSayCommand } from "../src/config.ts";
import { runDefaultSayCommand, SYSTEM_SAY } from "../src/default-say-command.ts";
import { sayCommandOf } from "../src/say-speech.ts";

const tmpDir = perTestTmpDir();

const SPEECH = JSON.stringify({
  kind: "say",
  session_id: "5a900000-0000-4000-8000-000000000001",
  text: "-v daemon",
  spoken: "-v デーモン",
});

describe("which say command a daemon runs", () => {
  // 何を保証するか: say_command が無ければ組み込みを、daemon と同じ bun で
  // 同梱のスクリプトを起こす形で使う。
  test("the built-in one when the config names none", () => {
    expect(sayCommandOf(undefined, {})).toEqual([process.execPath, DEFAULT_SAY_COMMAND_SCRIPT]);
    expect(defaultSayCommand()).toEqual([process.execPath, DEFAULT_SAY_COMMAND_SCRIPT]);
    expect(fs.existsSync(DEFAULT_SAY_COMMAND_SCRIPT)).toBe(true);
  });

  // 何を保証するか: テストの run の lifeline の下の daemon は、say_command が
  // 無ければ鳴らさない (null)。say_command があればそれを使う。
  test("none under a test run's lifeline, and the config's when it names one", () => {
    expect(sayCommandOf(undefined, { CCMSG_TEST_LIFELINE: "/x/lifeline.sock" })).toBeNull();
    expect(sayCommandOf(["/bin/rec"], { CCMSG_TEST_LIFELINE: "/x/lifeline.sock" })).toEqual([
      "/bin/rec",
    ]);
    expect(sayCommandOf(["/bin/rec", "-q"], {})).toEqual(["/bin/rec", "-q"]);
  });
});

describe("the built-in say command", () => {
  /** A say that writes its argv, one per line, to `file` and exits `exit`. */
  function recordingSay(work: string, file: string, exit = 0): string {
    return writeMockBin(
      path.join(work, "say"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(file)}; done\nexit ${String(exit)}\n`,
    );
  }

  // 何を保証するか: spoken (辞書を当てた文) を `--` の後に渡す。`-` で始まる
  // 文も say のオプションにならない。終了コードは say のもの。
  test("speaks spoken after --, and ends with say's exit code", async () => {
    const work = tmpDir("ccmsg-default-say-");
    const file = path.join(work, "argv");
    expect(await runDefaultSayCommand(SPEECH, recordingSay(work, file))).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("--\n-v デーモン\n");
    const failing = tmpDir("ccmsg-default-say-");
    expect(await runDefaultSayCommand(SPEECH, recordingSay(failing, file, 4))).toBe(4);
  });

  // 何を保証するか: say が無い (macOS 以外) 時は鳴らさず 0 以外で終わる。
  test("ends non-zero when there is no say", async () => {
    const work = tmpDir("ccmsg-default-say-");
    expect(await runDefaultSayCommand(SPEECH, path.join(work, "no-say"))).toBe(1);
    expect(SYSTEM_SAY).toBe("/usr/bin/say");
  });

  // 何を保証するか: 読めない入力 (JSON でない、知らない field、field が欠ける)
  // には鳴らさず、理由を stderr に書いて 0 以外で終わる。スクリプトとして
  // 起こした時も同じ (読めない入力なので say には届かない)。
  test("an input that does not read ends non-zero, without speaking", async () => {
    const work = tmpDir("ccmsg-default-say-");
    const file = path.join(work, "argv");
    const say = recordingSay(work, file);
    for (const input of [
      "nope",
      JSON.stringify({ kind: "say", session_id: "s", text: "a", spoken: "a", extra: 1 }),
      JSON.stringify({ kind: "say", session_id: "s", text: "a" }),
      JSON.stringify({ kind: "shout", session_id: "s", text: "a", spoken: "a" }),
    ]) {
      expect(await runDefaultSayCommand(input, say)).toBe(2);
    }
    expect(fs.existsSync(file)).toBe(false);
    const [program, ...args] = defaultSayCommand();
    const proc = Bun.spawn([program, ...args], {
      stdin: new Blob(["nope"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(err).toContain("say command: the input does not read");
  });
});
