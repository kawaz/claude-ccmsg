// The Status tab's input to a running subagent (DR-0039 §6): the subagents
// running a turn, which one the text goes to, the note that it grants
// nothing, and what came of a send.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInputResponse, ErrorResponse, SessionSubagent } from "@ccmsg/protocol";
import {
  AGENT_INPUT_NOTE,
  classifyAgentInputReply,
  subagentLabel,
} from "../src/client/components/agent-input.ts";
import { SubagentInput } from "../src/client/components/SubagentInput.tsx";
import { instanceOf } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

const A: SessionSubagent = {
  id: "a1",
  description: "調査",
  type: "Explore",
  since: "2026-10-15T00:00:00.000Z",
};
const B: SessionSubagent = { id: "b2" };

describe("subagentLabel / classifyAgentInputReply", () => {
  test("a row names the type and the task, and when its turn started if known", () => {
    expect(subagentLabel(A, Date.parse("2026-10-15T00:03:30.000Z"))).toBe(
      "Explore · 調査 — turn の途中 (開始から 3 分)",
    );
    // A start the module did not see is not guessed.
    expect(subagentLabel(B, 0)).toBe("b2 — turn の途中");
  });

  test("only appended clears the text; a stopped subagent says so", () => {
    expect(classifyAgentInputReply({ ok: true, outcome: "appended" })).toEqual({
      kind: "appended",
    });
    const stopped = classifyAgentInputReply({
      ok: true,
      outcome: "not_delivered",
      reason: "not_running",
    });
    expect(stopped.kind).toBe("not_delivered");
    expect(stopped.kind === "not_delivered" ? stopped.text : "").toContain("もう走っていない");
    const lost: ErrorResponse = { ok: false, error: { code: "request_timeout", msg: "m" } };
    expect(classifyAgentInputReply(lost).kind).toBe("unconfirmed");
  });
});

async function mount(
  subagents: readonly SessionSubagent[] | undefined,
  answer: AgentInputResponse,
): Promise<{ root: HTMLElement; sent: [string, string][] }> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  const sent: [string, string][] = [];
  await act(() =>
    render(
      h(SubagentInput, {
        subagents,
        onSend: async (agentId, text) => {
          sent.push([agentId, text]);
          return answer;
        },
      }),
      root,
    ),
  );
  return { root, sent };
}

async function type(root: HTMLElement, text: string): Promise<void> {
  const area = instanceOf(root.querySelector("textarea"), HTMLTextAreaElement, "textarea");
  area.value = text;
  await act(() => {
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(root: HTMLElement): Promise<void> {
  const button = instanceOf(root.querySelector("button"), HTMLButtonElement, "send");
  await act(async () => {
    button.click();
  });
}

describe("SubagentInput", () => {
  test("nothing for a session whose module says nothing of its subagents", async () => {
    const { root } = await mount(undefined, { ok: true, outcome: "appended" });
    expect(root.textContent).toBe("");
  });

  test("the only running subagent is the target; appended clears the text", async () => {
    const { root, sent } = await mount([A], { ok: true, outcome: "appended" });
    expect(root.textContent).toContain(AGENT_INPUT_NOTE);
    await type(root, "その方針で");
    await press(root);
    expect(sent).toEqual([["a1", "その方針で"]]);
    expect(instanceOf(root.querySelector("textarea"), HTMLTextAreaElement, "t").value).toBe("");
    expect(root.textContent).toContain("subagent の会話に足した");
  });

  // With several running, nothing is sent until one is chosen.
  test("with several, the one chosen is the target; a stopped one keeps the text", async () => {
    const { root, sent } = await mount([A, B], {
      ok: true,
      outcome: "not_delivered",
      reason: "not_running",
    });
    await type(root, "x");
    expect(instanceOf(root.querySelector("button"), HTMLButtonElement, "send").disabled).toBe(true);
    const radios = root.querySelectorAll("input[type=radio]");
    await act(() => {
      instanceOf(radios[1] ?? null, HTMLInputElement, "radio").click();
    });
    await press(root);
    expect(sent).toEqual([["b2", "x"]]);
    expect(instanceOf(root.querySelector("textarea"), HTMLTextAreaElement, "t").value).toBe("x");
    expect(root.textContent).toContain("この subagent はもう走っていない");
  });

  test("no subagent running a turn says so", async () => {
    const { root } = await mount([], { ok: true, outcome: "appended" });
    expect(root.textContent).toContain("turn の途中の subagent なし");
  });
});
