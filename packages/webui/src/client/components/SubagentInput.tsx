/** @jsxImportSource preact */
// Status タブの、走行中の subagent への入力 (DR-0039 §6)。
//
// session_status の `subagents` (module が turn.start / turn.complete で畳んだ、
// 今 turn の途中の subagent) から宛先を選び、書いた文を `agent_input` で送る。
// 文は subagent の次の request に「ユーザから (webui 経由)」として載り、本体には
// 載らない。足されるのは文脈であって権限ではないことを入力欄の近くに出す。
import { useState } from "preact/hooks";
import type { AgentInputResponse, ErrorResponse, SessionSubagent } from "@ccmsg/protocol";
import {
  AGENT_INPUT_NOTE,
  type AgentInputOutcome,
  classifyAgentInputReply,
  subagentLabel,
} from "./agent-input.ts";

export function SubagentInput({
  subagents,
  onSend,
}: {
  /** Absent for a session whose module says nothing of its subagents. */
  subagents: readonly SessionSubagent[] | undefined;
  onSend: (agentId: string, text: string) => Promise<AgentInputResponse | ErrorResponse>;
}) {
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<AgentInputOutcome | undefined>(undefined);
  if (subagents === undefined) return null;
  const now = Date.now();
  // The one chosen, or the only one there is. A chosen one that stopped is
  // not swapped for another: the text was written for it.
  const chosen =
    target !== undefined
      ? subagents.find((agent) => agent.id === target)
      : subagents.length === 1
        ? subagents[0]
        : undefined;
  const send = async (): Promise<void> => {
    if (chosen === undefined || text.trim() === "") return;
    setSending(true);
    setOutcome(undefined);
    let result: AgentInputOutcome;
    try {
      result = classifyAgentInputReply(await onSend(chosen.id, text));
    } catch {
      result = { kind: "failed", text: "daemon に繋がっていないため送れなかった。" };
    }
    setSending(false);
    setOutcome(result);
    if (result.kind === "appended") setText("");
  };
  return (
    <section class="status-section subagent-input">
      <h3 class="status-section-title">Subagent への入力</h3>
      {subagents.length === 0 ? (
        <p class="status-empty">turn の途中の subagent なし</p>
      ) : (
        <>
          <ul class="status-list">
            {subagents.map((agent) => (
              <li key={agent.id} class="status-row">
                <label>
                  <input
                    type="radio"
                    name="subagent-input-target"
                    checked={agent.id === chosen?.id}
                    onChange={() => setTarget(agent.id)}
                  />{" "}
                  <span class="status-row-summary" title={agent.id}>
                    {subagentLabel(agent, now)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p class="subagent-input-note">{AGENT_INPUT_NOTE}</p>
          <textarea
            class="subagent-input-text"
            aria-label="subagent への入力"
            value={text}
            disabled={sending}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <button
            type="button"
            class="subagent-input-send"
            disabled={sending || text.trim() === "" || chosen === undefined}
            onClick={() => void send()}
          >
            {sending ? "送信中…" : "送る"}
          </button>
        </>
      )}
      {target !== undefined && !subagents.some((agent) => agent.id === target) ? (
        <p class="subagent-input-result">選んだ subagent はもう走っていない。</p>
      ) : null}
      {outcome === undefined ? null : (
        <p class="subagent-input-result" data-outcome={outcome.kind}>
          {outcome.kind === "appended" ? "subagent の会話に足した。" : outcome.text}
        </p>
      )}
    </section>
  );
}
