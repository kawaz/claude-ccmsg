// The reading dictionary on the CLI side (DR-0042): which of say's arguments
// are the text, reading <configDir>/say-dictionary.tsv (or the shipped one),
// and `ccmsg say` speaking with it. Speech
// goes to a mock through CCMSG_SAY_BIN, which records its argv and what came
// on its standard input.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  applySayDictionary,
  readSayDictionaryLines,
  sayDictionaryEntries,
  sayDictionaryProblems,
} from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { BUILTIN_SAY_DICTIONARY, loadSayDictionary, speechTextOf } from "../src/say-dictionary.ts";
import { CLI, runCli } from "./run-cli.ts";

const tmpDir = perTestTmpDir();

describe("speechTextOf", () => {
  // 何を保証するか: 置き換えるのは本文の語だけ。オプションの値 (声の名前・
  // 出力ファイル名) は本文ではないので触らない。`--name=value` / `-vValue` は
  // 1 語で完結し、`--` の後は全部本文。
  test("finds the words of the text among say's options", () => {
    expect(speechTextOf(["-v", "Kyoko", "hello", "-o", "plugin.aiff", "world"])).toEqual({
      words: [2, 5],
      fromStdin: false,
    });
    expect(speechTextOf(["--voice=Kyoko", "-r200", "--progress", "-i", "hi"])).toEqual({
      words: [4],
      fromStdin: false,
    });
    expect(speechTextOf(["--rate", "200", "--", "-v", "daemon"])).toEqual({
      words: [3, 4],
      fromStdin: false,
    });
    // 知らない `-x` はフラグとして渡し、次の語は本文。単独の `-` も本文。
    expect(speechTextOf(["--sid", "こんにちは", "-"])).toEqual({ words: [1, 2], fromStdin: false });
  });

  // 何を保証するか: 本文が無く -f も無ければ say は標準入力を読む。-f の
  // ファイルの中身は say が読むので、標準入力の形ではない。
  test("says when the text comes on standard input", () => {
    expect(speechTextOf([])).toEqual({ words: [], fromStdin: true });
    expect(speechTextOf(["-v", "Kyoko"])).toEqual({ words: [], fromStdin: true });
    expect(speechTextOf(["-f", "note.txt"]).fromStdin).toBe(false);
    expect(speechTextOf(["-fnote.txt"]).fromStdin).toBe(false);
    expect(speechTextOf(["--input-file=note.txt"]).fromStdin).toBe(false);
    expect(speechTextOf(["--input-file", "note.txt"]).fromStdin).toBe(false);
  });
});

describe("loadSayDictionary", () => {
  // 何を保証するか: ファイルが無い間は同梱の初期辞書 (kawaz 裁定の 11 語) が効く。
  test("speaks with the shipped dictionary while the file does not exist", () => {
    const file = path.join(tmpDir("ccmsg-say-dict-"), "say-dictionary.tsv");
    const warned: string[] = [];
    const dict = loadSayDictionary(file, (m) => warned.push(m));
    expect(warned).toEqual([]);
    expect(applySayDictionary(dict, "1Password の daemon を plugin で")).toBe(
      "ワンパスワード の デーモン を プラグイン で",
    );
    const shipped = readSayDictionaryLines(fs.readFileSync(BUILTIN_SAY_DICTIONARY, "utf8"));
    expect(sayDictionaryProblems(shipped)).toEqual([]);
    expect(sayDictionaryEntries(shipped).map((e) => e.word)).toEqual([
      "1Password",
      "daemon",
      "sidecar",
      "plugin",
      "OTP",
      "URL",
      "API",
      "CI",
      "PR",
      "jj",
      "Kyell",
    ]);
  });

  // 何を保証するか (kawaz 裁定: 同梱 + ファイルの重ね合わせ): ファイルに 1 行
  // 足すだけで語が増え、同梱の語はそのまま効き、同じ語 (大文字小文字を無視)
  // はファイルが勝つ。
  test("lays the file over the shipped dictionary, the file winning", () => {
    const file = path.join(tmpDir("ccmsg-say-dict-"), "say-dictionary.tsv");
    fs.writeFileSync(file, "Fable\tフェイブル\nDAEMON\tディーモン\n");
    const dict = loadSayDictionary(file, () => {});
    expect(applySayDictionary(dict, "Fable の daemon を plugin で")).toBe(
      "フェイブル の ディーモン を プラグイン で",
    );
  });

  // 何を保証するか: 読めない行は黙って捨てず、ファイル名と行番号で 1 行ずつ
  // 警告し、その行だけ飛ばす (残りの行と同梱の語は効く)。
  test("warns about each line that does not read and uses the rest", () => {
    const file = path.join(tmpDir("ccmsg-say-dict-"), "say-dictionary.tsv");
    fs.writeFileSync(file, "# mine\nbroken\njj\tジェイ ジェイ\n");
    const warned: string[] = [];
    const dict = loadSayDictionary(file, (m) => warned.push(m));
    expect(warned).toEqual([
      `${file}:2: an entry is \`word<TAB>reading\`, one tab between them — line skipped`,
    ]);
    expect(applySayDictionary(dict, "jj daemon")).toBe("ジェイ ジェイ デーモン");
  });

  // 何を保証するか: ファイルそのものが読めない (ここではディレクトリ) 時は
  // 1 行警告して同梱の辞書だけで話す。発声は止めない。
  test("speaks with the shipped dictionary alone when the file cannot be read", () => {
    const file = tmpDir("ccmsg-say-dict-");
    const warned: string[] = [];
    const dict = loadSayDictionary(file, (m) => warned.push(m));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("not used");
    expect(applySayDictionary(dict, "daemon")).toBe("デーモン");
  });
});

