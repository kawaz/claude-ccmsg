// agy's conversations in the daemon (DR-0066 §4〜§10, §14), with
// test/fake-agy.ts as `agy.command`: the real agy uses its quota.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import {
  type AgyDelivery,
  AgyConversations,
  type AgyDeps,
  type AgyProcessView,
  type AgyTo,
  placeholderProcessView,
} from "../src/agy.ts";

const FAKE_AGY = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));

/** One delivery the daemon asked for: where, under which mark, what. */
interface Delivered {
  to: AgyTo;
  mark: string;
  body: string;
}

/** The deliveries, awaited as they come (no time is waited on). */
class Deliveries {
  readonly got: Delivered[] = [];
  private waiters: { n: number; resolve: () => void }[] = [];
  answer: AgyDelivery = { delivered: true };

  /** A waiter is let go after the daemon took the answer in (a macrotask
   * later: what the daemon does with the answer before its next await is
   * then done), so a test reads what the delivery came to. */
  deliver = async (to: AgyTo, mark: string, body: string): Promise<AgyDelivery> => {
    this.got.push({ to, mark, body });
    const ready = this.waiters.filter((w) => this.got.length >= w.n);
    this.waiters = this.waiters.filter((w) => this.got.length < w.n);
    setImmediate(() => {
      for (const w of ready) w.resolve();
    });
    return this.answer;
  };

  /** Resolves once `n` deliveries have come. */
  until(n: number): Promise<void> {
    if (this.got.length >= n) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push({ n, resolve });
    return promise;
  }
}

const BodySchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({
    seq: v.number(),
    status: v.optional(v.string()),
    response: v.optional(v.string()),
    error: v.optional(v.string()),
    finished_reason: v.optional(v.string()),
    usage: v.optional(v.record(v.string(), v.number())),
    usage_total: v.optional(v.record(v.string(), v.number())),
  }),
);
function body(d: Delivered | undefined) {
  return v.parse(BodySchema, d?.body ?? "");
}

const StartSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ args: v.array(v.string()), env: v.array(v.string()), pid: v.number() }),
);

/** The part of a conversation's record the §10 test rewrites. */
const RecordSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({ ended_runs: v.optional(v.record(v.string(), v.string())) }),
);

let root: string;
let workDir: string;
let startLog: string;
let deliveries: Deliveries;
const made: AgyConversations[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agy-test-"));
  workDir = path.join(root, "work");
  fs.mkdirSync(workDir);
  startLog = path.join(root, "starts.jsonl");
  deliveries = new Deliveries();
});

afterEach(async () => {
  const left = made.splice(0);
  // As a daemon ends: the output reads stop, so a next daemon's reading on
  // (§10) writes nothing once the test is over.
  for (const conversations of left) await conversations.shutdown();
  for (const conversations of left) {
    for (const pid of conversations.livePids()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  // The ends of the processes stopped above are recorded before the state
  // dir goes, so nothing is written into it after.
  for (const conversations of left) await conversations.endsRecorded();
  fs.rmSync(root, { recursive: true, force: true });
});

function starts() {
  if (!fs.existsSync(startLog)) return [];
  return fs
    .readFileSync(startLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => v.parse(StartSchema, line));
}

function conversations(
  over: Partial<AgyDeps> & { env?: Record<string, string> } = {},
): AgyConversations {
  const { env, ...rest } = over;
  const made1 = new AgyConversations({
    dir: path.join(root, "state", "agy"),
    config: {
      command: [process.execPath, FAKE_AGY],
      clean_env: ["CLAUDE*", "ANTHROPIC_*", "AI_AGENT"],
      keep_env: ["CLAUDE_CONFIG_DIR"],
    },
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_AGY_LOG: startLog, ...env },
    now: () => Date.now(),
    log: { info: () => {}, error: () => {} },
    deliver: deliveries.deliver,
    processes: placeholderProcessView(),
    ...rest,
  });
  made.push(made1);
  return made1;
}

async function newRun(c: AgyConversations, prompt = "hello", extra: object = {}) {
  const run = await c.run(
    "sid-1",
    { prompt, model: "gemini-3.8-flash", ...extra },
    undefined,
    workDir,
  );
  if (!run.ok) throw new Error(`run refused: ${run.code} ${run.msg}`);
  return run.value;
}

/** The files the conversation's directory holds, below it. */
function filesOf(agyid: string): string[] {
  const dir = path.join(root, "state", "agy", agyid);
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

async function waitGone(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = (): void => {
      try {
        process.kill(pid, 0);
        setImmediate(check);
      } catch {
        resolve();
      }
    };
    check();
  });
}

