// webui の入力欄 (FAB) から走行中の subagent に送った人の文が、その agent の
// TL にユーザの発言として出ることを、Timeline をマウントして固定する。
//
// 送った文の経路: 入力欄は op `user_message` を daemon に送り、daemon はサイド
// カーの依頼 `agent.append` でセッションの hooks module に渡し、module は
// `$.session.append({ message: { type: "user", content: [{ type: "text", text }] }, agentId })`
// で subagent の会話に足す。本文の頭には人の文である印 (`AGENT_APPEND_MARK`、
// 「ユーザから (ccmsg 経由):」の行) が付く。Claude Code はこれを subagent の
// transcript (`subagents/agent-<id>.jsonl`) に 1 行として書き、親のセッションの
// transcript には書かない。
//
// その行の形 (実 transcript で確かめた形。本文だけ作り物):
//   type:"user", isMeta:true, isSidechain:true, agentId, parentUuid (null でない),
//   promptId, origin:{ kind:"plugin", name:<plugin の名前> }, promptSource は無い,
//   message.content は text block 1 つの配列で、text は「印の行 + 改行 + 本文」。
// 人が端末やセッション本体宛ての入力欄で打った prompt の行 (origin.kind "human"、
// content は文字列) とは形が違い、isMeta の plugin の行は ccmsg の案内や他の
// plugin の注入にも使われる。人の文と分かるのは本文の頭の印だけ。
//
// 印の付いた行は、セッション本体に送った prompt と同じ吹き出し (右寄せの
// `.tl-bubble-right`) で、fold の外に出る。吹き出しには人が書いた本文だけを
// 出し、印の行は出さない (印は model に「task の外からの言葉」と読ませるための
// もので、人が書いた文ではない)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { AGENT_APPEND_MARK } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { useStoreState } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

const AGENT_ID = "a0123456789abcdef";
const AGENT: AgentRef = { agentId: AGENT_ID };

function TimelineOf({ agent }: { agent: AgentRef | null }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent,
    active: true,
    visible: true,
  });
}

/** `agent` の TL (null ならセッション本体の TL) を開き、初回の読み込みに
 * `lines` を返した状態の root。 */
async function openWith(lines: readonly string[], agent: AgentRef | null): Promise<HTMLElement> {
  const store = timelineStore(agent === null ? {} : { agent });
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, { agent }));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page(lines));
  return root;
}

/** subagent の transcript の行に付く field (全行が sidechain で agentId を持つ)。 */
const SIDECHAIN = { isSidechain: true, agentId: AGENT_ID };

/** subagent の transcript の先頭: Agent tool の spawn prompt (parentUuid が null)。 */
function spawnPromptRow(): string {
  return jsonl(
    userContentRow("調べて報告して", {
      ...SIDECHAIN,
      uuid: "00000000-0000-4000-8000-000000000101",
      parentUuid: null,
    }),
  );
}

/** module の `agent.append` が subagent の会話に足した、人の文の行。 */
function personMessageRow(body: string, uuid: string): string {
  return jsonl(
    userContentRow([textBlock(`${AGENT_APPEND_MARK}\n${body}`)], {
      ...SIDECHAIN,
      uuid,
      isMeta: true,
      origin: { kind: "plugin", name: "ccmsg" },
    }),
  );
}

/** 右寄せの吹き出し (ユーザの発言) の本文。 */
function userBubbleTexts(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".tl-bubble-right .tl-bubble-body")].map(
    (el) => el.textContent ?? "",
  );
}

describe("a person's message to a subagent shows in that agent's Timeline", () => {
  // 実 transcript の並び: subagent が tool を実行している間に人が送ると、module
  // が足した行は、その tool の tool_use の行と tool_result の行の間に書かれる。
  // その行が fold group (tool や thinking を畳む群) の中の system の行として
  // 沈むと、閉じた fold の中に隠れて、送った人には TL のどこにも見えない。
  test("the message is a user bubble of its own, showing what the person wrote without the mark", async () => {
    const root = await openWith(
      [
        spawnPromptRow(),
        jsonl(
          assistantContentRow([toolUseBlock("Bash", { command: "sleep 5" }, "tu_1")], SIDECHAIN),
        ),
        personMessageRow("その方針で進めて", "00000000-0000-4000-8000-000000000102"),
        jsonl(userContentRow([toolResultBlock("done", { tool_use_id: "tu_1" })], SIDECHAIN)),
        jsonl(assistantContentRow([textBlock("了解、進めます")], SIDECHAIN)),
      ],
      AGENT,
    );
    const bubbles = userBubbleTexts(root);
    expect(bubbles.some((text) => text.includes("その方針で進めて"))).toBe(true);
    expect(bubbles.some((text) => text.includes(AGENT_APPEND_MARK))).toBe(false);
  });

  // セッション本体の入力欄から送った prompt の行 (origin.kind "human"、文字列の
  // content) と同じ部品で描かれる: 同じ吹き出しの class に、同じ本文の出し方。
  test("the bubble is the one a prompt sent to the session itself is drawn in", async () => {
    const session = await openWith(
      [
        jsonl(
          userContentRow("その方針で進めて", {
            origin: { kind: "human" },
            promptSource: "typed",
          }),
        ),
        jsonl(assistantContentRow([textBlock("了解、進めます")])),
      ],
      null,
    );
    const sessionBubble = session.querySelector(".tl-bubble-right");
    await mounted.unmount();

    const agent = await openWith(
      [
        spawnPromptRow(),
        personMessageRow("その方針で進めて", "00000000-0000-4000-8000-000000000102"),
        jsonl(assistantContentRow([textBlock("了解、進めます")], SIDECHAIN)),
      ],
      AGENT,
    );
    const agentBubble = [...agent.querySelectorAll(".tl-bubble-right")].find((el) =>
      (el.textContent ?? "").includes("その方針で進めて"),
    );
    expect(sessionBubble?.className).toBe("tl-bubble tl-bubble-right");
    expect(agentBubble?.className).toBe(sessionBubble?.className);
    expect(agentBubble?.querySelector(".tl-bubble-body")?.textContent).toBe(
      sessionBubble?.querySelector(".tl-bubble-body")?.textContent,
    );
  });

  // 同じ isMeta の plugin の行でも、印で始まらないもの (ccmsg 自身の案内、他の
  // plugin の注入、別のセッションが `send` に agent_id を付けて送った文の印
  // `ccmsg:<session_id> から:`) は人の文ではないので、吹き出しにしない。
  test("a plugin row that does not start with the mark stays out of the user bubbles", async () => {
    const root = await openWith(
      [
        spawnPromptRow(),
        jsonl(
          userContentRow([textBlock("ccmsg:11111111-2222-4333-8444-555555555555 から:\n別件")], {
            ...SIDECHAIN,
            uuid: "00000000-0000-4000-8000-000000000103",
            isMeta: true,
            origin: { kind: "plugin", name: "ccmsg" },
          }),
        ),
        jsonl(assistantContentRow([textBlock("了解")], SIDECHAIN)),
      ],
      AGENT,
    );
    expect(userBubbleTexts(root).some((text) => text.includes("別件"))).toBe(false);
  });
});
