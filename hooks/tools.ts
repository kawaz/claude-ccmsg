// An agent uses ccmsg through four tools the module registers at
// session.start (DR-0039 §3): `send` (to other sessions, named by any of
// their id, directory, name and process, in any config home), `say` (to the
// person, by voice and in the webui), `peers` (who `send` can reach) and
// `launch` (start a session through the configured launch command, DR-0018
// §3.7). Each is answered here without `next`: `send`, `peers` and `launch`
// through `ccmsg sidecar send-message` / `peer-list` / `launch`, `say`
// through `ccmsg say`, the result always a text the model reads. SendMessage
// is left to the harness.
import * as v from "valibot";
import {
  LaunchInputSchema,
  LaunchToolFieldsSchema,
  launchErrorText,
  SessionLaunchResponseTextSchema,
} from "@ccmsg/protocol/launch";
import { errorText, parseWith } from "@ccmsg/protocol/parse";
import {
  PeerListResponseTextSchema,
  PeersToolInputSchema,
  RefusalTextSchema,
  SayToolInputSchema,
  SendMessageResponseTextSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";
import { peersText, sendResultText, UNCONFIRMED_ADVICE } from "@ccmsg/protocol/peer-tools-text";
import type { Engine, On } from "./engine.ts";
import type { LifecycleState } from "./session-lifecycle.ts";
import { toolInputSchemas } from "./tool-input-schemas.ts" with { type: "macro" };

/** `send` budget: the `ccmsg sidecar send-message` process, the daemon reading
 * the runs (within 1 s), and every run's write (2 s) and refusal window
 * (0.25 s), the runs in parallel — about 5 s at worst, with the rest left for
 * a daemon the command has to start. The wait is the process's, which the
 * hook's budget does not count (DR-0039 §3); past it the send is answered as
 * unconfirmed. */
export const SEND_TIMEOUT_MS = 10_000;
/** `peers` budget: the process and the daemon reading the runs. */
export const PEERS_TIMEOUT_MS = 5_000;
/** `say` budget: `ccmsg say` records the say and then speaks, and returns
 * when the speech ends, so a long text takes as long as it is to say. */
export const SAY_TIMEOUT_MS = 120_000;
/** `launch` budget (DR-0018 §3.7): the launch command's longest wait
 * (`timeout_seconds`, at most 50 s) + the kill grace (0.5 s) + the wait for
 * its pipes' EOF (0.5 s) + a daemon `ccmsg sidecar launch` has to start (its
 * connect retries, about 10 s) + writing the output aside, with what is left
 * for the process itself. register.test.ts pins the sum below it. */
export const LAUNCH_TIMEOUT_MS = 65_000;

/** The tools' input schemas for the model, derived from the schemas their
 * handlers read the inputs with when the module is bundled (a macro). */
const TOOL_INPUT_SCHEMAS = toolInputSchemas();

/** Register the tools. Deferred, with descriptions kept short: subagents and
 * teammates see them too, and how to use them is the plugin's skill's to say
 * (DR-0039 §3). A registration that fails is logged; the session goes on
 * without that tool. */
async function registerTools($: Engine): Promise<void> {
  const registered = await Promise.allSettled([
    $.tool.register({
      name: "send",
      description: "Send a message to other Claude Code sessions (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.send,
      isDeferred: true,
    }),
    $.tool.register({
      name: "say",
      description: "Tell the person something by voice (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.say,
      isDeferred: true,
    }),
    $.tool.register({
      name: "peers",
      description: "List the sessions send can reach (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.peers,
      isDeferred: true,
    }),
    // The one sentence of use kept here: reading exit_code 0 as "the session
    // is up" goes straight into a wrong report (DR-0018 §3.7).
    $.tool.register({
      name: "launch",
      description:
        "Start a Claude Code session through the configured launch command (see the ccmsg skill). exit_code 0 means the launch command finished normally, not that the session is up; check that with peers.",
      inputSchema: TOOL_INPUT_SCHEMAS.launch,
      isDeferred: true,
    }),
  ]);
  for (const outcome of registered) {
    if (outcome.status === "rejected") {
      $.ui.log(`ccmsg: a tool was not registered: ${errorText(outcome.reason)}`, { to: "debug" });
    }
  }
}

/** `ccmsg sidecar send-message` / `peer-list` / `launch` for session `sid`: the
 * input goes on standard input, for the reason a reply does (sidecar.ts). */
export function toolArgv(
  root: string,
  command: "send-message" | "peer-list" | "launch",
  sid: string,
): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", command, "--sid", sid];
}