interface Fixture {
  env: Record<string, string>;
  dictFile: string;
  /** Each invocation's argv, tab-separated. */
  said: () => string[][];
  /** What the speech binary got on standard input, all invocations. */
  stdin: () => string;
}

function makeFixture(): Fixture {
  const base = tmpDir("ccmsg-say-dict-cli-");
  const sayLog = path.join(base, "say.log");
  const stdinLog = path.join(base, "stdin.log");
  // The mock reads standard input only when it is not a terminal, like the
  // tests' own spawn (never a terminal).
  const sayBin = writeMockBin(
    path.join(base, "fake-say"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$(IFS=$'\\t'; echo "$*")" >> ${JSON.stringify(sayLog)}\ncat >> ${JSON.stringify(stdinLog)}\n`,
  );
  const configDir = path.join(base, "c");
  const read = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  return {
    env: {
      CCMSG_STATE_DIR: path.join(base, "s"),
      CCMSG_CONFIG_DIR: configDir,
      CCMSG_DATA_DIR: path.join(base, "d"),
      CCMSG_SAY_BIN: sayBin,
      CCMSG_SID: "",
      CLAUDE_CODE_SESSION_ID: "",
    },
    dictFile: path.join(configDir, "say-dictionary.tsv"),
    said: () =>
      read(sayLog)
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => l.split("\t")),
    stdin: () => read(stdinLog),
  };
}

/** `ccmsg say <args>` with `stdin` on its standard input. */
async function runSayWithStdin(
  args: string[],
  stdin: string,
  env: Record<string, string>,
): Promise<{ err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, CLI, "say", ...args], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { err, code };
}

describe("ccmsg say with the reading dictionary", () => {
  // 何を保証するか (受け入れ条件「say が読み上げ前に辞書置換する」): 本文の語は
  // 読みに置き換わって say に届き、オプションとその値は元のまま。
  test("speaks the words of the text as their readings", async () => {
    const f = makeFixture();
    const res = await runCli(
      ["say", "-v", "Kyoko", "-o", "plugin.aiff", "1Password の daemon を plugin で"],
      f.env,
    );
    expect(res.code).toBe(0);
    expect(f.said()).toEqual([
      ["-v", "Kyoko", "-o", "plugin.aiff", "ワンパスワード の デーモン を プラグイン で"],
    ]);
  });

  // 何を保証するか: 本文が標準入力 (pipe) の形でも置き換わる。
  test("replaces words in text that comes on standard input", async () => {
    const f = makeFixture();
    const res = await runSayWithStdin(["-r", "200"], "jj の PR\n", f.env);
    expect(res.code).toBe(0);
    expect(f.said()).toEqual([["-r", "200"]]);
    expect(f.stdin()).toBe("ジェイジェイ の ピーアール\n");
  });

  // 何を保証するか: 辞書ファイルに 1 行足すと次の say から効く (daemon も
  // 再起動も介さない)。同梱の語は効いたまま。読めない行の警告は say の標準
  // エラーに出て、発声は続く。
  test("an edit of the file is in effect from the next say, and a bad line is warned about", async () => {
    const f = makeFixture();
    expect((await runCli(["say", "Fable の daemon"], f.env)).code).toBe(0);
    fs.mkdirSync(path.dirname(f.dictFile), { recursive: true });
    fs.writeFileSync(f.dictFile, "Fable\tフェイブル\nbroken\n");
    const res = await runCli(["say", "Fable の daemon"], f.env);
    expect(res.code).toBe(0);
    expect(f.said()).toEqual([["Fable の デーモン"], ["フェイブル の デーモン"]]);
    expect(res.err).toBe(
      `ccmsg say: ${f.dictFile}:2: an entry is \`word<TAB>reading\`, one tab between them — line skipped\n`,
    );
  });
});
