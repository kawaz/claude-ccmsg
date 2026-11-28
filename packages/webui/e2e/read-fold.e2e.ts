// Read items folded to one line, in a real browser (DR-0068 §5, §6).
// 何を保証するか:
//   - 応答の吹き出しの ✔️既読 を押すと、daemon の push で既読になり、その応答は元の高さから
//     1 行だけの吹き出しへ縦に縮む (補間の無いブラウザでは一瞬)。畳んだ吹き出しは応答と同じ
//     地・枠・角丸で、名前は「✅既読: <本文の冒頭>」
//   - 押すと 1 行から元の高さへ伸びて元の吹き出しに戻り、既読のまま (✅既読、押されている)。
//     伸びる間、項目の上端と TL のスクロール位置は動かない
//   - 読み込み直しても既読の応答は畳んだ形で出る (daemon が記録から配る)。✅既読 を押すと
//     既読が外れ、読み込み直しても吹き出しで出る
//   - daemon の起動より前の say と許可依頼 (未読でない) は、読み込んだ時から畳んだ形で出る。
//     say の畳んだ吹き出しは say の吹き出し (PushNotification の吹き出しと同じ) の地・枠・角丸、
//     許可依頼の畳んだ吹き出しは開いた許可依頼の吹き出しの地・枠・角丸
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

const RESPONSE = `別の issue にしました (docs/issue/2026-11-26-x.md)。${"説明の段落。".repeat(80)}\n\n二段落目の説明。`;

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
  tops: number[];
  scrolls: number[];
}

/** What the item `item` went through after a press of `press` in it, a frame
 * at a time for `ms`: its height and top, and the Timeline's scrollTop. The
 * first frame is before the press. */
async function framesWhile(page: Page, item: string, press: string, ms: number): Promise<Frames> {
  return page.evaluate(
    async ({ item, press, ms }) => {
      const element = document.querySelector(item);
      const view = document.querySelector(".timeline-view");
      if (!(element instanceof HTMLElement) || !(view instanceof HTMLElement)) {
        throw new Error(`no item ${item}`);
      }
      const button = element.querySelector(press);
      if (!(button instanceof HTMLElement)) throw new Error(`no ${press} in the item`);
      const frames: { heights: number[]; tops: number[]; scrolls: number[] } = {
        heights: [],
        tops: [],
        scrolls: [],
      };
      const take = () => {
        const box = element.getBoundingClientRect();
        frames.heights.push(box.height);
        frames.tops.push(box.top);
        frames.scrolls.push(view.scrollTop);
      };
      take();
      button.click();
      const until = performance.now() + ms;
      await new Promise<void>((resolve) => {
        const step = () => {
          take();
          if (performance.now() < until) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      return frames;
    },
    { item, press, ms },
  );
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

/** The look of an element's box: its ground, corners and frame. */
interface Look {
  background: string;
  radius: string;
  border: string;
}

function lookOf(page: Page, selector: string): Promise<Look> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        border: `${style.borderTopStyle} ${style.borderTopWidth} ${style.borderTopColor}`,
      };
    });
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
      "a say and a request made before the daemon started are folded, each in its own frame",
      async () => {
        const say = '.tl-item-fold[data-frame="say"]';
        const permit = '.tl-item-fold[data-frame="permit"]';
        expect(await page.locator(say).textContent()).toBe("✅既読: 終わりました。見てください");
        expect(await page.locator(permit).textContent()).toBe("✅既読: commit が止められた");
        // The say's frame is a say bubble's: the PushNotification's, never folded.
        expect(await lookOf(page, `${say} > .tl-bubble-body`)).toEqual(
          await lookOf(page, ".tl-item > .say"),
        );
        const permitLook = await lookOf(page, `${permit} > .tl-bubble-body`);
        await page.locator(permit).click();
        await page.locator(".tl-bubble-permit").waitFor();
        expect(await lookOf(page, ".tl-bubble-permit > .tl-bubble-body")).toEqual(permitLook);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "✔️既読 marks the response read: it shrinks to one line in the response's frame",
      async () => {
        await page.locator(response()).scrollIntoViewIfNeeded();
        const frames = await framesWhile(page, response(), ".tl-read-mark", 1500);
        const fold = page.locator(`${response()} > .tl-item-fold`);
        await fold.waitFor();
        const full = frames.heights[0] ?? 0;
        const folded = frames.heights.at(-1) ?? 0;
        expect(folded).toBeLessThan(full / 2);
        if (await interpolates(page)) {
          expect(between(frames).length).toBeGreaterThan(0);
          for (let i = 1; i < frames.heights.length; i++) {
            expect(frames.heights[i] ?? 0).toBeLessThanOrEqual((frames.heights[i - 1] ?? 0) + 0.5);
          }
        } else {
          expect(between(frames)).toEqual([]);
        }
        expect((await fold.textContent())?.startsWith("✅既読: 別の issue にしました")).toBe(true);
        expect(await lookOf(page, `${response()} > .tl-item-fold > .tl-bubble-body`)).toEqual(
          await lookOf(page, ".tl-bubble-assistant > .tl-bubble-body"),
        );
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "read again from the daemon: folded on a reload; pressed, it grows, still read",
      async () => {
        await page.reload();
        const fold = page.locator(`${response()} > .tl-item-fold`);
        await fold.waitFor();
        await fold.scrollIntoViewIfNeeded();
        const frames = await framesWhile(page, response(), ".tl-item-fold", 600);
        const mark = page.locator(`${response()} .tl-read-mark`);
        expect(await mark.getAttribute("aria-pressed")).toBe("true");
        expect(await mark.getAttribute("aria-label")).toBe("既読を外す");
        const folded = frames.heights[0] ?? 0;
        const full = frames.heights.at(-1) ?? 0;
        expect(full).toBeGreaterThan(folded * 2);
        if (await interpolates(page)) expect(between(frames).length).toBeGreaterThan(0);
        else expect(between(frames)).toEqual([]);
        for (const top of frames.tops) {
          expect(Math.abs(top - (frames.tops[0] ?? 0))).toBeLessThan(1);
        }
        for (const scroll of frames.scrolls) {
          expect(Math.abs(scroll - (frames.scrolls[0] ?? 0))).toBeLessThan(1);
        }
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "✅既読 takes the mark off: a bubble, and still one on a reload",
      async () => {
        await page.locator(`${response()} .tl-read-mark`).click();
        await page.locator(`${response()} .tl-read-mark[aria-pressed="false"]`).waitFor();
        expect(await page.locator(`${response()} > .tl-item-fold`).count()).toBe(0);
        await page.reload();
        await page.locator(`${response()} .tl-read-mark[aria-pressed="false"]`).waitFor();
        expect(await page.locator(`${response()} > .tl-item-fold`).count()).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