/** What a tool says when its input is not the tool's. */
function notTheInput(tool: string, summary: string): string {
  return `${tool} の入力が形に合わないので何もしていない: ${summary}`;
}

/** The `send` tool: send the text to the sessions the input names, and say
 * what came of it for each. Never rejects. */
async function sendTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(SendToolInputSchema, e);
  if (!read.ok) return notTheInput("send", read.failure.summary);
  const { text, agent_id, ...to } = read.value;
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await $.process.run(toolArgv($.plugin.root, "send-message", await $.session.id()), {
      stdin: JSON.stringify({ to, ...(agent_id !== undefined ? { agent_id } : {}), text }),
      timeoutMs: SEND_TIMEOUT_MS,
    });
  } catch (error) {
    $.ui.log(`ccmsg: send failed: ${errorText(error)}`, { to: "debug" });
    return `ccmsg sidecar send-message が ${String(SEND_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できず、届いたか確かめられなかった: ${errorText(error)}。${UNCONFIRMED_ADVICE}`;
  }
  const answered = parseWith(SendMessageResponseTextSchema, run.stdout);
  if (answered.ok) return sendResultText(answered.value.results);
  $.ui.log(`ccmsg: send exited ${String(run.exitCode)}: ${run.stderr.trim()}`, { to: "debug" });
  const said = firstStderrLine(run.stderr);
  // 3: no daemon could be had, so nothing went out.
  if (run.exitCode === 3) {
    return `ccmsg の daemon に繋がらず、送っていない: ${said}。少し置いて一度だけ送り直す`;
  }
  // The daemon refuses a send before it writes to any session; only an op
  // that threw (`internal`) may have stopped part way.
  const refusal = parseWith(RefusalTextSchema, said);
  if (refusal.ok && refusal.value.error.code !== "internal") {
    return `ccmsg の daemon が送信を断ったので、送っていない: ${refusal.value.error.msg}`;
  }
  const why = refusal.ok ? refusal.value.error.msg : said;
  return `ccmsg が送信の結果を返さず、届いたか確かめられなかった${why !== "" ? `: ${why}` : ""}。${UNCONFIRMED_ADVICE}`;
}

/** The first line a ccmsg command wrote to standard error. */
function firstStderrLine(stderr: string): string {
  return stderr.trim().split("\n")[0] ?? "";
}

/** A ccmsg command's reason for failing, in words: the daemon's `msg` when
 * the command printed its refusal, the command's own first line otherwise. */
function failureText(stderr: string): string {
  const said = firstStderrLine(stderr);
  const refusal = parseWith(RefusalTextSchema, said);
  return refusal.ok ? refusal.value.error.msg : said;
}

/** The `say` tool: say the text to the person through `ccmsg say`, which
 * records it for the webui (📣) and speaks it. Never rejects. */
async function sayTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(SayToolInputSchema, e);
  if (!read.ok) return notTheInput("say", read.failure.summary);
  try {
    const sid = await $.session.id();
    const run = await $.process.run([`${$.plugin.root}/bin/ccmsg`, "say", read.value.text], {
      env: { CCMSG_SID: sid },
      timeoutMs: SAY_TIMEOUT_MS,
    });
    if (run.exitCode === 0) return "伝えた (音声と webui の 📣)";
    return `say が失敗した (exit ${String(run.exitCode)}): ${run.stderr.trim().split("\n")[0] ?? ""}`;
  } catch (error) {
    return `say を起こせなかったか ${String(SAY_TIMEOUT_MS / 1000)} 秒以内に終わらなかった: ${errorText(error)}`;
  }
}

/** The `peers` tool: the sessions `send` can reach, spelled as it takes them.
 * Never rejects. */
async function peersTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(PeersToolInputSchema, e);
  if (!read.ok) return notTheInput("peers", read.failure.summary);
  try {
    const run = await $.process.run(toolArgv($.plugin.root, "peer-list", await $.session.id()), {
      stdin: JSON.stringify(read.value),
      timeoutMs: PEERS_TIMEOUT_MS,
    });
    const answered = parseWith(PeerListResponseTextSchema, run.stdout);
    if (answered.ok) return peersText(answered.value.peers);
    return `一覧を返せなかった: ${failureText(run.stderr)}`;
  } catch (error) {
    return `一覧を返せなかった: ${errorText(error)}`;
  }
}

