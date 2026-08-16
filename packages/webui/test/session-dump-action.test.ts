// What the Timeline's dump action puts on the wire (session-dump-action.ts).
// The daemon distinguishes an absent field from a false one — absent `since`
// means the whole session, absent `no_thinking`/`no_agent` mean "keep it" — so
// these tests pin field *presence*, not just values.
import { describe, expect, test } from "bun:test";
import { isScopedDump, sessionDumpRequest } from "../src/client/session-dump-action.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RECORD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
const off = { noThinking: false, noAgent: false };

describe("sessionDumpRequest", () => {
  test("no selection asks for the whole session", () => {
    const req = sessionDumpRequest({ sid: SID, position: "head", ...off });
    expect(req).toEqual({ sid: SID });
    // Not `since: undefined`: the field has to be absent, since the op reads
    // any present bound as a cut.
    expect("since" in req).toBe(false);
  });

  test("a selected record becomes the since bound", () => {
    expect(sessionDumpRequest({ sid: SID, position: RECORD, ...off })).toEqual({
      sid: SID,
      since: RECORD,
    });
  });

  test("unchecked trim boxes send nothing at all", () => {
    const req = sessionDumpRequest({ sid: SID, position: "head", ...off });
    expect("no_thinking" in req).toBe(false);
    expect("no_agent" in req).toBe(false);
  });

  test("checked trim boxes ride along with the bound", () => {
    expect(
      sessionDumpRequest({ sid: SID, position: RECORD, noThinking: true, noAgent: true }),
    ).toEqual({ sid: SID, since: RECORD, no_thinking: true, no_agent: true });
  });
});

describe("isScopedDump", () => {
  // The label the user reads before pressing follows this, so it must agree
  // with what sessionDumpRequest actually sends.
  test("is true exactly when a record is selected", () => {
    expect(isScopedDump("head")).toBe(false);
    expect(isScopedDump(RECORD)).toBe(true);
  });
});
