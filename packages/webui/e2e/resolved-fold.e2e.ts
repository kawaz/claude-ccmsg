// A resolved thread's items folded to one line, in a real browser (DR-0062
// §12「解決済みのスレッドの吹き出しの畳み」, P37, kawaz 2026-11-26, 2026-11-28).
// 何を保証するか:
//   - 吹き出しの ✔️解決済み を押すと、そのスレッドの項目 (人のコメント、エージェントの返信) は
//     元の高さから本文の 1 行目だけの高さへ縦に縮む。補間 (interpolate-size) のあるブラウザでは
//     途中の高さを通り、無いブラウザでは一瞬で替わる。押した項目の画面の中の上端は動かない
//   - 畳んだ項目は元の吹き出し (人のコメントの破線の枠) のまま、枠の中の高さが本文の 1 行の
//     高さに縮み、本文は書いたまま (字を足さない)。枠の上辺に「✅解決済み」のラベルが重なる。
//     頭の行・中のボタンの行・枠の下の行は場所を取らない
//   - 押すと 1 行の高さから元の高さへ縦に伸びる (補間の無いブラウザと、動きを減らす設定では
//     一瞬)。伸びる間、項目の上端と TL のスクロール位置は動かない。フォーカスは開いた項目の
//     包みに移る
//
// Each browser has a session of its own (a hello on the daemon's socket, with
// a transcript the test writes in a config dir under the daemon's HOME, and
// the comment it answers in the daemon's comments file before the daemon
// reads it): what one resolves is not the other's start. Nothing reaches a
// Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import {
  CCMSG_TOOLS,
  commentBlockText,
  commentReplyRecordedText,
  type UserComment,
} from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const COMMENTED = "この関数は呼び出し側で null を返すことがある";
/** Longer than any line the page has room for. */
const QUESTION = `全く同じではありません。この会話にとどいた${"長い問いの文。".repeat(60)}`;
const ANSWER = "そう、呼び出し側が **null** を返す時は `undefined` になる\n\n二段落目の説明。";

let dir: string;
let webui: Webui;
const sessions: TestClient[] = [];

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-rfold-");
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  for (const session of sessions) await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A session of the test's own, `n` telling it from the others: exchanges
 * before and after, the person's comment c0001 on an answer and the agent's
 * reply to it, the thread not resolved. Its sid. */
async function startSession(n: number): Promise<string> {
  const sid = `e2ef0000-0000-4000-8000-00000000000${String(n)}`;
  const id = (k: number) => `e2ef000${String(n)}-0000-4000-8000-${String(k).padStart(12, "0")}`;
  const cwd = path.join(dir, `repo-${String(n)}`);
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: sid, cwd };
  const comment: UserComment = {
    kind: "comment",
    author: "user",
    cid: "c0001",
    session_id: sid,
    anchor: { kind: "message", uuid: id(2), msg_start_with: COMMENTED },
    body: QUESTION,
    written: { at: "2020-01-01T00:00:03.000Z", after_uuid: id(2) },
    sent: { at: "2020-01-01T00:00:03.000Z", after_uuid: id(2) },
    updated_at: "2020-01-01T00:00:03.000Z",
    btw: false,
    status: "delivered",
    row_uuid: id(3),
  };
  const comments = path.join(path.dirname(webui.sock), "sessions", `${sid}.comments.jsonl`);
  fs.mkdirSync(path.dirname(comments), { recursive: true });
  fs.writeFileSync(comments, `${JSON.stringify(comment)}\n`);
  // Exchanges before and after, so the Timeline is taller than the page and
  // the items stand in its middle.
  const exchanges = (from: number, at: string, words: string) =>
    Array.from({ length: 5 }, (_, i) => [
      userContentRow(`${words}の質問 ${String(i)}`, {
        ...head,
        uuid: id(from + 2 * i),
        timestamp: `${at}:${String(10 + 2 * i)}.000Z`,
      }),
      assistantContentRow(
        [textBlock(`${words}の答え ${String(i)}\n\n${"長い答えの段落。".repeat(40)}`)],
        {
          ...head,
          uuid: id(from + 1 + 2 * i),
          timestamp: `${at}:${String(11 + 2 * i)}.000Z`,
        },
      ),
    ]).flat();
  const rows = [
    ...exchanges(100, "2019-12-31T23:59", "前"),
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock(COMMENTED)], {
      ...head,
      uuid: id(2),
      timestamp: "2020-01-01T00:00:02.000Z",
    }),
    userContentRow(
      commentBlockText({
        comment: "c0001",
        on: { kind: "msg_start_with", value: COMMENTED },
        body: QUESTION,
      }),
      { ...head, uuid: id(3), timestamp: "2020-01-01T00:00:03.000Z" },
    ),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  const session = await sessionConn({ sock: webui.sock }, sid, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
  sessions.push(session);
  const replied = await session.requestOk({
    op: "comment_reply",
    cid: "c0001",
    body: ANSWER,
    tool_use_id: "toolu_e2e_rfold",
  });
  const call = [
    assistantContentRow(
      [toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: "c0001", body: ANSWER }, "toolu_e2e_rfold")],
      { ...head, uuid: id(4), timestamp: "2020-01-01T00:00:04.000Z" },
    ),
    userContentRow(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_e2e_rfold",
          content: commentReplyRecordedText("c0001", replied.quote, replied.cid),
        },
      ],
      { ...head, uuid: id(5), timestamp: "2020-01-01T00:00:04.000Z" },
    ),
    ...exchanges(200, "2020-01-01T00:01", "後"),
  ];
  fs.appendFileSync(transcript, call.map((r) => `${line(r)}\n`).join(""));
  return sid;
}

