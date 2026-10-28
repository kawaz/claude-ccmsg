// `ccmsg agents` — the daemon's agents rows (op `agents`: every live Claude Code
// process in the config dirs the daemon serves, as Claude Code records it in
// `<config dir>/sessions/<pid>.json`, with what the session's hooks module said
// of its turn) for a person or a script outside any session (a launchd job).
//
// 何を保証するか:
//   - 既定の出力は daemon の応答そのまま (1 行の JSON)。他のコマンド (peers /
//     status / dump) が JSON を既定にしているのと同じで、スクリプトはこれを読む
//   - `--format text` は人が読む表。daemon の行を足し引きせず、列を揃えて並べるだけ
//   - op `agents` は daemon が user role にしか答えないので、CLI はセッションの中から
//     呼ばれても (CLAUDE_CODE_SESSION_ID がある) user role で hello する
//   - daemon が断ったら、その応答を stderr に出して exit 1 (どちらの format でも)
//   - 引数の誤りは daemon に繋ぐ前に usage 付きで止める
//
// daemon は偽物 (fake-daemon.ts) にする。本物の daemon の agents poll は起動直後の
// 1 回目が済むまで行が無く (polled_at: null)、その完了を待つ口が無いため。行の
// 中身は本物の poll と同じ schema (AgentsResponseSchema) を CLI の client が通す。
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  type AgentInfo,
  type AgentsResponse,
  AgentsResponseSchema,
  JsonTextSchema,
  parseWith,
  PROTOCOL_VERSION,
  readRequest,
  type RequestFrame,
  VERSION,
} from "@ccmsg/protocol";
import { agentsTable } from "../src/agents.ts";
import { printed } from "./cli-output.ts";
import { type FakeAnswer, type FakeDaemon, fakeDaemon } from "./fake-daemon.ts";
import { runCli } from "./run-cli.ts";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const HOME = "/home/someone";

const BUSY: AgentInfo = {
  pid: 101,
  cwd: `${HOME}/repo`,
  kind: "interactive",
  startedAt: 1_761_600_000_000,
  version: "2.1.310",
  sessionId: "11111111-1111-4111-8111-111111111111",
  name: "🤖検証",
  status: "busy",
  config_dir: `${HOME}/.claude-personal`,
  turn: { state: "responding", since: "2026-10-28T00:00:00.000Z" },
};

const WAITING: AgentInfo = {
  pid: 202,
  cwd: "/srv/work",
  kind: "background",
  startedAt: 1_761_600_100_000,
  sessionId: "22222222-2222-4222-8222-222222222222",
  status: "waiting",
  waitingFor: "dialog open",
  config_dir: "/etc/claude",
};

const ROWS: AgentsResponse = {
  ok: true,
  agents: [BUSY, WAITING],
  polled_at: "2026-10-28T00:00:05.000Z",
};

/** A fake daemon that takes any hello and answers `agents` with `agents`,
 * stopped once the test ends. */
function daemon(agents: (req: RequestFrame) => object): FakeDaemon {
  const answer = (req: RequestFrame): FakeAnswer => {
    if (req.op === "hello") {
      return [
        { ok: true, version: VERSION, protocol: PROTOCOL_VERSION, request_id: req.request_id },
      ];
    }
    if (req.op === "agents") return [{ ...agents(req), request_id: req.request_id }];
    return [
      {
        ok: false,
        error: { code: "bad_request", msg: `no ${req.op}` },
        request_id: req.request_id,
      },
    ];
  };
  const peer = fakeDaemon(answer);
  cleanup.push(() => peer.stop());
  return peer;
}

/** The environment that points the CLI at `peer`, as a session would run it:
 * with a session id the CLI must not hello with. */
function envFor(peer: FakeDaemon): Record<string, string> {
  const dir = path.dirname(peer.sock);
  return {
    CCMSG_STATE_DIR: dir,
    CCMSG_CONFIG_DIR: path.join(dir, "config"),
    CCMSG_DATA_DIR: path.join(dir, "data"),
    CLAUDE_CODE_SESSION_ID: "33333333-3333-4333-8333-333333333333",
    HOME,
  };
}

/** The role each hello the CLI wrote asked for (undefined for a hello that
 * named none). */
function helloRoles(peer: FakeDaemon): Array<string | undefined> {
  return peer.lines.flatMap((line) => {
    const read = readRequest(line);
    return read.kind === "request" && read.request.op === "hello" ? [read.request.role] : [];
  });
}

