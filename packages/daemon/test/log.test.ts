// daemon.log: one log call is one line, whatever text from outside it carries.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger, oneLine } from "../src/log.ts";

describe("oneLine", () => {
  test("line breaks and other control characters are written as escapes", () => {
    expect(oneLine("a\nFORGED\r\tb\u0000c d")).toBe("a\\nFORGED\\r\\tb\\u0000c\\u2028d");
  });

  test("text without control characters is left as it is", () => {
    expect(oneLine('role: Invalid type: "x" — ✓')).toBe('role: Invalid type: "x" — ✓');
  });
});

describe("Logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A request field quoted in a refusal (`role: "x\nFORGED"`) cannot stand
  // in daemon.log as a line of its own.
  test("a message with a line break is written as one line", () => {
    const file = path.join(dir, "daemon.log");
    const log = new Logger(file);
    log.warn(
      'hello from user refused: role: Invalid type: Expected "session" but received "x\nFORGED"',
    );
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('received "x\\nFORGED"');
  });
});