/** What one item (the one the first element of `inItem` is in) went through
 * after a press of `press` in it, a frame at a time for `ms`: its height and
 * top, and the Timeline's scrollTop. The first frame is before the press. */
interface Frames {
  heights: number[];
  tops: number[];
  scrolls: number[];
}

async function framesWhile(page: Page, inItem: string, press: string, ms: number): Promise<Frames> {
  return page.evaluate(
    async ({ inItem, press, ms }) => {
      const item = document.querySelector(inItem)?.closest(".tl-item");
      const view = document.querySelector(".timeline-view");
      if (!(item instanceof HTMLElement) || !(view instanceof HTMLElement)) {
        throw new Error(`no item of ${inItem}`);
      }
      const button = item.querySelector(press);
      if (!(button instanceof HTMLElement)) throw new Error(`no ${press} in the item`);
      const frames: { heights: number[]; tops: number[]; scrolls: number[] } = {
        heights: [],
        tops: [],
        scrolls: [],
      };
      const take = () => {
        const box = item.getBoundingClientRect();
        frames.heights.push(box.height);
        frames.tops.push(box.top);
        frames.scrolls.push(view.scrollTop);
      };
      take();
      button.click();
      const until = performance.now() + ms;
      // Each frame as painted: taken in a task after the frame, once what
      // the frame ran (a ResizeObserver keeping a place) has set it.
      await new Promise<void>((resolve) => {
        const step = () => {
          take();
          if (performance.now() < until) requestAnimationFrame(() => setTimeout(step));
          else resolve();
        };
        requestAnimationFrame(() => setTimeout(step));
      });
      return frames;
    },
    { inItem, press, ms },
  );
}

/** Whether the page's engine interpolates a height to and from `auto`. */
function interpolates(page: Page): Promise<boolean> {
  return page.evaluate(() => CSS.supports("interpolate-size", "allow-keywords"));
}

/** The heights strictly between where it started and where it ended. */
function between(frames: Frames): number[] {
  const from = frames.heights[0] ?? 0;
  const to = frames.heights.at(-1) ?? 0;
  const low = Math.min(from, to) + 2;
  const high = Math.max(from, to) - 2;
  return frames.heights.filter((h) => h > low && h < high);
}

