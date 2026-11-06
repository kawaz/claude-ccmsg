// 🤖 バブルの名前の右に出す model / effort (kawaz 2026-11-06)。源は agent
// tree のノードで、名前で引く。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentTreeGroups, ErrorResponse } from "@ccmsg/protocol";
import { SystemMessageFold } from "../src/client/components/timeline/system-messages.tsx";
import { AgentEngineLabelsContext } from "../src/client/components/timeline/context.ts";
import { agentEngineLabelsByName } from "../src/client/components/agent-tree-view.ts";
import type { TranslationAvailability } from "../src/client/components/timeline/translation.ts";
import { withDom } from "./dom.ts";

withDom();

const unavailable: ErrorResponse = { ok: false, error: { code: "unavailable", msg: "test" } };
const noTranslation: TranslationAvailability = {
  host: false,
  browser: false,
  hostRequest: async () => unavailable,
};

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

function treeWith(node: AgentTreeGroups["agents"][number]): AgentTreeGroups {
  return { teammates: [], agents: [node], workflows: [] };
}

async function relayFrom(name: string, tree: AgentTreeGroups | undefined): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  container = root;
  await act(() =>
    render(
      h(
        AgentEngineLabelsContext.Provider,
        { value: agentEngineLabelsByName(tree) },
        h(SystemMessageFold, {
          kind: "peer-message",
          line: {
            kind: "turn",
            ts: null,
            role: "user",
            segments: [
              {
                kind: "text",
                role: "user",
                text: `<teammate-message teammate_id="${name}" summary="done">報告です。</teammate-message>`,
              },
            ],
          },
          translationAvailability: noTranslation,
          foldGroupOpen: true,
        }),
      ),
      root,
    ),
  );
  return root;
}

function engineOf(root: HTMLElement): string | null {
  return root.querySelector(".tl-bubble-agent .tl-agent-model-inline")?.textContent ?? null;
}

describe("agent bubble model / effort", () => {
  test("the running model and effort show beside the name", async () => {
    const root = await relayFrom(
      "permit-say-translate",
      treeWith({
        agent_id: "a1",
        name: "permit-say-translate",
        model: "fable[1m]",
        running_model: "claude-fable-5-1",
        effort: "low",
        kind: "subagent",
        spawn_depth: 0,
        state: "active",
        children: [],
      }),
    );
    expect(engineOf(root)).toBe("(fable-5-1/low)");
  });

  test("an agent the tree does not know shows nothing beside the name", async () => {
    const root = await relayFrom(
      "permit-say-translate",
      treeWith({
        agent_id: "a2",
        name: "someone-else",
        running_model: "claude-fable-5-1",
        effort: "low",
        kind: "subagent",
        spawn_depth: 0,
        state: "active",
        children: [],
      }),
    );
    expect(root.querySelector(".tl-bubble-agent")).not.toBeNull();
    expect(engineOf(root)).toBeNull();
  });
});
