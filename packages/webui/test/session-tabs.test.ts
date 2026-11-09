// The session view's tab row: Terminal sits at the end, after Status, and
// appears only for a session that has one.
import { describe, expect, test } from "bun:test";
import { sessionTabItems } from "../src/client/components/SessionView.tsx";
import { withDom } from "./dom.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000005";

describe("sessionTabItems", () => {
  test("Files / Timeline / Status / Terminal", () => {
    expect(sessionTabItems(SID, true, true).map((tab) => tab.id)).toEqual([
      "files",
      "timeline",
      "status",
      "terminal",
    ]);
  });

  test("no Terminal tab for a session without one", () => {
    expect(sessionTabItems(SID, true, false).map((tab) => tab.id)).toEqual([
      "files",
      "timeline",
      "status",
    ]);
  });
});
