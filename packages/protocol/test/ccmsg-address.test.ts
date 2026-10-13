// The `ccmsg:` addresses of DR-0037 §1, read and spelled out.
import { describe, expect, test } from "bun:test";
import {
  formatCcmsgAddress,
  parseCcmsgAddress,
  parseDirectDeliveries,
  renderAddressedDelivery,
  sessionAddresses,
} from "../src/index.ts";

const SID = "aaaaaaaa-2222-4333-8444-555555555555";

describe("parseCcmsgAddress", () => {
  test("the three spellings, and each spelled back the same", () => {
    const cases = [
      [`ccmsg:${SID}`, { kind: "session", sid: SID }],
      [`ccmsg:${SID}.4242`, { kind: "run", sid: SID, pid: 4242 }],
      ["ccmsg:path:/w/repo", { kind: "path", dir: "/w/repo" }],
      ["ccmsg:path:/w/repo/", { kind: "path", dir: "/w/repo/" }],
    ] as const;
    for (const [text, read] of cases) {
      expect(parseCcmsgAddress(text)).toEqual(read);
      expect(formatCcmsgAddress(read)).toBe(text);
    }
  });

  test("anything else is not an address", () => {
    for (const text of [
      SID,
      "ccmsg:",
      "ccmsg:user",
      `ccmsg:${SID.toUpperCase()}`,
      `ccmsg:${SID}.`,
      `ccmsg:${SID}.0`,
      `ccmsg:${SID}.012`,
      `ccmsg:${SID}.1.2`,
      `ccmsg:${SID}.99999999999999999999`,
      "ccmsg:path:",
      "ccmsg:path:relative/dir",
      "ccmsg:path:~/w",
      `CCMSG:${SID}`,
    ]) {
      expect({ text, read: parseCcmsgAddress(text) }).toEqual({ text, read: undefined });
    }
  });
});

describe("renderAddressedDelivery", () => {
  test("the direct envelope's attributes, the text as written, no reply line", () => {
    const mid = `${"0".repeat(32)}/7`;
    const content = renderAddressedDelivery({ mid, from: SID, text: 'a "quote"\n\nend' });
    expect(content).toBe(
      `<cross-session-message from="ccmsg:${SID}" from-name="ccmsg:${SID}" from-mode="prompting" ccmsg-mid="${mid}" ccmsg-from="${SID}">\na "quote"\n\nend\n</cross-session-message>`,
    );
    expect(parseDirectDeliveries(content)).toEqual([
      { mid, from: SID, fromLabel: `ccmsg:${SID}`, text: 'a "quote"\n\nend' },
    ]);
  });
});

describe("sessionAddresses", () => {
  test("the session, a run per process only when there are several, and the directory", () => {
    expect(sessionAddresses({ sid: SID, cwd: "/w", pids: [7] })).toEqual([
      `ccmsg:${SID}`,
      "ccmsg:path:/w",
    ]);
    expect(sessionAddresses({ sid: SID, cwd: "/w", pids: [30, 7, 30] })).toEqual([
      `ccmsg:${SID}`,
      `ccmsg:${SID}.7`,
      `ccmsg:${SID}.30`,
      "ccmsg:path:/w",
    ]);
    expect(sessionAddresses({ sid: SID, cwd: "", pids: [] })).toEqual([`ccmsg:${SID}`]);
  });
});