describe("run (§6)", () => {
  test("a new conversation: agy's own id, seq 1, the response appended under the mark", async () => {
    const c = conversations();
    const taken = await newRun(c);
    expect(taken.seq).toBe(1);
    expect(taken.ahead).toBe(0);
    expect(taken.agyid).toStartWith("fake-");
    await deliveries.until(1);
    const [d] = deliveries.got;
    expect(d?.to).toEqual({ sid: "sid-1" });
    expect(d?.mark).toBe(`agyid:${taken.agyid} から:`);
    expect(body(d)).toEqual({
      seq: 1,
      at: expect.any(String),
      status: "SUCCESS",
      response: "echo:hello",
    });
  });

  test("agy is started with stream-json, full permission, the model, and effort only when written (§2)", async () => {
    const c = conversations();
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    await newRun(c, "a");
    await newRun(c, "b", {
      effort: "low",
      dirs: [
        { path: workDir, write: true },
        { path: other, write: true },
      ],
    });
    const [first, second] = starts();
    expect(first?.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.8-flash",
    ]);
    expect(second?.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "low",
      "--add-dir",
      other,
    ]);
  });

  test("agy does not inherit the session's CLAUDE*, ANTHROPIC_* and AI_AGENT; CLAUDE_CONFIG_DIR stays", async () => {
    const c = conversations({
      env: {
        CLAUDE_CODE_SESSION_ID: "s",
        ANTHROPIC_API_KEY: "k",
        AI_AGENT: "claude",
        CLAUDE_CONFIG_DIR: "/c",
      },
    });
    await newRun(c);
    const env = starts()[0]?.env ?? [];
    expect(env).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).not.toContain("AI_AGENT");
    expect(env).toContain("CLAUDE_CONFIG_DIR");
  });

  test("runs of one conversation go to its one process in order, even when asked at once (§6, A3)", async () => {
    const c = conversations();
    const first = await newRun(c, "sleep:200:one");
    const more = await Promise.all(
      ["two", "three"].map((prompt) =>
        c.run("sid-2", { agyid: first.agyid, prompt }, "agent-1", workDir),
      ),
    );
    expect(more.map((m) => (m.ok ? [m.value.seq, m.value.ahead] : m.code))).toEqual([
      [2, 1],
      [3, 2],
    ]);
    await deliveries.until(3);
    expect(starts()).toHaveLength(1);
    expect(deliveries.got.map((d) => [d.to, body(d).response])).toEqual([
      [{ sid: "sid-1" }, "echo:sleep:200:one"],
      [{ sid: "sid-2", agentId: "agent-1" }, "echo:two"],
      [{ sid: "sid-2", agentId: "agent-1" }, "echo:three"],
    ]);
  });

  test("refusals start nothing: no agy section, an unknown agyid, a dirs entry the host cannot keep, a cwd that is not a directory", async () => {
    const none = conversations({ config: undefined });
    const a = await none.run("s", { prompt: "p", model: "m" }, undefined, workDir);
    expect(a.ok ? "ok" : a.code).toBe("agy_not_configured");
    const c = conversations();
    const b = await c.run("s", { agyid: "never-seen", prompt: "p" }, undefined, workDir);
    expect(b.ok ? "ok" : b.code).toBe("agy_unknown_conversation");
    for (const dirs of [
      [{ path: workDir, write: false }],
      [{ path: workDir, write: true, containerpath: "/w" }],
    ]) {
      const d = await c.run("s", { prompt: "p", model: "m", dirs }, undefined, workDir);
      expect(d.ok ? "ok" : d.code).toBe("agy_dirs_unsupported");
    }
    const e = await c.run(
      "s",
      { prompt: "p", model: "m", cwd: path.join(root, "none") },
      undefined,
      workDir,
    );
    expect(e.ok ? "ok" : e.code).toBe("invalid_args");
    expect(starts()).toHaveLength(0);
  });

  test("agy that fails before init: not started, with what agy said (A23)", async () => {
    const c = conversations({ env: { FAKE_AGY_MODE: "fail_before_init" } });
    const run = await c.run("s", { prompt: "p", model: "m" }, undefined, workDir);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.code).toBe("agy_not_started");
      expect(run.msg).toContain("authentication failed or timed out");
      expect(run.msg).toContain("authentication required");
    }
    expect(c.livePids()).toEqual([]);
  });

  test("no init within the wait: the start is stopped and refused", async () => {
    const c = conversations({ env: { FAKE_AGY_MODE: "no_init" }, initWaitMs: 300 });
    const run = await c.run("s", { prompt: "p", model: "m" }, undefined, workDir);
    expect(run.ok ? "ok" : run.code).toBe("agy_not_started");
    // The group was sent SIGTERM: the stand-in ends.
    await waitGone(starts()[0]?.pid ?? 0);
  });
});

