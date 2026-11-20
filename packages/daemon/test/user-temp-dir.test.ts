// The TMPDIR given to a process ccmsg starts for no particular session (the
// daemon the CLI spawns, the launch command the daemon runs; DR-0002 §2,
// DR-0018 §3.5): the OS's per-user temp dir, never the caller's.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { userTempDir, withTmpdir } from "../src/user-temp-dir.ts";

describe("userTempDir", () => {
  // macOS has a per-user temp dir and it is what getconf names, whatever
  // TMPDIR this process has (the test preload points TMPDIR elsewhere).
  test.if(process.platform === "darwin")(
    "on macOS it is the owner-only per-user dir getconf names, not the caller's TMPDIR",
    () => {
      const dir = userTempDir();
      const getconf = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]);
      expect(dir).toBe(getconf.stdout.toString().trim());
      expect(dir).not.toBe(process.env.TMPDIR);
      if (dir === undefined) throw new Error("no per-user temp dir on macOS");
      const st = fs.statSync(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.uid).toBe(process.geteuid?.() ?? -1);
      expect(st.mode & 0o077).toBe(0);
    },
  );

  test.if(process.platform !== "darwin")("elsewhere there is none", () => {
    expect(userTempDir()).toBeUndefined();
  });
});

describe("withTmpdir", () => {
  const session = "/repo/tmp.local/aaaaaaaa-0000-4000-8000-000000000001/";

  test("the caller's TMPDIR is replaced and the rest is kept", () => {
    expect(withTmpdir({ PATH: "/bin", TMPDIR: session, HOME: "/h" }, "/var/T/")).toEqual({
      PATH: "/bin",
      HOME: "/h",
      TMPDIR: "/var/T/",
    });
  });

  test("with no per-user dir the caller's TMPDIR is left out, not kept", () => {
    expect(withTmpdir({ PATH: "/bin", TMPDIR: session }, undefined)).toEqual({ PATH: "/bin" });
  });

  test("a caller without TMPDIR gets the per-user one", () => {
    expect(withTmpdir({ PATH: "/bin" }, "/var/T/")).toEqual({ PATH: "/bin", TMPDIR: "/var/T/" });
  });

  test("unset entries are dropped", () => {
    expect(withTmpdir({ PATH: "/bin", GONE: undefined }, undefined)).toEqual({ PATH: "/bin" });
  });
});
