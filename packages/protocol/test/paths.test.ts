import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../src/index.ts";

describe("resolvePaths (DR-0002 §1)", () => {
  // CCMSG_STATE_DIR / CCMSG_CONFIG_DIR / CCMSG_DATA_DIR are direct overrides that tests
  // rely on. The three are independent dirs so "the thing you must not lose is only data/"
  // and "the thing you may hand-edit is only config/" are structural.
  test("explicit overrides win and place files under the right roots", () => {
    const p = resolvePaths({
      CCMSG_STATE_DIR: "/s",
      CCMSG_CONFIG_DIR: "/c",
      CCMSG_DATA_DIR: "/d",
    } as NodeJS.ProcessEnv);
    expect(p.stateDir).toBe("/s");
    expect(p.configDir).toBe("/c");
    expect(p.dataDir).toBe("/d");
    expect(p.sock).toBe("/s/daemon.sock");
    expect(p.lock).toBe("/s/daemon.lock");
    expect(p.pid).toBe("/s/daemon.pid");
    expect(p.log).toBe("/s/daemon.log");
    expect(p.roomsDir).toBe("/d/rooms");
    // Hand-edited daemon configuration belongs in config/, beside the persisted
    // allowed-origins configuration — not under state/ or data/.
    expect(p.config).toBe("/c/config.json");
    expect(p.allowedOrigins).toBe("/c/allowed-origins.json");
    expect(p.dumps).toBe("/d/dumps");
  });

  // Without explicit overrides, XDG base dirs are honored, appending the ccmsg namespace.
  test("falls back to XDG base dirs", () => {
    const p = resolvePaths({
      XDG_STATE_HOME: "/xs",
      XDG_CONFIG_HOME: "/xc",
      XDG_DATA_HOME: "/xd",
    } as NodeJS.ProcessEnv);
    expect(p.stateDir).toBe("/xs/ccmsg");
    expect(p.configDir).toBe("/xc/ccmsg");
    expect(p.dataDir).toBe("/xd/ccmsg");
  });
});
