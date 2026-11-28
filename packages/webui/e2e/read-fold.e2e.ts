// Read items folded to one line, in a real browser (DR-0068 §5, §6; DR-0062
// P37; kawaz 2026-11-28).
// 何を保証するか:
//   - daemon の起動より前の say と許可依頼 (未読でない) は、読み込んだ時から畳んだ形で出る:
//     元の吹き出しの枠の高さが本文の 1 行分に縮み (枠の中の高さが本文の箱の 1 行の高さと
//     同じ)、本文の箱は 1 行で、本文の字は書いたまま。枠の上辺に「✅既読」のラベルが重なる。
//     頭の行・中のボタンの行・枠の下の行は場所を取らない
//   - 応答の吹き出しの ✔️既読 を押すと、daemon の push で既読になり、その応答は元の高さから
//     本文の 1 行目だけの高さへ縦に縮む (補間の無いブラウザでは一瞬)。縮む間、押した項目の
//     画面の中の上端は動かない
//   - 読み込み直しても既読の応答は畳んだ形で出る (daemon が記録から配る)。畳んだ吹き出しを
//     押すと元の高さへ伸び、既読のまま (✅既読、押されている)。伸びる間、上端は動かない
//   - 開いた応答の吹き出しの本文を押すと縮み、もう一度押すと伸びる。どちらの間も上端は動かない
//   - 上端が画面の上の外にある長い吹き出しを真ん中で押して畳むと、押した時に跳ねず、縮み終わる
//     と畳んだ行が画面の一番上に残る (画面の外へ飛ばない)
//   - ✅既読 を押すと既読が外れ、読み込み直しても畳まない
//
// Each browser has a session of its own (a hello on the daemon's socket, with
// a transcript the test writes in a config dir under the daemon's HOME): what
// one marks is not the other's start. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT } from "@ccmsg/protocol";
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

const RESPONSE = `別の issue にしました (docs/issue/2026-11-26-x.md)。${"説明の段落。".repeat(400)}\n\n二段落目の説明。`;

let dir: string;
let webui: Webui;
const sessions: TestClient[] = [];

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-read-");
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  for (const session of sessions) await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A session of the test's own, `n` telling it from the others: exchanges
 * before and after, the response to mark, a say, a request for permission and
 * a PushNotification, all made before the daemon started. Its sid. */
