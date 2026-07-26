// Status tab ENV panel query semantics (kawaz r55m132): whitespace-separated
// AND terms matched against name and value alike, plus the colon→newline
// display split. No DOM — these are the pure folds behind the panel.
import { describe, expect, test } from "bun:test";
import {
  filterEnvRows,
  isSensitiveEnvName,
  matchesEnvQuery,
  parseEnvQuery,
  splitColonValue,
  toEnvRows,
  type EnvRow,
} from "../src/client/env-filter.ts";

const ROWS: EnvRow[] = [
  { name: "PATH", value: "/usr/bin:/bin" },
  { name: "EDITOR", value: "hx" },
  { name: "CLAUDE_CONFIG_DIR", value: "/Users/kawaz/.claude-personal" },
];

describe("parseEnvQuery", () => {
  test("空白区切りで分割し、小文字化する", () => {
    expect(parseEnvQuery("PATH Bin")).toEqual(["path", "bin"]);
  });

  test("前後の空白・連続空白・タブは項として数えない", () => {
    expect(parseEnvQuery("  a \t\n b  ")).toEqual(["a", "b"]);
  });

  test("空クエリは項ゼロ (= 全件通過の合図)", () => {
    expect(parseEnvQuery("   ")).toEqual([]);
  });
});

describe("matchesEnvQuery", () => {
  const row: EnvRow = { name: "PATH", value: "/usr/bin:/bin" };

  test("項ゼロは常に一致 (フィルタなし)", () => {
    expect(matchesEnvQuery(row, [])).toBe(true);
  });

  test("名前だけに当たる項でも値だけに当たる項でも一致する", () => {
    expect(matchesEnvQuery(row, ["path"])).toBe(true);
    expect(matchesEnvQuery(row, ["usr"])).toBe(true);
  });

  test("複数項は AND (全部当たって初めて一致)", () => {
    expect(matchesEnvQuery(row, ["path", "usr"])).toBe(true);
    expect(matchesEnvQuery(row, ["path", "nope"])).toBe(false);
  });

  test("項ごとに当たる先が違ってもよい (名前と値をまたぐ AND)", () => {
    // "editor" は名前、"hx" は値。両方揃って初めて一致する。
    expect(matchesEnvQuery({ name: "EDITOR", value: "hx" }, ["editor", "hx"])).toBe(true);
  });

  test("大文字小文字を区別しない (項は小文字化済み前提)", () => {
    expect(matchesEnvQuery(row, parseEnvQuery("PaTh"))).toBe(true);
  });
});

describe("toEnvRows", () => {
  test("名前昇順に並べる (ワイヤ順は意味を持たないため)", () => {
    expect(toEnvRows({ ZED: "1", ALPHA: "2", MID: "3" }).map((r) => r.name)).toEqual([
      "ALPHA",
      "MID",
      "ZED",
    ]);
  });

  test("空の env は空配列", () => {
    expect(toEnvRows({})).toEqual([]);
  });
});

describe("filterEnvRows", () => {
  test("空クエリは全件返す", () => {
    expect(filterEnvRows(ROWS, "")).toHaveLength(3);
  });

  test("AND 検索で名前・値の双方から絞り込む", () => {
    expect(filterEnvRows(ROWS, "claude personal").map((r) => r.name)).toEqual([
      "CLAUDE_CONFIG_DIR",
    ]);
  });

  test("一致なしは空配列", () => {
    expect(filterEnvRows(ROWS, "nonexistent")).toEqual([]);
  });
});

describe("isSensitiveEnvName (kawaz r55m134)", () => {
  test("代表的な機微パターンを名前から検出する", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
      "API_KEY",
      "SSH_PRIVATE_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AUTH_HEADER",
      "SESSION_ID",
      "COOKIE_JAR",
    ]) {
      expect(isSensitiveEnvName(name)).toBe(true);
    }
  });

  test("部分一致なので接頭辞・接尾辞・小文字表記でも拾う", () => {
    expect(isSensitiveEnvName("npm_config_authtoken")).toBe(true);
    expect(isSensitiveEnvName("MY_TOKEN_FOR_THING")).toBe(true);
  });

  test("機微でない一般的な変数はマスクしない", () => {
    for (const name of ["PATH", "EDITOR", "HOME", "LANG", "TERM", "CWD", "SHELL"]) {
      expect(isSensitiveEnvName(name)).toBe(false);
    }
  });

  test("広めに取る方針の副作用: KEY を含む無害な名前も拾う (意図的)", () => {
    // 誤マスクはクリック 1 回で解除できるが、誤露出は画面に出た後では戻せない。
    // 非対称なので広い側に倒す、という判断をここで固定しておく。
    expect(isSensitiveEnvName("KEYMAP")).toBe(true);
  });
});

describe("splitColonValue", () => {
  test("コロンで分割する (PATH 系を読みやすくする表示スイッチ)", () => {
    expect(splitColonValue("/usr/bin:/bin:/opt/homebrew/bin")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
    ]);
  });

  test("コロンを含まない値はそのまま 1 要素 (スイッチが無害であること)", () => {
    expect(splitColonValue("hx")).toEqual(["hx"]);
  });

  test("空要素も落とさず保持する (末尾コロン等が見えなくならないように)", () => {
    expect(splitColonValue("/bin::/usr/bin:")).toEqual(["/bin", "", "/usr/bin", ""]);
  });
});
