// The e2e run's reading of the Mac's screen (packages/webui/e2e/screen.ts):
// which state the probe's output says, and which engines that leaves out.
import { describe, expect, test } from "bun:test";
import { readScreen, skippedLine, skipsEngine } from "../e2e/screen.ts";

/** The probe's output on a Mac with the screen on and not locked, as taken,
 * with the user's names, ids and the session's UUID replaced. */
const ON = `{"asleep":0,"session":{"kCGSSessionOnConsoleKey":true,"kCGSSessionLoginwindowSafeLogin":false,"kSCSecuritySessionID":100000,"kCGSessionLongUserNameKey":"Test User","kCGSSessionUserIDKey":501,"kCGSSessionSystemSafeBoot":false,"kCGSessionLoginDoneKey":true,"kCGSSessionUserNameKey":"test","kCGSSessionGroupIDKey":20,"kCGSSessionAuditIDKey":100000,"CGSSessionUniqueSessionUUID":"00000000-0000-4000-8000-000000000000"}}
`;

describe("readScreen", () => {
  test("the screen on and not locked is on", () => {
    expect(readScreen(ON)).toBe("on");
  });

  test("the main display asleep is off", () => {
    expect(readScreen(ON.replace('"asleep":0', '"asleep":1'))).toBe("off");
  });

  test("the session's screen locked is locked", () => {
    expect(
      readScreen(ON.replace('"session":{', '"session":{"CGSSessionScreenIsLocked":true,')),
    ).toBe("locked");
  });

  test("the session's lock key false is on", () => {
    expect(
      readScreen(ON.replace('"session":{', '"session":{"CGSSessionScreenIsLocked":false,')),
    ).toBe("on");
  });

  test("off wins over locked", () => {
    expect(
      readScreen(
        ON.replace('"asleep":0', '"asleep":1').replace(
          '"session":{',
          '"session":{"CGSSessionScreenIsLocked":true,',
        ),
      ),
    ).toBe("off");
  });

  test("output that cannot be read is unknown", () => {
    expect(readScreen("")).toBe("unknown");
    expect(readScreen("execution error: Error: ReferenceError (-2700)")).toBe("unknown");
    expect(readScreen('{"asleep":0}')).toBe("unknown");
    expect(readScreen('{"asleep":0,"session":null}')).toBe("unknown");
    expect(readScreen(ON.replace('"asleep":0', '"asleep":"0"'))).toBe("unknown");
  });
});

describe("skipsEngine", () => {
  test("off or locked leaves webkit out and runs chromium", () => {
    for (const screen of ["off", "locked"] as const) {
      expect(skipsEngine(screen, "webkit")).toBe(true);
      expect(skipsEngine(screen, "chromium")).toBe(false);
    }
  });

  test("on or unknown runs every engine", () => {
    for (const screen of ["on", "unknown"] as const) {
      expect(skipsEngine(screen, "webkit")).toBe(false);
      expect(skipsEngine(screen, "chromium")).toBe(false);
    }
  });
});

describe("skippedLine", () => {
  test("names why and how many describe blocks were left out", () => {
    expect(skippedLine("off", 21)).toBe(
      "画面が消えているので webkit の e2e の 21 組 (describe) を流していない",
    );
    expect(skippedLine("locked", 3)).toBe(
      "画面がロックされているので webkit の e2e の 3 組 (describe) を流していない",
    );
  });
});