describe("a conversation without a process (§6, §10)", () => {
  test("goes on in a new process started with --conversation and the record's model and effort (K4)", async () => {
    const first = conversations();
    const taken = await newRun(first, "a", { effort: "high" });
    await deliveries.until(1);
    await first.shutdown();
    await waitGone(starts()[0]?.pid ?? 0);
    const second = conversations();
    await second.load();
    const run = await second.run("s", { agyid: taken.agyid, prompt: "b" }, undefined, workDir);
    expect(run.ok ? run.value.seq : run.code).toBe(2);
    await deliveries.until(2);
    const resumed = starts()[1]?.args ?? [];
    expect(resumed).toContain("--conversation");
    expect(resumed).toContain(taken.agyid);
    const at = resumed.indexOf("--model");
    expect(resumed.slice(at, at + 4)).toEqual(["--model", "gemini-3.8-flash", "--effort", "high"]);
  });

  test("a resume whose init names another conversation is stopped and refused (A1)", async () => {
    const first = conversations();
    const taken = await newRun(first, "a");
    await deliveries.until(1);
    await first.shutdown();
    await waitGone(starts()[0]?.pid ?? 0);
    const second = conversations({ env: { FAKE_AGY_MODE: "other_id" } });
    await second.load();
    const run = await second.run("s", { agyid: taken.agyid, prompt: "b" }, undefined, workDir);
    expect(run.ok ? "ok" : run.code).toBe("agy_conversation_mismatch");
  });

  // A daemon taking over reads on while the one before it may still be
  // writing a record: only the writes of processes gone are cleared.
  test("load removes the left writes of processes gone and keeps a running one's", async () => {
    const writing = path.join(root, "state", "agy", ".writing");
    fs.mkdirSync(writing, { recursive: true });
    const running = `x_conversation.json.${String(process.pid)}-0a0b0c0d.tmp`;
    const gone = "y_conversation.json.2147483646-0a0b0c0d.tmp";
    const unnamed = "z_conversation.json.tmp";
    for (const name of [running, gone, unnamed]) fs.writeFileSync(path.join(writing, name), "{}");
    await conversations().load();
    expect(fs.readdirSync(writing)).toEqual([running]);
  });
});

