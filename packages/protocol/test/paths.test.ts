import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../src/index.ts";

describe("resolvePaths (DR-0002 §1)", () => {
  // CCMSG_STATE_DIR / CCMSG_DATA_DIR are direct overrides that tests rely on. state and
  // data are independent dirs so "the thing you must not lose is only data/" is structural.
  test("explicit overrides win and place files under the right roots", () => {
    const p = resolvePaths({ CCMSG_STATE_DIR: "/s", CCMSG_DATA_DIR: "/d" } as NodeJS.ProcessEnv);
    expect(p.stateDir).toBe("/s");
    expect(p.dataDir).toBe("/d");
    expect(p.sock).toBe("/s/daemon.sock");
    expect(p.lock).toBe("/s/daemon.lock");
    expect(p.pid).toBe("/s/daemon.pid");
    expect(p.log).toBe("/s/daemon.log");
    expect(p.roomsDir).toBe("/d/rooms");
  });

  // Without explicit overrides, XDG base dirs are honored, appending the ccmsg namespace.
  test("falls back to XDG base dirs", () => {
    const p = resolvePaths({ XDG_STATE_HOME: "/xs", XDG_DATA_HOME: "/xd" } as NodeJS.ProcessEnv);
    expect(p.stateDir).toBe("/xs/ccmsg");
    expect(p.dataDir).toBe("/xd/ccmsg");
  });
});
