// An agent uses ccmsg through three tools the module registers at
// session.start (DR-0039 §3): `send` (to other sessions, named by any of
// their id, directory, name and process, in any config home), `say` (to the
// person, by voice and in the webui) and `peers` (who `send` can reach). Each
// is answered here without `next`: `send` and `peers` through `ccmsg sidecar
// send-message` / `peer-list`, `say` through `ccmsg say`, the result always a
// text the model reads. SendMessage is left to the harness.
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
  ]);
  for (const outcome of registered) {
    if (outcome.status === "rejected") {
      $.ui.log(`ccmsg: a tool was not registered: ${errorText(outcome.reason)}`, { to: "debug" });
    }
  }
}

/** `ccmsg sidecar send-message` / `peer-list` for session `sid`: the input goes
 * on standard input, for the reason a reply does (sidecar.ts). */
export function peerArgv(
  root: string,
  command: "send-message" | "peer-list",
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
    run = await $.process.run(peerArgv($.plugin.root, "send-message", await $.session.id()), {
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
    const run = await $.process.run(peerArgv($.plugin.root, "peer-list", await $.session.id()), {
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
}
