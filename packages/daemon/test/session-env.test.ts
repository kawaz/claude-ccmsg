// session_env contract (kawaz r55m133): the env comes from the SESSION's own
// pid, resolved and pid-reuse-verified by the exact same path session_kill
// uses. These tests pin the two platform parsers (macOS `ps eww` is a lossy
// space-separated format, Linux /proc environ is not) and the resolve →
// verify → read flow, including that a failed verification refuses to read at
// all — reading a recycled pid's environment would disclose an unrelated
// process's secrets.
import { describe, expect, test } from "bun:test";
import {
  parseEnv,
  parseProcEnviron,
  parsePsEnv,
  sessionEnv,
  type SessionEnvDeps,
} from "../src/session-env.ts";

function fakeDeps(overrides: Partial<SessionEnvDeps> = {}): SessionEnvDeps {
  return {
    configDirs: () => ["/fake/.claude"],
    runAgents: () => Promise.resolve("[]"),
    runPs: () => Promise.resolve("claude\n"),
    sendSignal: () => {},
    isAlive: () => false,
    sleep: () => Promise.resolve(),
    timing: { secondSignalAfterMs: 100, pollIntervalMs: 20, totalGraceMs: 300 },
    platform: () => "darwin",
    readEnv: () => Promise.resolve("cmd FOO=bar"),
    ...overrides,
  };
}

const AGENTS_ROW = (sid: string, pid: number) => JSON.stringify([{ sessionId: sid, pid }]);

describe("parseProcEnviron (Linux /proc/<pid>/environ)", () => {
  test("NUL-separated records split into name/value, trailing NUL ignored", () => {
    expect(parseProcEnviron("A=1\0B=2\0")).toEqual({ A: "1", B: "2" });
  });

  test("値の空白・改行・= は NUL 区切りなので曖昧さなく保持される", () => {
    // This is the whole reason Linux is the unambiguous platform: none of
    // these need the NAME= heuristic the macOS parser is forced to use.
    expect(parseProcEnviron("SPACED=foo bar baz\0EQ=a=b=c\0NL=line1\nline2\0")).toEqual({
      SPACED: "foo bar baz",
      EQ: "a=b=c",
      NL: "line1\nline2",
    });
  });

  test("空値は保持し、= を含まないレコードと空レコードは捨てる", () => {
    expect(parseProcEnviron("EMPTY=\0garbage\0\0OK=1")).toEqual({ EMPTY: "", OK: "1" });
  });
});

describe("parsePsEnv (macOS `ps eww`)", () => {
  test("最初の NAME= 手前までは argv として捨てる", () => {
    // Real shape: `ps eww -o command=` prints the command line first, then the
    // environment, with nothing marking the boundary.
    expect(parsePsEnv("/opt/homebrew/bin/claude --model opus PATH=/bin HOME=/Users/kawaz")).toEqual(
      {
        PATH: "/bin",
        HOME: "/Users/kawaz",
      },
    );
  });

  test("値内の = は分割せず保持する (最初の = だけが区切り)", () => {
    expect(parsePsEnv("cmd EQ=a=b=c")).toEqual({ EQ: "a=b=c" });
  });

  test("空白を含む値は次の NAME= が現れるまで連結して復元する", () => {
    // Verified against a real process: `SPACEVAR="foo bar baz" EQVAR=a=b=c`
    // prints as `SPACEVAR=foo bar baz EQVAR=a=b=c` with no quoting at all.
    expect(parsePsEnv("cmd SPACEVAR=foo bar baz EQVAR=a=b=c")).toEqual({
      SPACEVAR: "foo bar baz",
      EQVAR: "a=b=c",
    });
  });

  test("NAME= の形をした語を値に含むケースは分割される (この形式の既知の限界)", () => {
    // Documented limitation, asserted so a future "fix" has to face it: the
    // format carries no quoting, so this is genuinely undecidable here.
    expect(parsePsEnv("cmd MSG=see FOO=bar for details")).toEqual({
      MSG: "see",
      FOO: "bar for details",
    });
  });

  test("NAME= が 1 つも無い出力 (env 非表示プロセス) は空オブジェクト", () => {
    // macOS declines to show the environment for some processes; reporting
    // "no variables" beats misparsing the argv into fake entries.
    expect(parsePsEnv("sleep 60")).toEqual({});
  });

  test("小文字・アンダースコア始まりは名前として認め、数字始まりは値の続きとみなす", () => {
    expect(parsePsEnv("cmd _under=1 lower=2 9bad=3")).toEqual({
      _under: "1",
      lower: "2 9bad=3",
    });
  });
});

describe("parseEnv platform routing", () => {
  test("linux は NUL 区切り、それ以外は ps 形式で解釈する", () => {
    expect(parseEnv("A=1\0B=2", "linux")).toEqual({ A: "1", B: "2" });
    expect(parseEnv("cmd A=1 B=2", "darwin")).toEqual({ A: "1", B: "2" });
  });
});

describe("sessionEnv flow", () => {
  test("解決した pid の env を返し、読んだ pid も一緒に返す", async () => {
    const seen: number[] = [];
    const res = await sessionEnv(
      "sid-1",
      fakeDeps({
        runAgents: () => Promise.resolve(AGENTS_ROW("sid-1", 4242)),
        readEnv: (pid) => {
          seen.push(pid);
          return Promise.resolve("claude FOO=bar");
        },
      }),
    );
    expect(res).toEqual({ found: true, pid: 4242, env: { FOO: "bar" } });
    expect(seen).toEqual([4242]);
  });

  test("sid が解決できなければ found:false で env を読まない", async () => {
    let read = false;
    const res = await sessionEnv(
      "missing",
      fakeDeps({
        runAgents: () => Promise.resolve("[]"),
        readEnv: () => {
          read = true;
          return Promise.resolve("");
        },
      }),
    );
    expect(res).toEqual({ found: false });
    expect(read).toBe(false);
  });

  test("ps 検証に落ちた pid は読まずに found:false (pid-reuse ガード)", async () => {
    // The pid resolved but now belongs to something that isn't claude — the
    // one case where reading anyway would leak an unrelated process's env.
    let read = false;
    const res = await sessionEnv(
      "sid-1",
      fakeDeps({
        runAgents: () => Promise.resolve(AGENTS_ROW("sid-1", 4242)),
        runPs: () => Promise.resolve("/usr/bin/python3 something.py\n"),
        readEnv: () => {
          read = true;
          return Promise.resolve("");
        },
      }),
    );
    expect(res).toEqual({ found: false });
    expect(read).toBe(false);
  });

  test("env 読み取りの失敗は呼び出し側へ伝播する (found:false に化けない)", async () => {
    // server.ts maps a rejection to an internal error; silently returning
    // "not found" would tell the user the session is gone when it isn't.
    const p = sessionEnv(
      "sid-1",
      fakeDeps({
        runAgents: () => Promise.resolve(AGENTS_ROW("sid-1", 4242)),
        readEnv: () => Promise.reject(new Error("ps exited 1")),
      }),
    );
    expect(p).rejects.toThrow("ps exited 1");
  });
});
