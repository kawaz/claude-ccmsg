import { describe, expect, test } from "bun:test";
import { resolvePaths, resolveSidecarDir, sidecarSocketName } from "../src/index.ts";

describe("resolvePaths (DR-0002 §1)", () => {
  // CCMSG_STATE_DIR / CCMSG_CONFIG_DIR / CCMSG_DATA_DIR are direct overrides that tests
  // rely on. The three are independent dirs so "the thing you must not lose is only data/"
  // and "the thing you may hand-edit is only config/" are structural.
  test("explicit overrides win and place files under the right roots", () => {
    const p = resolvePaths({
      CCMSG_STATE_DIR: "/s",
      CCMSG_CONFIG_DIR: "/c",
      CCMSG_DATA_DIR: "/d",
    });
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
    expect(p.configJs).toBe("/c/config.js");
    expect(p.configTs).toBe("/c/config.ts");
    expect(p.allowedOrigins).toBe("/c/allowed-origins.json");
    expect(p.dumps).toBe("/d/dumps");
  });

  // Without explicit overrides, XDG base dirs are honored, appending the ccmsg namespace.
  test("falls back to XDG base dirs", () => {
    const p = resolvePaths({
      XDG_STATE_HOME: "/xs",
      XDG_CONFIG_HOME: "/xc",
      XDG_DATA_HOME: "/xd",
    });
    expect(p.stateDir).toBe("/xs/ccmsg");
    expect(p.configDir).toBe("/xc/ccmsg");
    expect(p.dataDir).toBe("/xd/ccmsg");
  });
});

describe("sidecar sockets (DR-0035 §3)", () => {
  const sid = "11111111-2222-4333-8444-555555555555";

  test("live under the state dir when the widest name fits sun_path", () => {
    expect(resolvePaths({ CCMSG_STATE_DIR: "/s" }).sidecars).toBe("/s/sidecars");
  });

  // The widest name carries the longest run id (16 characters): a state dir
  // that fits a shorter one but not that one still falls back.
  test("fall back to a short per-uid directory when it would not fit", () => {
    expect(resolveSidecarDir(`/${"x".repeat(35)}`)).toBe(
      `/tmp/claude-ccmsg-${String(process.getuid?.() ?? 0)}/sidecars`,
    );
    expect(resolveSidecarDir(`/${"x".repeat(34)}`)).toBe(`/${"x".repeat(34)}/sidecars`);
  });

  // Named after the session and the run, not the harness process: the
  // sidecar does not know its harness's pid, and needs no `ps` to name itself.
  test("are named <sid>.<run id>.sock", () => {
    expect(sidecarSocketName(sid, "mgq1k2x3abcd1234")).toBe(`${sid}.mgq1k2x3abcd1234.sock`);
  });

  test("refuse what is not a session id or a run id", () => {
    expect(() => sidecarSocketName("../etc", "abc")).toThrow(RangeError);
    expect(() => sidecarSocketName(sid, "")).toThrow(RangeError);
    expect(() => sidecarSocketName(sid, "../x")).toThrow(RangeError);
    expect(() => sidecarSocketName(sid, "4242.sock")).toThrow(RangeError);
  });
});
