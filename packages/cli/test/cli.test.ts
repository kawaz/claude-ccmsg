// End-to-end CLI: run the real `ccmsg` binary as a subprocess so ensure-daemon's
// spawn/connect path is exercised for real (DR-0002 §2).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@ccmsg/protocol";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface CliResult {
  out: string;
  err: string;
  code: number;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

function makeEnv(): { env: Record<string, string>; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  return {
    env: { CCMSG_STATE_DIR: stateDir, CCMSG_DATA_DIR: dataDir },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe("ccmsg CLI end-to-end", () => {
  test(
    "auto-spawns the daemon, does a round trip, and stops it",
    async () => {
      const { env, cleanup } = makeEnv();
      try {
        // status before anything: no daemon, and status must not spawn one
        const s0 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
        expect(s0.running).toBe(false);

        // first real command auto-spawns the daemon (ensure-daemon). Identity = session S1.
        const created = JSON.parse((await runCli(["--sid", "S1", "create-room"], env)).out) as {
          ok: boolean;
          room: string;
        };
        expect(created.ok).toBe(true);
        const room = created.room;

        // session identity was applied: the room's sole member is S1 (uid 1)
        const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
          rooms: { id: string; members: { uid: number; sid: string }[] }[];
        };
        expect(rooms.rooms.length).toBe(1);
        expect(rooms.rooms[0]!.members[0]).toMatchObject({ uid: 1, sid: "S1" });

        // post + read round trip
        const posted = JSON.parse((await runCli(["--sid", "S1", "post", room, "hello"], env)).out) as { mid: number };
        expect(posted.mid).toBe(1);
        const read = JSON.parse((await runCli(["read", room, "1"], env)).out) as { msgs: { msg: string }[] };
        expect(read.msgs[0]!.msg).toBe("hello");

        // status now reports the live daemon at our version
        const s1 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean; version: string };
        expect(s1.running).toBe(true);
        expect(s1.version).toBe(VERSION);

        // stop, then confirm it's gone
        const stopped = JSON.parse((await runCli(["daemon", "stop"], env)).out) as { stopped?: boolean };
        expect(stopped.stopped).toBe(true);
        const s2 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
        expect(s2.running).toBe(false);
      } finally {
        await runCli(["daemon", "stop"], env).catch(() => {});
        cleanup();
      }
    },
    30000,
  );

  test(
    "no args prints help; --as-user creates a room without a caller member row",
    async () => {
      const { env, cleanup } = makeEnv();
      try {
        // no args -> help to stdout (kawaz CLI convention)
        const help = await runCli([], env);
        expect(help.out).toContain("Usage:");
        expect(help.out).toContain("Environment Variables:");

        // --as-user: the User (uid 0) is implicit, so the created room's only member row is the listed peer Z
        const created = JSON.parse((await runCli(["--as-user", "create-room", "--members", "Z"], env)).out) as {
          ok: boolean;
          room: string;
        };
        expect(created.ok).toBe(true);
        const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
          rooms: { members: { uid: number; sid: string }[] }[];
        };
        expect(rooms.rooms[0]!.members.map((m) => m.sid)).toEqual(["Z"]);
        expect(rooms.rooms[0]!.members[0]!.uid).toBe(1);
      } finally {
        await runCli(["daemon", "stop"], env).catch(() => {});
        cleanup();
      }
    },
    30000,
  );
});
