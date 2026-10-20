// The Timeline's "応答中" row (DR-0035 §3): the session's hooks module says a
// main-thread turn started the moment it does, and the Timeline shows it at
// its end until the turn ends — the transcript writes an answer's row only
// once the answer is done.
import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { SessionStatusSnapshot } from "@ccmsg/protocol";
import { TurnRespondingRow } from "../src/client/components/TimelineItem.tsx";
import { respondingSince } from "../src/client/session-status-view.ts";
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

const SINCE = "2026-10-14T03:04:05.000Z";
const BASE: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };

describe("respondingSince", () => {
  test("the start of the turn the main thread is answering", () => {
    expect(respondingSince({ ...BASE, turn: { state: "responding", since: SINCE } })).toBe(SINCE);
  });

  // Idle, no word from a module (a session without it), or no snapshot yet:
  // nothing is shown rather than guessed.
  test("null when idle, when no module said, and before the snapshot", () => {
    expect(respondingSince({ ...BASE, turn: { state: "idle", since: SINCE } })).toBeNull();
    expect(respondingSince(BASE)).toBeNull();
    expect(respondingSince(undefined)).toBeNull();
  });
});

describe("TurnRespondingRow", () => {
  afterEach(() => {
    jest.useRealTimers();
    setSystemTime();
  });

  async function mountAt(nowMs: number): Promise<HTMLElement> {
    jest.useFakeTimers();
    setSystemTime(nowMs);
    const root = document.createElement("div");
    document.body.append(root);
    container = root;
    await act(() => render(h(TurnRespondingRow, { since: SINCE }), root));
    return instanceOf(root.querySelector(".tl-turn-responding"), HTMLElement, "row");
  }

  // The start time is not shown: how long the turn has run is what is read.
  test("a status row that says the session is answering, and for how long", async () => {
    const row = await mountAt(Date.parse(SINCE) + 72_000);
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toContain("応答中");
    expect(row.textContent).toContain("…1m12s");
    expect(row.getAttribute("title")).toBe("応答中 …1m12s");
  });

  test("the elapsed time advances by the second", async () => {
    const row = await mountAt(Date.parse(SINCE) + 59_000);
    expect(row.textContent).toContain("…59s");
    await act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(row.textContent).toContain("…1m1s");
  });
});
