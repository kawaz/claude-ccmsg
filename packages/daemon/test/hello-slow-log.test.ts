// A session's hello that takes long is logged with what it spent the time on
// (server.ts slowHelloText): a hooks module hellos with every request it
// makes, so a slow hello holds the session up, and the line says whether it
// was one of the hello's reads or the time between them.
import { describe, expect, test } from "bun:test";
import { HELLO_SLOW_MS, slowHelloText } from "../src/server.ts";

const SID = "aaaaaaaa-2222-4333-8444-555555555555";
const READS = { transcript: 1290.4, cwd: 2.6, repoRoot: 0.2, location: 1.4 };

describe("slowHelloText", () => {
  test("a hello of HELLO_SLOW_MS or more: the whole and each read, in whole ms", () => {
    expect(slowHelloText(SID, 1342.2, READS)).toBe(
      `hello ${SID} took 1342 ms: transcript search 1290 ms, cwd 3 ms, repo root 0 ms, location 1 ms`,
    );
    expect(slowHelloText(SID, HELLO_SLOW_MS, READS)).toStartWith(
      `hello ${SID} took ${String(HELLO_SLOW_MS)} ms: `,
    );
  });

  test("a hello under HELLO_SLOW_MS says nothing", () => {
    expect(slowHelloText(SID, HELLO_SLOW_MS - 1, READS)).toBeUndefined();
  });
});
