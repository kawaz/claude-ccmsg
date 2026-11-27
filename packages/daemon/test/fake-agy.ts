// A stand-in for agy in stream-json (DR-0066 §14), run as `bun fake-agy.ts
// <agy's arguments>`: the lines and signals the measurements describe
// (A2, A4, A6, A10, A18, A21, A22, A23), so the daemon's side is tested
// without the real agy's quota.
//
// FAKE_AGY_MODE picks how it starts:
// - (unset): `init` after a moment, then one `result` per request, in order
// - `no_init`: never writes `init`
// - `fail_before_init`: a `result` with an empty conversation id, exit 1 (A23)
// - `other_id`: an `init` naming another conversation than `--conversation`
// FAKE_AGY_LOG, when set, gets one JSON line per start: the arguments, the
// environment's keys and the pid.
//
// A request's text steers its turn: `sleep:<ms>:…` takes that long, `big:<n>`
// answers n bytes. Anything else is echoed back.
import * as fs from "node:fs";
import * as v from "valibot";

const RequestLineSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ event: v.literal("user"), message: v.object({ content: v.string() }) }),
);

const args = process.argv.slice(2);
const at = args.indexOf("--conversation");
const resumed = at >= 0 ? args[at + 1] : undefined;
const id =
  process.env.FAKE_AGY_MODE === "other_id"
    ? "another-conversation"
    : (resumed ?? `fake-${String(process.pid)}-${String(Date.now())}`);
const log = process.env.FAKE_AGY_LOG;
if (log !== undefined) {
  fs.appendFileSync(
    log,
    `${JSON.stringify({ args, env: Object.keys(process.env), pid: process.pid })}\n`,
  );
}

function out(line: object): void {
  fs.writeSync(1, `${JSON.stringify(line)}\n`);
}

let inputTokens = Number(process.env.FAKE_AGY_TOKENS_BEFORE ?? "0");
let turns = 0;

function result(fields: object): void {
  out({
    event: "result",
    result: {
      conversation_id: id,
      duration_seconds: 1.5,
      num_turns: turns,
      usage: { input_tokens: inputTokens, cache_read_tokens: 7 },
      ...fields,
    },
  });
}

if (process.env.FAKE_AGY_MODE === "fail_before_init") {
  out({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: "authentication failed or timed out",
      finished_reason: "error",
    },
  });
  fs.writeSync(2, "Error: authentication required. Run 'antigravity' to log in, then retry.\n");
  process.exit(1);
}

let running = false;
process.on("SIGINT", () => {
  if (running) {
    result({ status: "ERROR", error: "interrupted", finished_reason: "interrupted", response: "" });
  }
  fs.writeSync(2, "error: interrupted\n");
  process.exit(1);
});

async function answer(prompt: string): Promise<void> {
  running = true;
  turns += 1;
  inputTokens += 100;
  const sleep = /^sleep:(\d+):/.exec(prompt);
  if (sleep !== null) await Bun.sleep(Number(sleep[1]));
  out({ event: "step_update", step_type: "agent_response", state: "DONE" });
  const big = /^big:(\d+)$/.exec(prompt);
  const response = big !== null ? "x".repeat(Number(big[1])) : `echo:${prompt}`;
  result({ status: "SUCCESS", response });
  running = false;
}

async function main(): Promise<void> {
  if (process.env.FAKE_AGY_MODE !== "no_init") {
    await Bun.sleep(20);
    out({ event: "init", conversation_id: id, cwd: process.cwd() });
  }
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    rest += new TextDecoder().decode(chunk);
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const request = v.parse(RequestLineSchema, line);
      await answer(request.message.content);
    }
  }
  process.exit(0);
}

void main();
