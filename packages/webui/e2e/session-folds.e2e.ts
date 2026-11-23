// The SESSIONS list's folds in a real browser (DR-0043 §10, §11): an owner,
// `others` and Bookmarks each open or close once for one click on the heading,
// one Enter and one Space on it, the state the reader left is stored, and it
// comes back after a reload. The groups under an owner do not fold: pressing
// the heading of a group of one session goes to that session, and pressing
// the heading of a group of several does nothing.
//
// A real browser is what these need: the page's own rendering runs between the
// heading's click listener and the browser's flip of the `<details>` only for
// a real input (a microtask checkpoint after each listener), so a fold that
// re-rendered its `open` from the click could undo the click there and nowhere
// else — happy-dom and a script's `click()` run the two the other way round.
// Folds are found by their heading's text within the SESSIONS region, not by
// class names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import type { Browser, Locator, Page } from "playwright";
import { jsonText, parseWith } from "@ccmsg/protocol";
import { SESSION_FOLDS_STORAGE_KEY } from "../src/client/session-tree.ts";
import {
  BROWSERS,
  E2E_TIMEOUT_MS,
  fixturePeers,
  routePeers,
  startWebui,
  type Webui,
} from "./harness.ts";

const PEERS = fixturePeers([
  // alice: a prefix group `app` (two repositories named app-…) and a repo group `lib`.
  { repo: "alice/app-web", ws: "main" },
  { repo: "alice/app-api", ws: "main" },
  { repo: "alice/lib", ws: "main" },
  { repo: "alice/lib", ws: "fix" },
  { repo: "bob/tool", ws: "main" },
  { repo: "", ws: "bare" },
]);
const TOOL_SID = PEERS[4]?.sid;

/** Each fold under test: its heading's text, and the key its state is stored
 * under. The owner comes last: closing it hides the groups inside. */
const FOLDS = [
  { name: "others", heading: /^others \(1\)/, key: "others" },
  { name: "Bookmarks", heading: /^Bookmarks \(0\)/, key: "bookmarks" },
  { name: "owner", heading: /^alice \(4\)/, key: "owner:alice" },
] as const;

const StoredFoldsSchema = jsonText(v.record(v.string(), v.boolean()));

/** How long to wait for the stored state after a toggle: the fold stores it
 * from the element's `toggle` event, a task after the input. */
const STORED_WITHIN_MS = 5_000;

let webui: Webui;
beforeAll(async () => {
  webui = await startWebui();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await webui.stop();
});

for (const engine of BROWSERS) {
  describe(`SESSIONS folds in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await routePeers(page, PEERS);
      await page.goto(webui.url);
      await page.evaluate((key) => localStorage.removeItem(key), SESSION_FOLDS_STORAGE_KEY);
      await page.reload();
      await headingOf(/^alice \(4\)/).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    function headingOf(text: RegExp): Locator {
      return page
        .getByRole("region", { name: "Sessions" })
        .locator("details > summary")
        .filter({ hasText: text })
        .first();
    }
    const isOpen = (summary: Locator): Promise<boolean> =>
      summary.evaluate(
        (el) => el.parentElement instanceof HTMLDetailsElement && el.parentElement.open,
      );
    async function storedStates(): Promise<Record<string, boolean>> {
      const raw = await page.evaluate((k) => localStorage.getItem(k), SESSION_FOLDS_STORAGE_KEY);
      if (raw === null) return {};
      const read = parseWith(StoredFoldsSchema, raw);
      if (!read.ok) throw new Error(`the stored fold states do not read: ${raw}`);
      return read.value;
    }
    /** The state stored for `key` once it is `open`, or what it is when the
     * wait runs out. */
    async function storedOnceIs(key: string, open: boolean): Promise<boolean | undefined> {
      await page
        .waitForFunction(
          ([storageKey, foldKey, want]) => {
            const raw = localStorage.getItem(storageKey);
            return raw !== null && raw.includes(`"${foldKey}":${String(want)}`);
          },
          [SESSION_FOLDS_STORAGE_KEY, key, open] as const,
          { timeout: STORED_WITHIN_MS },
        )
        .catch(() => undefined);
      return (await storedStates())[key];
    }

    const inputs = [
      { name: "a click", press: (summary: Locator) => summary.click() },
      {
        name: "Enter",
        press: async (summary: Locator) => {
          await summary.focus();
          await page.keyboard.press("Enter");
        },
      },
      {
        name: "Space",
        press: async (summary: Locator) => {
          await summary.focus();
          await page.keyboard.press("Space");
        },
      },
    ];

    function groupHeadingOf(text: RegExp): Locator {
      return page
        .getByRole("region", { name: "Sessions" })
        .locator(".session-tree-group-heading")
        .filter({ hasText: text })
        .first();
    }

    test(
      "a group has no disclosure and stores nothing, pressing a group of several does nothing",
      async () => {
        for (const text of [/^app$/, /^lib$/]) {
          const heading = groupHeadingOf(text);
          await heading.waitFor();
          expect(await heading.evaluate((el) => el.closest("details > summary") === null)).toBe(
            true,
          );
          const before = page.url();
          // force: webkit reports the page's root as intercepting every click here
          // (the folds' own "a click" tests fail the same way there).
          await heading.click({ force: true });
          expect(page.url()).toBe(before);
        }
        expect(await page.locator(".session-tree-group li.session-row").count()).toBe(5);
        const states = await storedStates();
        expect(Object.keys(states).filter((k) => /^(repo|prefix):/.test(k))).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    for (const fold of FOLDS) {
      for (const input of inputs) {
        test(
          `${fold.name}: ${input.name} opens or closes it once, and the state is stored`,
          async () => {
            const summary = headingOf(fold.heading);
            const before = await isOpen(summary);
            await input.press(summary);
            expect(await isOpen(summary)).toBe(!before);
            expect(await storedOnceIs(fold.key, !before)).toBe(!before);
            await input.press(summary);
            expect(await isOpen(summary)).toBe(before);
            expect(await storedOnceIs(fold.key, before)).toBe(before);
          },
          E2E_TIMEOUT_MS,
        );
      }
    }

    test(
      "the state the reader left comes back after a reload",
      async () => {
        const left = new Map<string, boolean>();
        for (const fold of FOLDS) {
          const summary = headingOf(fold.heading);
          const before = await isOpen(summary);
          await summary.click();
          expect(await storedOnceIs(fold.key, !before)).toBe(!before);
          left.set(fold.key, !before);
        }
        await page.reload();
        await headingOf(/^alice \(4\)/).waitFor();
        for (const fold of FOLDS) {
          // A fold inside a closed owner is still in the page, with its own state.
          expect({ fold: fold.name, open: await isOpen(headingOf(fold.heading)) }).toEqual({
            fold: fold.name,
            open: left.get(fold.key) === true,
          });
        }
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "pressing a group of one session goes to that session",
      async () => {
        const heading = groupHeadingOf(/^tool @main$/);
        // Enter on the focused link (the heading is out of the Tab order).
        await heading.focus();
        await page.keyboard.press("Enter");
        await page.waitForURL((url) => url.href.includes(TOOL_SID ?? "missing"), {
          timeout: STORED_WITHIN_MS,
        });
      },
      E2E_TIMEOUT_MS,
    );
  });
}