async function startSession(n: number): Promise<string> {
  const sid = `e2ed0000-0000-4000-8000-00000000000${String(n)}`;
  const id = (k: number) => `e2ed000${String(n)}-0000-4000-8000-${String(k).padStart(12, "0")}`;
  const cwd = path.join(dir, `repo-${String(n)}`);
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: sid, cwd };
  const at = (s: number) => `2020-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;
  const exchanges = (from: number, stamp: string, words: string) =>
    Array.from({ length: 5 }, (_, i) => [
      userContentRow(`${words}の質問 ${String(i)}`, {
        ...head,
        uuid: id(from + 2 * i),
        timestamp: `${stamp}:${String(10 + 2 * i)}.000Z`,
      }),
      assistantContentRow(
        [textBlock(`${words}の答え ${String(i)}\n\n${"長い答えの段落。".repeat(40)}`)],
        { ...head, uuid: id(from + 1 + 2 * i), timestamp: `${stamp}:${String(11 + 2 * i)}.000Z` },
      ),
    ]).flat();
  const rows = [
    ...exchanges(100, "2019-12-31T23:59", "前"),
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: at(1) }),
    assistantContentRow([textBlock(RESPONSE)], { ...head, uuid: id(2), timestamp: at(2) }),
    assistantContentRow(
      [toolUseBlock(CCMSG_TOOLS.say, { text: "終わりました。見てください" }, "toolu_e2e_say")],
      { ...head, uuid: id(3), timestamp: at(3) },
    ),
    assistantContentRow(
      [
        toolUseBlock(
          CCMSG_TOOLS.permit,
          { blocked: "commit が止められた", intents: ["commit して良い"] },
          "toolu_e2e_permit",
        ),
      ],
      { ...head, uuid: id(4), timestamp: at(4) },
    ),
    userContentRow(
      [{ type: "tool_result", tool_use_id: "toolu_e2e_permit", content: PERMIT_REQUESTED_TEXT }],
      { ...head, uuid: id(5), timestamp: at(4) },
    ),
    assistantContentRow(
      [toolUseBlock("PushNotification", { message: "通知です" }, "toolu_e2e_push")],
      { ...head, uuid: id(6), timestamp: at(6) },
    ),
    ...exchanges(200, "2020-01-01T00:01", "後"),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  const session = await sessionConn({ sock: webui.sock }, sid, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
  sessions.push(session);
  return sid;
}

interface Frames {
  heights: number[];
  /** The item's top, from the top of what the Timeline shows (under its
   * toolbar). */
  tops: number[];
  scrolls: number[];
}

/** What the item `item` went through after a press, a frame at a time for
 * `ms`: its height and top, and the Timeline's scrollTop. The first frame is
 * before the press. The press is a person's at a point of `press` (an element
 * in the item): at its left, `y` from the top of the page if given (else in
 * its first line), on the element there; pointerdown, then click. */
async function framesWhile(
  page: Page,
  item: string,
  press: { selector: string; y?: number },
  ms: number,
): Promise<Frames> {
  return page.evaluate(
    async ({ item, press, ms }) => {
      const element = document.querySelector(item);
      const view = document.querySelector(".timeline-view");
      if (!(element instanceof HTMLElement) || !(view instanceof HTMLElement)) {
        throw new Error(`no item ${item}`);
      }
      const pressed = element.querySelector(press.selector);
      if (!(pressed instanceof HTMLElement)) throw new Error(`no ${press.selector} in the item`);
      const toolbar = view.querySelector(".tl-toolbar");
      const shownTop = () =>
        toolbar?.getBoundingClientRect().bottom ?? view.getBoundingClientRect().top;
      const frames: { heights: number[]; tops: number[]; scrolls: number[] } = {
        heights: [],
        tops: [],
        scrolls: [],
      };
      const take = () => {
        const box = element.getBoundingClientRect();
        frames.heights.push(box.height);
        frames.tops.push(box.top - shownTop());
        frames.scrolls.push(view.scrollTop);
      };
      take();
      const box = pressed.getBoundingClientRect();
      const x = box.left + Math.min(12, box.width / 2);
      const y = press.y ?? box.top + Math.min(box.height / 2, 10);
      const target = document.elementFromPoint(x, y) ?? pressed;
      const at = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent("pointerdown", at));
      target.dispatchEvent(new MouseEvent("click", at));
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
    { item, press, ms },
  );
}

/** Scrolls the Timeline so the item `item`'s top stands `top` px under the
 * top of what it shows (negative: above it), as a person's scroll: what the
 * Timeline held (its end, on opening it) is let go first. */
async function placeAt(page: Page, item: string, top: number): Promise<void> {
  await page.evaluate(
    ({ item, top }) => {
      const element = document.querySelector(item);
      const view = document.querySelector(".timeline-view");
      if (!(element instanceof HTMLElement) || !(view instanceof HTMLElement)) {
        throw new Error(`no item ${item}`);
      }
      view.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      const toolbar = view.querySelector(".tl-toolbar");
      const shown = toolbar?.getBoundingClientRect().bottom ?? view.getBoundingClientRect().top;
      view.scrollTo({ top: view.scrollTop + element.getBoundingClientRect().top - shown - top });
    },
    { item, top },
  );
  // A frame for the scroll to be taken (and its scroll events to pass).
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

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

/** The heights only go one way (down for `shrinks`), a half px allowed. */
function oneWay(frames: Frames, shrinks: boolean): boolean {
  return frames.heights.every((h, i) => {
    const before = frames.heights[i - 1];
    if (before === undefined) return true;
    return shrinks ? h <= before + 0.5 : h >= before - 0.5;
  });
}

/** What a folded item shows, measured: the label on its frame, whether the
 * label sits on the frame's top edge, the height of its frame's inside and of
 * its text box, its text box's line height, and whether the parts it hides
 * take no room. */
interface FoldedLook {
  label: string;
  labelOnTopEdge: boolean;
  inside: number;
  textBox: number;
  lineHeight: number;
  text: string;
  hiddenTakeNoRoom: boolean;
}

function foldedLook(
  page: Page,
  item: string,
  parts: { frame: string; textBox: string; line: string; hidden: string },
): Promise<FoldedLook> {
  return page.evaluate(
    ({ item, parts }) => {
      const element = document.querySelector(item);
      const frame = element?.querySelector(parts.frame);
      const textBox = element?.querySelector(parts.textBox);
      const line = element?.querySelector(parts.line);
      if (
        element === null ||
        !(frame instanceof HTMLElement) ||
        !(textBox instanceof HTMLElement) ||
        !(line instanceof HTMLElement)
      ) {
        throw new Error(`the parts of ${item}`);
      }
      const label = getComputedStyle(frame, "::before");
      const frameBox = frame.getBoundingClientRect();
      // The label's box: placed from the bubble around the frame (app.css),
      // `top: 0` and moved up by half its height.
      const labelHeight =
        parseFloat(label.height) ||
        parseFloat(label.fontSize) + parseFloat(label.paddingTop) * 2 + 2;
      const labelTop = frameBox.top - labelHeight / 2;
      const style = getComputedStyle(frame);
      return {
        label: label.content,
        labelOnTopEdge: labelTop < frameBox.top && labelTop + labelHeight > frameBox.top,
        inside: frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        textBox: textBox.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(line).lineHeight),
        text: textBox.textContent ?? "",
        hiddenTakeNoRoom: [...element.querySelectorAll(parts.hidden)].every(
          (part) => part.getBoundingClientRect().height === 0,
        ),
      };
    },
    { item, parts },
  );
}

/** One line of its text shows in the frame: the text box is one line high,
 * and the frame's inside is the text box's (its height's formula matches). */
function oneLine(look: FoldedLook): void {
  expect(Math.abs(look.textBox - look.lineHeight)).toBeLessThan(1.5);
  expect(Math.abs(look.inside - look.textBox)).toBeLessThan(1.5);
}

for (const [n, engine] of BROWSERS.entries()) {
  describe.skipIf(skipsEngine(engine))(`read items folded in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    let sid: string;
    const response = () =>
      `[data-timeline-uuid="e2ed000${String(n + 1)}-0000-4000-8000-000000000002"]`;
    beforeAll(async () => {
      sid = await startSession(n + 1);
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${sid}/timeline/head`);
      await page.locator(`${response()} .tl-read-mark`).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a say and a request made before the daemon started are folded: their bubbles cut to one line, labelled on the frame",
      async () => {
        const say = ".tl-item[data-folded]:has(> .say)";
        const permit = ".tl-item[data-folded]:has(> .tl-bubble-permit)";
        const sayLook = await foldedLook(page, say, {
          frame: ":scope > .say",
          textBox: ".say-body",
          line: ".say-body",
          hidden: ".say-meta > *, .say-footer",
        });
        expect(sayLook.label).toContain("✅既読");
        expect(sayLook.labelOnTopEdge).toBe(true);
        expect(sayLook.text).toBe("終わりました。見てください");
        expect(sayLook.hiddenTakeNoRoom).toBe(true);
        oneLine(sayLook);
        const permitLook = await foldedLook(page, permit, {
          frame: ".tl-bubble-permit > .tl-bubble-body",
          textBox: ".permit-content",
          line: ".permit-section .md",
          hidden: ".tl-bubble-from, .permit-heading, .permit-grant-row, .tl-bubble-footer",
        });
        expect(permitLook.label).toContain("✅既読");
        expect(permitLook.labelOnTopEdge).toBe(true);
        expect(permitLook.hiddenTakeNoRoom).toBe(true);
        oneLine(permitLook);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "✔️既読 marks the response read: it shrinks to its first line, its top staying",
      async () => {
        await placeAt(page, response(), 40);
        const frames = await framesWhile(page, response(), { selector: ".tl-read-mark" }, 1500);
        await page.locator(`${response()}[data-folded]`).waitFor();
        const full = frames.heights[0] ?? 0;
        const folded = frames.heights.at(-1) ?? 0;
        expect(folded).toBeLessThan(full / 4);
        if (await interpolates(page)) {
          expect(between(frames).length).toBeGreaterThan(0);
          expect(oneWay(frames, true)).toBe(true);
        } else {
          expect(between(frames)).toEqual([]);
        }
        for (const top of frames.tops) expect(Math.abs(top - 40)).toBeLessThan(1);
        const look = await foldedLook(page, response(), {
          frame: ".tl-bubble-assistant > .tl-bubble-body",
          textBox: ".tl-bubble-assistant > .tl-bubble-body > .tl-search-unit",
          line: ".tl-bubble-assistant .md",
          hidden: ".tl-comment-reply-row, .tl-bubble-footer",
        });
        expect(look.label).toContain("✅既読");
        expect(look.text.startsWith("別の issue にしました")).toBe(true);
        expect(look.hiddenTakeNoRoom).toBe(true);
        oneLine(look);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "read again from the daemon: folded on a reload; pressed, it grows to its height, still read, its top staying",
      async () => {
        await page.reload();
        // The marks come after the Timeline is drawn: it shrinks to its line
        // as it is seen (P37), and is pressed once it has.
        await page.locator(`${response()}[data-folded]:not([data-fold-motion])`).waitFor();
        await placeAt(page, response(), 40);
        const frames = await framesWhile(
          page,
          response(),
          { selector: ".tl-bubble-assistant .md" },
          600,
        );
        expect(await page.locator(`${response()}[data-folded]`).count()).toBe(0);
        const mark = page.locator(`${response()} .tl-read-mark`);
        expect(await mark.getAttribute("aria-pressed")).toBe("true");
        const folded = frames.heights[0] ?? 0;
        const full = frames.heights.at(-1) ?? 0;
        expect(full).toBeGreaterThan(folded * 4);
        if (await interpolates(page)) {
          expect(between(frames).length).toBeGreaterThan(0);
          expect(oneWay(frames, false)).toBe(true);
        } else {
          expect(between(frames)).toEqual([]);
        }
        for (const top of frames.tops) expect(Math.abs(top - 40)).toBeLessThan(1);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "opened, a press of its bubble shrinks it to its first line, still read, its top staying; pressed again, it grows again",
      async () => {
        await placeAt(page, response(), 40);
        const closing = await framesWhile(
          page,
          response(),
          { selector: ".tl-bubble-assistant .md" },
          600,
        );
        await page.locator(`${response()}[data-folded]`).waitFor();
        expect(await page.locator(`${response()} .tl-read-mark`).getAttribute("aria-pressed")).toBe(
          "true",
        );
        const opening = await framesWhile(
          page,
          response(),
          { selector: ".tl-bubble-assistant .md" },
          600,
        );
        expect(await page.locator(`${response()}[data-folded]`).count()).toBe(0);
        for (const [frames, shrinks] of [
          [closing, true],
          [opening, false],
        ] as const) {
          if (await interpolates(page)) {
            expect(between(frames).length).toBeGreaterThan(0);
            expect(oneWay(frames, shrinks)).toBe(true);
          } else {
            expect(between(frames)).toEqual([]);
          }
          for (const top of frames.tops) expect(Math.abs(top - 40)).toBeLessThan(1);
        }
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a long bubble pressed in its middle, its top above the screen, folds to a line left on the screen",
      async () => {
        const shownHeight = await page.evaluate(() => {
          const view = document.querySelector(".timeline-view");
          const toolbar = view?.querySelector(".tl-toolbar");
          if (!(view instanceof HTMLElement)) throw new Error("no Timeline");
          return (
            view.getBoundingClientRect().bottom - (toolbar?.getBoundingClientRect().bottom ?? 0)
          );
        });
        await placeAt(page, response(), -300);
        const shownTop = await page.evaluate(() => {
          const view = document.querySelector(".timeline-view");
          const toolbar = view?.querySelector(".tl-toolbar");
          return toolbar?.getBoundingClientRect().bottom ?? view?.getBoundingClientRect().top ?? 0;
        });
        const frames = await framesWhile(
          page,
          response(),
          { selector: ".tl-bubble-assistant .md", y: shownTop + 200 },
          800,
        );
        await page.locator(`${response()}[data-folded]`).waitFor();
        // Its top does not jump at the press, and only comes down.
        expect(Math.abs((frames.tops[1] ?? 0) - -300)).toBeLessThan(1);
        for (let i = 1; i < frames.tops.length; i++) {
          expect(frames.tops[i] ?? 0).toBeGreaterThanOrEqual((frames.tops[i - 1] ?? 0) - 0.5);
        }
        // Its line is left at the top of the screen.
        const top = frames.tops.at(-1) ?? 0;
        expect(Math.abs(top)).toBeLessThan(1);
        expect(top + (frames.heights.at(-1) ?? 0)).toBeLessThan(shownHeight);
        // Opened again for the next test.
        await page.locator(`${response()} > .tl-item-fold`).dispatchEvent("click");
        await page.locator(`${response()}:not([data-folded])`).waitFor();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "✅既読 takes the mark off: a bubble, and still one on a reload",
      async () => {
        await page.locator(`${response()} .tl-read-mark`).click();
        await page.locator(`${response()} .tl-read-mark[aria-pressed="false"]`).waitFor();
        expect(await page.locator(`${response()}[data-folded]`).count()).toBe(0);
        await page.reload();
        await page.locator(`${response()} .tl-read-mark[aria-pressed="false"]`).waitFor();
        expect(await page.locator(`${response()}[data-folded]`).count()).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
