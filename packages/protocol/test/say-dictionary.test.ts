// The reading dictionary's lines and replacement (DR-0045 §6), as pure
// functions: which words are found where, how the file's lines read, and how
// the file lays over the shipped dictionary. Reading the file and speaking
// are the daemon's (packages/daemon/test/say.test.ts).
import { describe, expect, test } from "bun:test";
import {
  applySayDictionary,
  compileSayDictionary,
  readSayDictionaryLines,
  sayDictionaryEntries,
  sayDictionaryProblems,
  type SayDictionaryEntry,
  userSayDictionary,
} from "../src/index.ts";

function say(entries: readonly SayDictionaryEntry[], text: string): string {
  return applySayDictionary(compileSayDictionary(entries), text);
}

const DAEMON = { word: "daemon", reading: "デーモン" };

describe("applySayDictionary", () => {
  // 何を保証するか: 語の両側が英数字でない所でだけ当たる (kawaz 裁定の
  // `[_\b]` 区切り)。下線・空白・日本語・文字列の端はどれも区切りで、
  // 語の一部 (daemonize / mydaemon / daemon2) には当たらない。
  test("finds a word only where neither side is a letter or a digit", () => {
    expect(say([DAEMON], "daemon")).toBe("デーモン");
    expect(say([DAEMON], "the daemon runs")).toBe("the デーモン runs");
    expect(say([DAEMON], "_daemon_")).toBe("_デーモン_");
    expect(say([DAEMON], "の daemon で")).toBe("の デーモン で");
    expect(say([DAEMON], "のdaemonで")).toBe("のデーモンで");
    expect(say([DAEMON], "daemon-sidecar, daemon.")).toBe("デーモン-sidecar, デーモン.");
    expect(say([DAEMON], "daemonize")).toBe("daemonize");
    expect(say([DAEMON], "mydaemon")).toBe("mydaemon");
    expect(say([DAEMON], "daemon2 2daemon")).toBe("daemon2 2daemon");
  });

  // 何を保証するか: 大文字小文字を無視して当たり、置き換えるのは辞書の読み
  // (当たった語の綴りは残さない)。
  test("matches without regard to case", () => {
    expect(say([DAEMON], "DAEMON Daemon dAeMoN")).toBe("デーモン デーモン デーモン");
    expect(say([{ word: "1Password", reading: "ワンパスワード" }], "1PASSWORD の")).toBe(
      "ワンパスワード の",
    );
  });

  // 何を保証するか: 同じ位置に複数の語が当たる時は長い方 (辞書の並びに
  // よらない)。
  test("takes the longest word where several start at one place", () => {
    const entries = [
      { word: "CI", reading: "シーアイ" },
      { word: "CI-bot", reading: "シーアイボット" },
    ];
    expect(say(entries, "CI-bot と CI")).toBe("シーアイボット と シーアイ");
    expect(say([...entries].reverse(), "CI-bot と CI")).toBe("シーアイボット と シーアイ");
  });

  // 何を保証するか: 辞書に無い語はそのまま。空の辞書は何も変えない。
  test("leaves words the dictionary does not hold as they are", () => {
    expect(say([DAEMON], "plugin と sidecar")).toBe("plugin と sidecar");
    expect(say([], "daemon")).toBe("daemon");
    expect(compileSayDictionary([]).pattern).toBeNull();
  });

  // 何を保証するか: 語に正規表現の記号があっても文字どおりに当たる。
  test("takes the characters of a word literally", () => {
    expect(say([{ word: "C++", reading: "シープラプラ" }], "C++ と Cxx")).toBe(
      "シープラプラ と Cxx",
    );
    expect(say([{ word: "a.b", reading: "エービー" }], "axb a.b")).toBe("axb エービー");
  });

  // 何を保証するか: 同じ語 (大文字小文字違い含む) が 2 度あれば後の行が勝つ。
  test("a later entry for a word wins", () => {
    const entries = [DAEMON, { word: "Daemon", reading: "ディーモン" }];
    expect(say(entries, "daemon")).toBe("ディーモン");
  });
});

describe("readSayDictionaryLines", () => {
  // 何を保証するか: `word<TAB>読み` が entry、`#` 始まりと空行は何でもない行、
  // 末尾の改行で空の行は増えず、CRLF の \r は改行の一部。
  test("reads entries, comments and empty lines", () => {
    const lines = readSayDictionaryLines("# c\r\ndaemon\tデーモン\r\n\n  \njj\tジェイ ジェイ\n");
    expect(lines.map((l) => l.kind)).toEqual(["other", "entry", "other", "other", "entry"]);
    expect(sayDictionaryEntries(lines)).toEqual([
      { word: "daemon", reading: "デーモン" },
      { word: "jj", reading: "ジェイ ジェイ" },
    ]);
    expect(sayDictionaryProblems(lines)).toEqual([]);
    expect(readSayDictionaryLines("")).toEqual([]);
  });

  // 何を保証するか: 読めない行は捨てずに行番号と理由で返す (警告の材料)。
  // タブが無い / 多い / 語が空 / 読みが空白だけ、のそれぞれで理由が言える。
  test("reports each line that does not read, by its line number", () => {
    const lines = readSayDictionaryLines("no tab\na\tb\tc\n\tよみ\nword\t  \nok\tオーケー\n");
    expect(sayDictionaryEntries(lines)).toEqual([{ word: "ok", reading: "オーケー" }]);
    const problems = sayDictionaryProblems(lines);
    expect(problems.map((p) => p.line)).toEqual([1, 2, 3, 4]);
    expect(problems[0]?.reason).toContain("one tab");
    expect(problems[1]?.reason).toContain("one tab");
    expect(problems[2]?.reason).toContain("the word");
    expect(problems[3]?.reason).toContain("the reading");
  });
});

describe("userSayDictionary", () => {
  // 何を保証するか: ファイルが無い間は同梱の初期辞書 (kawaz 裁定の 11 語) が効く。
  // ファイルの行は同梱の後に重なり、同じ語はファイルが勝つ (大文字小文字を問わず)。
  // 読めない行は行番号つきで返り、残りの行は効く。
  test("lays the file over the shipped words, the file winning", () => {
    const shipped = userSayDictionary(undefined);
    expect(applySayDictionary(shipped.dictionary, "1Password の daemon と jj の PR")).toBe(
      "ワンパスワード の デーモン と ジェイジェイ の ピーアール",
    );
    expect(shipped.problems).toEqual([]);
    const user = userSayDictionary("DAEMON\tでーもん\nbroken\npush\tプッシュ\n");
    expect(applySayDictionary(user.dictionary, "daemon に push、CI も")).toBe(
      "でーもん に プッシュ、シーアイ も",
    );
    expect(user.problems.map((p) => p.line)).toEqual([2]);
  });
});