/** A `tool.call` of `launch`, read for the tool's fields alone. The engine
 * puts its own fields beside the input (the tool's name, the call's id, on a
 * subagent's call its agent id, and whatever it adds later); a non-strict
 * object of the tool's fields leaves every other field out.
 *
 * Design rationale: the input is picked out by the tool's fields rather than
 * the engine's fields taken off by name, so a field the engine adds does not
 * make every call unreadable. A field the model wrote outside the tool's
 * fields is dropped with them; the schema it is shown refuses one
 * (`additionalProperties: false`). */
const LaunchToolCallSchema = v.object(LaunchToolFieldsSchema.entries);

const LAUNCH_UNCONFIRMED = "起動したか確かめられなかった。`peers` で確かめる";

/** The `launch` tool: start a session through `ccmsg sidecar launch`, which
 * asks the daemon to run the configured launch command, and answer what the
 * command did as JSON. Never rejects. */
async function launchTool<E>($: Engine, e: E): Promise<string> {
  const call = parseWith(LaunchToolCallSchema, e);
  if (!call.ok) return notTheInput("launch", call.failure.summary);
  // The combinations claude refuses are LaunchInputSchema's checks.
  const read = parseWith(LaunchInputSchema, call.value);
  if (!read.ok) return notTheInput("launch", read.failure.summary);
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await $.process.run(toolArgv($.plugin.root, "launch", await $.session.id()), {
      stdin: JSON.stringify(read.value),
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
  } catch (error) {
    $.ui.log(`ccmsg: launch failed: ${errorText(error)}`, { to: "debug" });
    return `ccmsg sidecar launch が ${String(LAUNCH_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できなかった: ${errorText(error)}。${LAUNCH_UNCONFIRMED}`;
  }
  const answered = parseWith(SessionLaunchResponseTextSchema, run.stdout);
  if (answered.ok) {
    const { ok: _ok, ...result } = answered.value;
    return JSON.stringify(result);
  }
  $.ui.log(`ccmsg: launch exited ${String(run.exitCode)}: ${run.stderr.trim()}`, { to: "debug" });
  const said = firstStderrLine(run.stderr);
  // 3: no daemon could be had, so nothing was asked to start.
  if (run.exitCode === 3) return `ccmsg の daemon に繋がらず、起動していない: ${said}`;
  const refusal = parseWith(RefusalTextSchema, said);
  if (refusal.ok) {
    const failed = launchErrorText(refusal.value.error);
    return failed.started === "no" ? failed.text : `${failed.text}。\`peers\` で確かめる`;
  }
  return `ccmsg が起動の結果を返さなかった${said !== "" ? `: ${said}` : ""}。${LAUNCH_UNCONFIRMED}`;
}

/** At session.start: register the tools, awaited so they are listed by the
 * first turn. `-p` and the SDK get none: talking with other sessions from
 * there is not a use ccmsg serves (DR-0039 §3). Registrations outlive /clear
 * and /resume, so this is the one place. */
export async function toolsAtStart(
  $: Engine,
  state: Pick<LifecycleState, "interactive">,
): Promise<void> {
  if (state.interactive) await registerTools($);
}

/** The tools' calls, each by its tool's name. */
export function registerToolCalls(on: On): void {
  // The tools answer without `next`, which would only reach core's "no
  // tool.call hook answered". A handler settles every failure as a text; the
  // `.catch` answers one that overran its budget the same way.
  on("tool.call", { tool: "mcp__ccmsg-v1__send" }, async ($, e) => ({
    result: await sendTool($, e),
  })).catch(async () => ({
    result: `ccmsg の send が途中で止まり、届いたか確かめられなかった。${UNCONFIRMED_ADVICE}`,
  }));
  on("tool.call", { tool: "mcp__ccmsg-v1__say" }, async ($, e) => ({
    result: await sayTool($, e),
  })).catch(async () => ({ result: "ccmsg の say が途中で止まった。伝わったかは分からない" }));
  on("tool.call", { tool: "mcp__ccmsg-v1__peers" }, async ($, e) => ({
    result: await peersTool($, e),
  })).catch(async () => ({ result: "ccmsg の peers が途中で止まり、一覧を返せなかった" }));
  on("tool.call", { tool: "mcp__ccmsg-v1__launch" }, async ($, e) => ({
    result: await launchTool($, e),
  })).catch(async () => ({ result: `ccmsg の launch が途中で止まった。${LAUNCH_UNCONFIRMED}` }));
}
