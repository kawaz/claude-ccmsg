// The 中断 button beside the Timeline's 応答中 (DR-0044 §4): offered only while the
// main loop answers a turn, it asks turn_abort once, stays disabled until the
// reply, and says what came of it in this tab alone.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ErrorResponse, TurnAbortResponse } from "@ccmsg/protocol";
import {
  TURN_ABORTED_NOTICE_MS,
  TurnResponding,
  turnAbortFailureText,
} from "../src/client/components/timeline/TurnResponding.tsx";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const SINCE = "2026-10-28T03:04:05.000Z";
const NEXT = "2026-10-28T03:09:00.000Z";

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  jest.useRealTimers();
});

type Reply = TurnAbortResponse | ErrorResponse;

interface Mounted {
  root: HTMLElement;
  show: (since: string | null) => Promise<void>;
  presses: () => number;
  /** Settle the pending press with `reply`, or reject it with `error`. */
  answer: (reply: Reply | Error) => Promise<void>;
}

async function mount(since: string | null): Promise<Mounted> {
  let count = 0;
  let settle: ((reply: Reply | Error) => void) | undefined;
  const onAbort = (): Promise<Reply> => {
    count += 1;
    return new Promise((resolve, reject) => {
      settle = (reply) => (reply instanceof Error ? reject(reply) : resolve(reply));
    });
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const show = (s: string | null) =>
    act(() => render(h(TurnResponding, { since: s, onAbort }), root));
  await show(since);
  return {
    root,
    show,
    presses: () => count,
    answer: async (reply) => {
      await act(() => {
        settle?.(reply);
        return Promise.resolve();
      });
      for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    },
  };
}

function abortButton(root: HTMLElement): HTMLButtonElement | null {
  const found = root.querySelector(".tl-turn-abort");
  return found === null ? null : instanceOf(found, HTMLButtonElement, "the 中断 button");
}

function resultText(root: HTMLElement): string {
  return [...root.querySelectorAll(".tl-turn-abort-result")].map((e) => e.textContent).join("|");
}

describe("the 応答中 row's 中断 button", () => {
  test("beside 応答中 while a turn runs, and nowhere when none does", async () => {
    const running = await mount(SINCE);
    const button = abortButton(running.root);
    // A text label, not an icon: what it says is its accessible name.
    expect(button?.textContent).toBe("中断");
    expect(button?.hasAttribute("aria-label")).toBe(false);
    expect(button?.getAttribute("title")).toBe("応答を中断");
    expect(button?.closest(".tl-turn-responding")?.textContent).toContain("応答中");
    expect(button?.disabled).toBe(false);
    const idle = await mount(null);
    expect(abortButton(idle.root)).toBeNull();
    expect(idle.root.textContent).toBe("");
  });

  // No confirmation, one request however often it is pressed meanwhile.
  test("pressed, it asks once and stays disabled until the reply", async () => {
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await act(() => abortButton(m.root)?.click());
    expect(m.presses()).toBe(1);
    expect(abortButton(m.root)?.disabled).toBe(true);
    expect(resultText(m.root)).toBe("");
  });

  // The row and its button go with the turn's end (the module's facts); the line
  // that says the press worked stays a while longer, then goes.
  test("stopped: 中断しました, which outlives the row and then goes", async () => {
    jest.useFakeTimers();
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await m.answer({ ok: true });
    expect(resultText(m.root)).toBe("中断しました");
    expect(abortButton(m.root)?.disabled).toBe(true);
    await m.show(null);
    expect(abortButton(m.root)).toBeNull();
    expect(resultText(m.root)).toBe("中断しました");
    await act(() => {
      jest.advanceTimersByTime(TURN_ABORTED_NOTICE_MS);
    });
    expect(resultText(m.root)).toBe("");
  });

  test("not stopped: what the error says, and the button can be pressed again", async () => {
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await m.answer({ ok: false, error: { code: "abort_failed", msg: "no answer within 5s" } });
    expect(resultText(m.root)).toBe("中断できませんでした: no answer within 5s");
    expect(m.root.querySelector(".tl-turn-abort-failure")?.getAttribute("role")).toBe("alert");
    expect(abortButton(m.root)?.disabled).toBe(false);
    await act(() => abortButton(m.root)?.click());
    expect(m.presses()).toBe(2);
    expect(resultText(m.root)).toBe("");
  });

  // The turn had ended by the time the press arrived: the row is gone, and
  // the line says so.
  test("no_turn after the row went: said where the row was", async () => {
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await m.show(null);
    await m.answer({ ok: false, error: { code: "no_turn", msg: "session x is running no turn" } });
    expect(resultText(m.root)).toBe("中断する応答がありませんでした (既に終わっていた)");
  });

  // A failure belongs to the turn it was pressed on: the next turn's row
  // comes without it.
  test("a failure is not shown under the next turn", async () => {
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await m.answer({ ok: false, error: { code: "no_module", msg: "m" } });
    expect(resultText(m.root)).toBe("このセッションには hooks module が無いので中断できません");
    await m.show(NEXT);
    expect(resultText(m.root)).toBe("");
    expect(abortButton(m.root)?.disabled).toBe(false);
  });

  test("a request that could not be sent says so", async () => {
    const m = await mount(SINCE);
    await act(() => abortButton(m.root)?.click());
    await m.answer(new Error("ws not open"));
    expect(resultText(m.root)).toBe("中断を依頼できませんでした: ws not open");
  });
});

describe("turnAbortFailureText", () => {
  test("each error code the op answers with", () => {
    expect(turnAbortFailureText({ code: "session_not_found", msg: "m" })).toBe(
      "セッションが見つかりません",
    );
    expect(turnAbortFailureText({ code: "bad_request", msg: "requires user role" })).toBe(
      "中断できませんでした: requires user role",
    );
  });
});
