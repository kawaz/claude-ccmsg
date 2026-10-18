// How a session is named in what ccmsg writes (DR-0039 §3): the session id,
// and the envelope that carries the sender as `ccmsg:<sid>`.
import { describe, expect, test } from "bun:test";
import { isSessionIdShape, parseDirectDeliveries, renderAddressedDelivery } from "../src/index.ts";

const SID = "aaaaaaaa-2222-4333-8444-555555555555";

describe("isSessionIdShape", () => {
  test("a lowercase UUID only", () => {
    expect(isSessionIdShape(SID)).toBe(true);
    for (const text of [SID.toUpperCase(), `ccmsg:${SID}`, `${SID}.1`, "user", "", "../x"]) {
      expect({ text, shape: isSessionIdShape(text) }).toEqual({ text, shape: false });
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
