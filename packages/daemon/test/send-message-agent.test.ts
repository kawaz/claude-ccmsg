// send_message with an agent id (DR-0039 §3): the text goes to that running
// subagent of each matched session, through the session's module, over
// stand-in runs and appends.
import { describe, expect, test } from "bun:test";
import type { InjectFrame, InjectResult } from "../src/peer-inject.ts";
import { type SendMessageDeps, sendToPeers } from "../src/send-message.ts";
import { createSerial } from "../src/serial.ts";
import type { SessionRun } from "../src/session-runs.ts";
import type { UserMessageOutcome } from "../src/user-message.ts";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "bbbbbbbb-0000-4000-8000-000000000002";
const B = "cccccccc-0000-4000-8000-000000000003";

function run(sid: string, pid: number, cwd = "/work"): SessionRun {
  return { configDir: "/cfg", sid, pid, cwd };
}

/** Deps over `runs`, where `modules` have a hooks module and each session's
 * append answers what `appends` says for it (appended when it says nothing).
 * Nothing goes into a peer socket. */
function deps(
  runs: SessionRun[],
  options: { modules?: string[]; appends?: Record<string, UserMessageOutcome> } = {},
): SendMessageDeps & {
  asked: { sid: string; agentId: string; text: string; from: string }[];
  frames: InjectFrame[];
} {
  const asked: { sid: string; agentId: string; text: string; from: string }[] = [];
  const frames: InjectFrame[] = [];
  return {
    asked,
    frames,
    runs: async () => runs,
    realpath: async (dir) => dir,
    hasModule: (sid) => (options.modules ?? [A, B, ME]).includes(sid),
    readiness: () => ({ kind: "ended" }),
    issueMid: () => "i/1",
    deliver: async (_r, frame): Promise<InjectResult> => {
      frames.push(frame);
      return { outcome: "delivered" };
    },
    inOrder: createSerial(),
    appendToAgent: async (sid, agentId, text, from) => {
      asked.push({ sid, agentId, text, from });
      return options.appends?.[sid] ?? { outcome: "appended" };
    },
    log: () => {},
  };
}

describe("sendToPeers with an agent id", () => {
  test("each matched session is asked to append to its subagent, with the sender named", async () => {
    const d = deps([run(A, 2), run(B, 3)], {
      appends: { [B]: { outcome: "not_delivered", reason: "not_running" } },
    });
    expect(
      await sendToPeers({ from: ME, to: { cwd: "/work" }, agentId: "x1", text: "hi" }, d),
    ).toEqual([
      { sid: A, cwd: "/work", outcome: "delivered" },
      { sid: B, cwd: "/work", outcome: "not_delivered", reason: "not_running" },
    ]);
    expect(d.asked).toEqual([
      { sid: A, agentId: "x1", text: "hi", from: ME },
      { sid: B, agentId: "x1", text: "hi", from: ME },
    ]);
    // A subagent is reached through its module, never the peer socket.
    expect(d.frames).toEqual([]);
  });

  // The subagent is another loop than the sender's own: the sender's session
  // is not left out.
  test("the sender's own session is sent to", async () => {
    const d = deps([run(ME, 1)]);
    expect(
      await sendToPeers({ from: ME, to: { session_id: ME }, agentId: "x1", text: "hi" }, d),
    ).toEqual([{ sid: ME, cwd: "/work", outcome: "delivered" }]);
  });

  test("a session without a module is not asked; unconfirmed and other reasons come back", async () => {
    const d = deps([run(A, 2), run(B, 3), run(ME, 1)], {
      modules: [B, ME],
      appends: {
        [B]: { outcome: "unconfirmed" },
        [ME]: { outcome: "not_delivered", reason: "refused" },
      },
    });
    expect(
      await sendToPeers({ from: ME, to: { cwd: "/work" }, agentId: "x1", text: "hi" }, d),
    ).toEqual([
      { sid: ME, cwd: "/work", outcome: "not_delivered", reason: "refused" },
      { sid: A, cwd: "/work", outcome: "not_delivered", reason: "no_module" },
      { sid: B, cwd: "/work", outcome: "unconfirmed" },
    ]);
    expect(d.asked.map((a) => a.sid)).toEqual([B, ME]);
  });

  test("a session named by id that no run serves says why, as without an agent id", async () => {
    const d = deps([]);
    expect(
      await sendToPeers({ from: ME, to: { session_id: A }, agentId: "x1", text: "hi" }, d),
    ).toEqual([{ sid: A, outcome: "not_delivered", reason: "ended" }]);
    expect(d.asked).toEqual([]);
  });
});