describe("ccmsg agents (daemon の偽応答に対する出力)", () => {
  test("既定は daemon の応答をそのまま 1 行の JSON で出し、セッションの中からでも user role で hello する", async () => {
    // user role でないと daemon は op agents を断る (行は webui の Sessions 一覧の物で、
    // セッションの AI が使う口ではない)。CLAUDE_CODE_SESSION_ID を拾って session role で
    // hello すると、セッションの中から人が打った時に必ず断られる。
    const peer = daemon(() => ROWS);
    const r = await runCli(["agents"], envFor(peer));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.endsWith("\n")).toBe(true);
    expect(r.out.trimEnd().includes("\n")).toBe(false);
    expect(printed(AgentsResponseSchema, r.out)).toEqual(ROWS);
    expect(peer.requests.map((q) => q.op)).toEqual(["hello", "agents"]);
    expect(helloRoles(peer)).toEqual(["user"]);
  });

  test("--format text は表を出す (オプションはコマンドの前にも後ろにも置ける)", async () => {
    // HOME 配下のパスは ~ で書く (CLI の HOME を偽の HOME にしてある)。
    for (const args of [
      ["agents", "--format", "text"],
      ["--format", "text", "agents"],
    ]) {
      const peer = daemon(() => ROWS);
      const r = await runCli(args, envFor(peer));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toBe(
        [
          "SESSION                               STATUS                 TURN        NAME    CONFIG DIR          CWD",
          "11111111-1111-4111-8111-111111111111  busy                   responding  🤖検証  ~/.claude-personal  ~/repo",
          "22222222-2222-4222-8222-222222222222  waiting (dialog open)  -           -       /etc/claude         /srv/work",
          "",
        ].join("\n"),
      );
    }
  });

  test("daemon が断ったら、その応答を stderr に出して exit 1 (表を頼んでいても)", async () => {
    // 断られた理由はスクリプトにも人にも要るので、format に依らず daemon の言葉で出す。
    for (const format of ["json", "text"]) {
      const refusal = {
        ok: false,
        error: { code: "bad_request", msg: "op 'agents' requires user role" },
      };
      const peer = daemon(() => refusal);
      const r = await runCli(["agents", "--format", format], envFor(peer));
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      const printedErr = parseWith(JsonTextSchema, r.err);
      expect(printedErr.ok && printedErr.value).toEqual(refusal);
    }
  });

  test("--format が json / text 以外、または余計な引数は、daemon に繋がず usage を出して exit 1", async () => {
    // 位置引数で絞る口 (peers の cwd のような) は持たない: 絞りは JSON を読む側でできる。
    for (const [args, message] of [
      [["agents", "--format", "table"], "--format must be 'json' or 'text' (got 'table')"],
      [["agents", "some-cwd"], 'unexpected argument "some-cwd"'],
    ] as const) {
      const peer = daemon(() => ROWS);
      const r = await runCli([...args], envFor(peer));
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain(message);
      expect(r.err).toContain("usage: ccmsg agents [--format <json|text>]");
      expect(peer.requests).toEqual([]);
    }
  });
});

describe("agentsTable (--format text の表)", () => {
  test("列は端末上の幅で揃え (絵文字・全角は 2 桁)、最後の列は埋めない。無い値は -", () => {
    // 列: SESSION / STATUS (Claude Code の言葉、waiting なら何を待つか) / TURN (module が
    // 言った main thread の turn、module の無いセッションは -) / NAME / CONFIG DIR / CWD。
    // NAME の 🤖検証 は端末で 6 桁を取り、文字数 (UTF-16 の長さ 4) で揃えると次の列がずれる。
    // 行の末尾に空白を残さない: 最後の列 (CWD) は長さがまちまちで、埋めても揃わない。
    const lines = agentsTable(ROWS, HOME).split("\n");
    expect(lines.at(-1)).toBe("");
    for (const line of lines) expect(line).toBe(line.trimEnd());
    const startOf = (line: string, cell: string): number =>
      Bun.stringWidth(line.slice(0, line.indexOf(cell)));
    expect(startOf(lines[0] ?? "", "CONFIG DIR")).toBe(
      startOf(lines[1] ?? "", "~/.claude-personal"),
    );
    expect(startOf(lines[1] ?? "", "~/.claude-personal")).toBe(
      startOf(lines[2] ?? "", "/etc/claude"),
    );
    expect(lines[2]).toContain("waiting (dialog open)  -           -  ");
  });

  test("HOME 配下のパスだけを ~ で書く (HOME と前方一致するだけの別ディレクトリは書き換えない)", () => {
    const row = (cwd: string): AgentsResponse => ({
      ok: true,
      agents: [{ ...WAITING, cwd }],
      polled_at: ROWS.polled_at,
    });
    const cwdOf = (out: string): string => out.split("\n")[1]?.split("  ").at(-1) ?? "";
    expect(cwdOf(agentsTable(row(HOME), HOME))).toBe("~");
    expect(cwdOf(agentsTable(row(`${HOME}/a b`), HOME))).toBe("~/a b");
    expect(cwdOf(agentsTable(row(`${HOME}2/x`), HOME))).toBe(`${HOME}2/x`);
    // HOME が / の環境では全パスが HOME 配下になるが、~ にすると読めなくなるので書き換えない。
    expect(cwdOf(agentsTable(row("/srv/x"), "/"))).toBe("/srv/x");
  });

  test("行が無い時は、なぜ無いかの 1 行 (daemon がまだ読んでいないのか、セッションが無いのか)", () => {
    // polled_at が null = daemon が起動直後でまだ 1 回も session の記録を読んでいない。
    // その時の「無い」はセッションが無いという意味ではないので、言い分ける。
    expect(agentsTable({ ok: true, agents: [], polled_at: null }, HOME)).toBe(
      "The daemon has not read the session records yet; run this again in a moment.\n",
    );
    expect(agentsTable({ ok: true, agents: [], polled_at: ROWS.polled_at }, HOME)).toBe(
      "No Claude Code session is running in the config dirs the daemon serves.\n",
    );
  });
});
