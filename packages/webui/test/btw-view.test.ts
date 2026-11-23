// The webui's pure parts of btw: what the input box says of a btw comment it
// could not ask (DR-0062 §14), and which rows of SESSIONS go to the
// Non-interactive fold (session-tree.ts, DR-0060 §8).
import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@ccmsg/protocol";
import { userPromptReasonDetail } from "../src/client/components/session-input.ts";
import { commentSendErrorDetail, sendResultText } from "../src/client/comment-view.ts";
import { splitInteractive } from "../src/client/session-tree.ts";
import type { SessionRow } from "../src/client/utils.ts";

describe("the input box's btw", () => {
  // btw のコメントの fork を起こせなかった理由は、btw の fork の理由として出る。
  // 本体に入れられなかった理由は本体への送信と同じ文。fork を起こした結果は何も言わない。
  test("a btw comment's fork not started says why; started says nothing", () => {
    expect(commentSendErrorDetail("btw_launch_unavailable")).toContain(
      "daemon が btw の fork を頼む途中で失敗した",
    );
    expect(commentSendErrorDetail("no_module")).toBe(userPromptReasonDetail("no_module"));
    expect(sendResultText({ kind: "comment", id: "c0001", outcome: "btw_started" })).toBeNull();
  });
});

describe("splitInteractive: the rows SESSIONS puts apart", () => {
  const agent = (entrypoint: string | undefined): AgentInfo => ({
    pid: 1,
    cwd: "/w",
    kind: "interactive",
    startedAt: 0,
    sessionId: "x",
    config_dir: "/c",
    ...(entrypoint !== undefined ? { entrypoint } : {}),
  });
  const row = (sid: string, entrypoint?: string, withAgent = true): SessionRow => ({
    sid,
    repo: "",
    ws: "",
    cwd: "/w",
    connected: true,
    ...(withAgent ? { agent: agent(entrypoint) } : {}),
  });

  test("claude -p and the SDKs go apart; the person's, unknown entrypoints and rows without an agents row stay", () => {
    const { interactive, nonInteractive } = splitInteractive([
      row("cli", "cli"),
      row("p", "sdk-cli"),
      row("ts", "sdk-ts"),
      row("py", "sdk-py"),
      row("desktop", "claude-desktop"),
      row("none", undefined),
      row("peer-only", undefined, false),
    ]);
    expect(interactive.map((r) => r.sid)).toEqual(["cli", "desktop", "none", "peer-only"]);
    expect(nonInteractive.map((r) => r.sid)).toEqual(["p", "ts", "py"]);
  });
});
