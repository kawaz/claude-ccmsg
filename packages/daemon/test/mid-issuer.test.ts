// The ids the daemon gives what it sends into a peer socket.
import { describe, expect, test } from "bun:test";
import { createMidIssuer } from "../src/mid-issuer.ts";

const MID_RE = /^[0-9a-f]{32}\/\d+$/;

describe("createMidIssuer", () => {
  test("counts from 1 under one instance id; each issuer draws its own id", () => {
    const issue = createMidIssuer();
    const first = issue();
    const second = issue();
    expect(first).toMatch(MID_RE);
    expect(first.endsWith("/1")).toBe(true);
    expect(second).toBe(`${first.slice(0, 32)}/2`);
    expect(createMidIssuer()().slice(0, 32)).not.toBe(first.slice(0, 32));
  });
});