describe("responses (§7)", () => {
  test("a response of 4096 bytes or more is kept in a file and delivered as its path (Q7)", async () => {
    const c = conversations();
    const taken = await newRun(c, "big:4096");
    await deliveries.until(1);
    const response = body(deliveries.got[0]).response ?? "";
    expect(response).toMatch(/^output is 4096 bytes, file: \//);
    const file = response.replace(/^output is 4096 bytes, file: /, "");
    expect(fs.readFileSync(file, "utf8")).toBe("x".repeat(4096));
    expect(file.startsWith(path.join(root, "state", "agy", taken.agyid))).toBe(true);
  });

  test("a response not delivered is not delivered again, and status names its seq", async () => {
    deliveries.answer = { delivered: false, reason: "not_running" };
    const c = conversations();
    const taken = await newRun(c, "a");
    await deliveries.until(1);
    const status = await c.status("sid-1", { agyid: taken.agyid });
    expect(status.ok && "undelivered" in status.value ? status.value.undelivered : null).toEqual([
      1,
    ]);
    expect(deliveries.got).toHaveLength(1);
  });

  test("verbose: the request's own usage (the difference from the result before, Q20) and the conversation's total", async () => {
    const c = conversations();
    const taken = await newRun(c, "a", { verbose: true });
    await deliveries.until(1);
    await c.run("s", { agyid: taken.agyid, prompt: "b", verbose: true }, undefined, workDir);
    await deliveries.until(2);
    const second = body(deliveries.got[1]);
    expect(second.usage).toEqual({ input_tokens: 100, cache_read_tokens: 0 });
    expect(second.usage_total).toEqual({ input_tokens: 200, cache_read_tokens: 7 });
  });
});

describe("status (§8)", () => {
  test("process, pending, the latest result, and the details with verbose", async () => {
    const c = conversations();
    const taken = await newRun(c, "a", { effort: "low" });
    await deliveries.until(1);
    const one = await c.status("sid-1", { agyid: taken.agyid, verbose: true });
    expect(one.ok ? one.value : one.code).toMatchObject({
      agyid: taken.agyid,
      process: "running",
      pending: 0,
      undelivered: [],
      result: { seq: 1, status: "SUCCESS", response: "echo:a" },
      model: "gemini-3.8-flash",
      effort: "low",
      cwd: workDir,
      dirs: [{ path: workDir, write: true }],
      usage_total: { input_tokens: 100, cache_read_tokens: 7 },
    });
  });

  test("without an agyid: the asking session's conversations, newest first", async () => {
    const c = conversations();
    const a = await newRun(c, "a");
    const b = await newRun(c, "b");
    await c.run("other-sid", { prompt: "c", model: "m" }, undefined, workDir);
    const list = await c.status("sid-1", null);
    expect(
      list.ok && "conversations" in list.value ? list.value.conversations.map((x) => x.agyid) : [],
    ).toEqual([b.agyid, a.agyid]);
  });
});

describe("abort (§9)", () => {
  test("no turn: nothing is sent", async () => {
    let sent = 0;
    const view: AgyProcessView = {
      ...placeholderProcessView(),
      interrupt: async () => {
        sent += 1;
        return { sent: true };
      },
    };
    const c = conversations({ processes: view });
    const taken = await newRun(c, "a");
    await deliveries.until(1);
    const aborted = await c.abort(taken.agyid);
    expect(aborted.ok ? aborted.value.outcome : aborted.code).toBe("no_turn");
    expect(sent).toBe(0);
  });

  test("a turn under way: interrupted for the running request, not processed for the one behind it", async () => {
    const view: AgyProcessView = {
      ...placeholderProcessView(),
      interrupt: async (record) => {
        process.kill(-record.pid, "SIGINT");
        return { sent: true };
      },
    };
    const c = conversations({ processes: view });
    const taken = await newRun(c, "sleep:5000:a");
    await c.run("s", { agyid: taken.agyid, prompt: "b" }, undefined, workDir);
    const aborted = await c.abort(taken.agyid);
    expect(aborted.ok ? aborted.value.outcome : aborted.code).toBe("aborted");
    await deliveries.until(2);
    expect(body(deliveries.got[0])).toMatchObject({
      seq: 1,
      status: "ERROR",
      finished_reason: "interrupted",
    });
    expect(body(deliveries.got[1]).error).toContain("abort で処理されなかった");
  });

  test("a view that sends no signal answers unconfirmed and leaves the turn running", async () => {
    const c = conversations();
    const taken = await newRun(c, "sleep:300:a");
    const aborted = await c.abort(taken.agyid);
    expect(aborted.ok ? aborted.value.outcome : aborted.code).toBe("unconfirmed");
    await deliveries.until(1);
    expect(body(deliveries.got[0]).status).toBe("SUCCESS");
  });
});

describe("the daemon's end and the next daemon (§10)", () => {
  test("a turn under way at shutdown goes on, and the next daemon delivers its response", async () => {
    const first = conversations();
    const taken = await newRun(first, "sleep:400:a");
    await first.shutdown();
    expect(deliveries.got).toHaveLength(0);
    const second = conversations({
      processes: { ...placeholderProcessView(), survivor: async () => "alive" },
    });
    await second.load();
    await deliveries.until(1);
    expect(body(deliveries.got[0])).toMatchObject({ seq: 1, response: "echo:sleep:400:a" });
    expect(deliveries.got[0]?.mark).toBe(`agyid:${taken.agyid} から:`);
  });

  test("a request recorded but not known to be written ends as unconfirmed, neither done nor not done", async () => {
    const first = conversations();
    const taken = await newRun(first, "a");
    await deliveries.until(1);
    await first.shutdown();
    await waitGone(starts()[0]?.pid ?? 0);
    await first.endsRecorded();
    // What a daemon that fell between the record and the write leaves (§10).
    const dir = path.join(root, "state", "agy", taken.agyid);
    fs.writeFileSync(
      path.join(dir, "request-2.json"),
      JSON.stringify({
        seq: 2,
        received_at: new Date().toISOString(),
        to: { sid: "sid-1" },
        verbose: false,
        prompt_bytes: 1,
        written: "no",
      }),
    );
    const record = v.parse(
      RecordSchema,
      fs.readFileSync(path.join(dir, "conversation.json"), "utf8"),
    );
    const run = Object.keys(record.ended_runs ?? {})[0] ?? "";
    const offset = fs.statSync(path.join(dir, run, "stdout.jsonl")).size;
    fs.writeFileSync(
      path.join(dir, "conversation.json"),
      JSON.stringify({ ...record, process: { pid: 999_999, argv: [], run, offset } }),
    );
    const second = conversations();
    await second.load();
    await deliveries.until(2);
    expect(body(deliveries.got[1]).error).toContain("agy に書けたか確かめられなかった");
  });
});

describe("what is not kept (§14)", () => {
  test("no process without a run, no lock file, nothing kept to write later", async () => {
    const c = conversations();
    await c.load();
    expect(c.livePids()).toEqual([]);
    const taken = await newRun(c, "a");
    await deliveries.until(1);
    const unexpected = filesOf(taken.agyid).filter(
      (f) =>
        !/^(conversation\.json|request-\d+\.json|run-[\d-]+(\/(stdout\.jsonl|stderr))?)$/.test(f),
    );
    expect(unexpected).toEqual([]);
  });
});