for (const [n, engine] of BROWSERS.entries()) {
  describe.skipIf(skipsEngine(engine))(`a resolved thread folded in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      const sid = await startSession(n + 1);
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${sid}/timeline/head`);
      await page.locator(".tl-bubble-comment-reply").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "✔️解決済み folds the thread: each bubble shrinks to its first line",
      async () => {
        expect(await page.locator(".tl-item[data-folded]").count()).toBe(0);
        await page.locator(".tl-bubble-comment-reply").scrollIntoViewIfNeeded();
        const frames = await framesWhile(
          page,
          ".tl-bubble-comment-reply",
          ".tl-bubble-comment-reply .tl-comment-resolve",
          1500,
        );
        await page.locator(".tl-item[data-folded]").nth(1).waitFor();
        expect(await page.locator(".tl-item[data-folded]").count()).toBe(2);
        const full = frames.heights[0] ?? 0;
        const folded = frames.heights.at(-1) ?? 0;
        expect(folded).toBeLessThan(full / 2);
        if (await interpolates(page)) {
          expect(between(frames).length).toBeGreaterThan(0);
          // Only down: it does not go back up on its way.
          for (let i = 1; i < frames.heights.length; i++) {
            expect(frames.heights[i] ?? 0).toBeLessThanOrEqual((frames.heights[i - 1] ?? 0) + 0.5);
          }
        } else {
          expect(between(frames)).toEqual([]);
        }
        // The item pressed keeps its place on the screen.
        for (const top of frames.tops) {
          expect(Math.abs(top - (frames.tops[0] ?? 0))).toBeLessThan(1);
        }
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "folded: its own bubble cut to the first line of its text, labelled 「✅解決済み」 on its frame's top edge",
      async () => {
        const item = page.locator(".tl-item[data-folded]:has(> .tl-bubble-comment)");
        expect(await item.locator(":scope > .tl-item-fold").getAttribute("aria-expanded")).toBe(
          "false",
        );
        const look = await item.evaluate((element) => {
          const frame = element.querySelector(":scope > .tl-bubble-comment > .tl-bubble-body");
          const text = frame?.querySelector(":scope > .tl-comment-body");
          const md = text?.querySelector(".md");
          if (!(frame instanceof HTMLElement) || !(text instanceof HTMLElement) || !md) {
            throw new Error("the folded bubble's parts");
          }
          const style = getComputedStyle(frame);
          const label = getComputedStyle(frame, "::before");
          return {
            label: label.content,
            inside:
              frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
            text: text.getBoundingClientRect().height,
            line: parseFloat(getComputedStyle(md).lineHeight),
            words: text.textContent ?? "",
            border: style.borderTopStyle,
            hidden: [
              ...element.querySelectorAll(
                ".tl-comment-on, .tl-comment-reply-row, .tl-bubble-footer",
              ),
            ].every((part) => part.getBoundingClientRect().height === 0),
          };
        });
        expect(look.label).toContain("✅解決済み");
        // Its own frame: the person's comment's dashed one.
        expect(look.border).toBe("dashed");
        // One line of its text, the frame's inside as high as it.
        expect(Math.abs(look.text - look.line)).toBeLessThan(1.5);
        expect(Math.abs(look.inside - look.text)).toBeLessThan(1.5);
        // Its text as written, nothing put before it.
        expect(look.words.startsWith("全く同じではありません。この会話にとどいた")).toBe(true);
        expect(look.hidden).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "pressed, it grows from one line to its height, its top and the scroll staying",
      async () => {
        const inItem = ".tl-item[data-folded]:has(> .tl-bubble-comment)";
        await page.locator(inItem).scrollIntoViewIfNeeded();
        const frames = await framesWhile(page, inItem, ".tl-comment-body", 600);
        expect(await page.locator(".tl-item[data-folded]").count()).toBe(1);
        const opened = page.locator(".tl-item:has(> .tl-bubble-comment)");
        expect(await opened.locator(".tl-comment-reply-row").isVisible()).toBe(true);
        const folded = frames.heights[0] ?? 0;
        const full = frames.heights.at(-1) ?? 0;
        expect(full).toBeGreaterThan(folded * 2);
        if (await interpolates(page)) {
          expect(between(frames).length).toBeGreaterThan(0);
          // Only up: it does not go back down on its way.
          for (let i = 1; i < frames.heights.length; i++) {
            expect(frames.heights[i] ?? 0).toBeGreaterThanOrEqual(
              (frames.heights[i - 1] ?? 0) - 0.5,
            );
          }
        } else {
          expect(between(frames)).toEqual([]);
        }
        for (const top of frames.tops) {
          expect(Math.abs(top - (frames.tops[0] ?? 0))).toBeLessThan(1);
        }
        for (const top of frames.scrolls) {
          expect(Math.abs(top - (frames.scrolls[0] ?? 0))).toBeLessThan(1);
        }
        expect(await opened.evaluate((item) => document.activeElement === item)).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "with less motion asked for, it opens at once",
      async () => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const inItem = ".tl-item[data-folded]";
        await page.locator(inItem).scrollIntoViewIfNeeded();
        const frames = await framesWhile(page, inItem, ".tl-bubble-body", 400);
        expect(await page.locator(".tl-item[data-folded]").count()).toBe(0);
        expect(between(frames)).toEqual([]);
        await page.emulateMedia({ reducedMotion: "no-preference" });
      },
      E2E_TIMEOUT_MS,
    );
  });
}
